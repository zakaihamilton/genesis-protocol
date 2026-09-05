import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { createCampaign } from "../gen/campaign";
import { generateMap, type GeneratedMap } from "../gen/map";
import { MAX_MISSION_TICKS, MAX_OPERATION_TICKS } from "../gen/pacing";
import { formatSeed } from "../seed/rng";
import { createMissionFromData, tick } from "./api";
import { CompetentCommander } from "./commander";
import { ArchetypeCommander, isArchetypeStrategy } from "./commander/archetypes";
import { powerBreakdown } from "./world";
import { TILE_BLOCKED, TILE_WATER, type BalanceStrategy, type Campaign, type Command, type MissionDef, type SimState, type UnitKind } from "../types";
import { missionFamilyFor, resolveMissionProfile } from "../gen/profile";
import { scenarioAffordances, type ScenarioAffordances } from "./scenarios";
import { balanceFailureReason, type BalanceRecord } from "./balance";

export { ARCHETYPE_STRATEGIES, isArchetypeStrategy } from "./commander/archetypes";

export type BalanceRecordWithScenario = BalanceRecord & {
  seed: string;
  mission: number;
  scenarioMs: number;
};

export type BalanceScenario = { seed: number; mission: number };

export type PlaytestManifestEntry = BalanceScenario & {
  seedLabel: string;
  kind: string;
  family: string;
  variant: string;
  name: string;
};

export type BalanceRunOptions = {
  from: number;
  to: number;
  missions: number[];
  maxTicks?: number;
  strategy?: BalanceStrategy;
  /** Monotonic deadline shared by the parent and all simulation workers. */
  deadlineAt?: number;
};

export type BalanceProgress = {
  completed: number;
  total: number;
  record: BalanceRecordWithScenario;
};

export type BalanceRunJob = BalanceRunOptions & {
  scenarios: BalanceScenario[];
};

export type BalanceSweepJob = Omit<BalanceRunOptions, "strategy"> & {
  strategies: readonly BalanceStrategy[];
  scenarios: BalanceScenario[];
};

export class BalanceTimeBudgetExceeded extends Error {
  constructor() {
    super("Balance sweep exceeded its elapsed-time budget");
    this.name = "BalanceTimeBudgetExceeded";
  }
}

function assertWithinDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    throw new BalanceTimeBudgetExceeded();
  }
}

export function defaultBalanceJobs(scenarioCount: number): number {
  const available = Math.max(1, cpus().length || 1);
  return Math.max(1, Math.min(available, 8, scenarioCount || 1));
}

export function balanceScenarios(options: BalanceRunOptions): Array<{ seed: number; mission: number }> {
  const missions = [...new Set(options.missions)]
    .filter((mission) => Number.isInteger(mission) && mission >= 0 && mission < 8)
    .sort((a, b) => a - b);
  const from = Math.max(0, Math.min(9999, Math.floor(options.from)));
  const to = Math.max(0, Math.min(9999, Math.floor(options.to)));
  const scenarios: Array<{ seed: number; mission: number }> = [];
  if (to < from) return scenarios;
  for (let seed = from; seed <= to; seed++) {
    for (const mission of missions) scenarios.push({ seed, mission });
  }
  return scenarios;
}

/** Selects a stable minimum sample for every generated mission kind. */
export function stratifiedBalanceScenarios(
  from = 0,
  to = 39,
  minSamplesPerKind = 8,
): BalanceScenario[] {
  const counts = new Map<string, number>();
  const scenarios: BalanceScenario[] = [];
  const start = Math.max(0, Math.min(9999, Math.floor(from)));
  const end = Math.max(0, Math.min(9999, Math.floor(to)));
  for (let seed = start; seed <= end; seed++) {
    const campaign = createCampaign(seed);
    for (const mission of campaign.missions) {
      const count = counts.get(mission.win.kind) ?? 0;
      if (count >= minSamplesPerKind) continue;
      scenarios.push({ seed, mission: mission.index });
      counts.set(mission.win.kind, count + 1);
    }
  }
  const missing = [
    "harvestQuota", "forceQuota", "structureQuota", "destroyMarked", "razeAll", "decapitate",
    "annihilate", "holdTheLine", "escort", "sabotage", "rescue", "extraction",
  ].filter((kind) => (counts.get(kind) ?? 0) < minSamplesPerKind);
  if (missing.length) throw new Error(`Unable to collect stratified balance samples for: ${missing.join(", ")}`);
  return scenarios.sort((a, b) => a.seed - b.seed || a.mission - b.mission);
}

/** Selects the first stable pair of missions for each profile variant. */
export function representativePlaytestManifest(
  from = 0,
  to = 39,
  perVariant = 2,
): PlaytestManifestEntry[] {
  const counts = new Map<string, number>();
  const entries: PlaytestManifestEntry[] = [];
  const start = Math.max(0, Math.min(9999, Math.floor(from)));
  const end = Math.max(0, Math.min(9999, Math.floor(to)));
  for (let seed = start; seed <= end; seed++) {
    const campaign = createCampaign(seed);
    for (const mission of campaign.missions) {
      const profile = resolveMissionProfile(seed, mission.index, mission.win.kind, mission.profile);
      const count = counts.get(profile.variant) ?? 0;
      if (count >= perVariant) continue;
      entries.push({
        seed,
        seedLabel: formatSeed(seed),
        mission: mission.index,
        kind: mission.win.kind,
        family: profile.family,
        variant: profile.variant,
        name: mission.name,
      });
      counts.set(profile.variant, count + 1);
    }
  }
  const variants = [
    "resourceRace", "forwardIndustry", "surgicalStrike", "siege",
    "concentratedWaves", "crossfire", "directRoute", "contestedRoute",
  ];
  const missing = variants.filter((variant) => (counts.get(variant) ?? 0) < perVariant);
  if (missing.length) throw new Error(`Unable to collect playtest scenarios for: ${missing.join(", ")}`);
  return entries.sort((a, b) => a.seed - b.seed || a.mission - b.mission);
}

function validMap(map: GeneratedMap): boolean {
  const start = (point: { x: number; y: number }) => {
    const tile = map.tiles[point.y * map.width + point.x];
    return tile !== TILE_BLOCKED && tile !== TILE_WATER;
  };
  return start(map.playerStart) && start(map.enemyStart) &&
    map.markedSpots.every((point) => start(point)) &&
    map.resourceAmount.reduce((sum, amount) => sum + amount, 0) >= 4000 &&
    map.affordances.laneCount >= 2 &&
    map.affordances.baselineRouteLength > 0 &&
    map.affordances.alternateRouteLength <= map.affordances.baselineRouteLength * 1.8 &&
    map.affordances.reachableResourceValue >= 4000 &&
    Number.isFinite(map.affordances.nearestResourceDistance);
}

function baselineCommands(state: SimState, map: GeneratedMap): Command[] | undefined {
  if (state.tick % 60 !== 0) return undefined;
  const units = state.entities.filter((entity) => entity.owner === 0 && entity.class === "unit" && entity.hp > 0 && !entity.neutral);
  const combat = units.filter((entity) => entity.kind !== "harvester").map((entity) => entity.id);
  const harvesters = units.filter((entity) => entity.kind === "harvester").map((entity) => entity.id);
  const commands: Command[] = [];
  if (combat.length) commands.push({ type: "attackMove", unitIds: combat, x: map.enemyStart.x, y: map.enemyStart.y });
  if (harvesters.length) commands.push({ type: "harvest", unitIds: harvesters, x: map.playerStart.x + 4, y: map.playerStart.y + 4 });
  return commands;
}

function runScenario(
  state: SimState,
  map: GeneratedMap,
  strategy: BalanceStrategy,
  maxTicks: number,
  deadlineAt?: number,
) {
  let powerDeficit = false;
  let commandsIssued = 0;
  let commandRejections = 0;
  let firstCombatTick: number | undefined;
  let firstPressureTick: number | undefined;
  let primaryCompletedTick: number | undefined;
  let repairCommands = 0;
  let openingCredits: number | undefined;
  let openingUnitsProducedByRole: Partial<Record<UnitKind, number>> | undefined;
  const commander = strategy === "competent"
    ? new CompetentCommander()
    : isArchetypeStrategy(strategy)
      ? new ArchetypeCommander(strategy)
      : undefined;
  const missionHorizon = state.runtime?.deadline ?? state.win.ticks ?? MAX_MISSION_TICKS;
  const tickLimit = Math.min(maxTicks, missionHorizon);
  const openingCutoff = Math.max(1, Math.floor(missionHorizon * 0.25));
  for (let i = 0; i < tickLimit && state.result === "playing"; i++) {
    assertWithinDeadline(deadlineAt);
    const commands = commander?.plan(state) ?? baselineCommands(state, map);
    for (const command of commands ?? []) {
      if ((command.type === "attack" || command.type === "attackMove") && firstCombatTick === undefined) firstCombatTick = state.tick;
      if (command.type === "repair") repairCommands += 1;
    }
    commandsIssued += commands?.length ?? 0;
    const result = tick(state, commands, { collectEvents: false, updateFog: false });
    commandRejections += result.commandRejections;
    if (firstPressureTick === undefined && state.runtime?.director?.phase !== undefined && state.runtime.director.phase !== "opening") {
      firstPressureTick = state.tick;
    }
    if (primaryCompletedTick === undefined && result.state.result === "won") primaryCompletedTick = state.tick;
    if (openingCredits === undefined && state.tick >= openingCutoff) {
      openingCredits = state.credits[0];
      openingUnitsProducedByRole = { ...state.unitsProducedByRole };
    }
    if (state.result === "playing") powerDeficit ||= powerBreakdown(state, 0).surplus < 0;
  }
  return {
    powerDeficit,
    commandsIssued,
    commandRejections,
    truncated: state.result === "playing" && tickLimit < missionHorizon,
    firstCombatTick,
    firstPressureTick,
    primaryCompletedTick,
    repairCommands,
    openingCredits,
    openingUnitsProducedByRole,
  };
}

function hasNonFiniteValue(value: unknown, seen: Set<object>): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => hasNonFiniteValue(child, seen));
}

export function hasNonFiniteState(state: SimState): boolean {
  return hasNonFiniteValue(state, new Set());
}

function runOne(
  seed: number,
  missionIndex: number,
  strategy: BalanceStrategy,
  maxTicks: number,
  campaign: Campaign,
  map: GeneratedMap,
  sharedScenario?: SharedScenarioData,
  deadlineAt?: number,
): BalanceRecordWithScenario {
  const scenarioStartedAt = performance.now();
  const definition: MissionDef | undefined = campaign.missions[missionIndex];
  if (!definition) throw new Error(`No mission ${missionIndex}`);
  const state = createMissionFromData({
    seed,
    missionIndex,
    campaign,
    mission: definition,
    map,
  });
  const scenario = sharedScenario?.affordances ?? scenarioAffordances(state);
  if (sharedScenario && !sharedScenario.affordances) sharedScenario.affordances = scenario;
  // Validate the generated map before simulation mutates shared tile and
  // resource arrays. Otherwise a long-running archetype can make a healthy
  // map appear invalid merely by harvesting or constructing on it.
  const mapIsValid = (sharedScenario?.mapValid ?? validMap(map)) && scenario.targetReachable;
  const run = runScenario(state, map, strategy, maxTicks, deadlineAt);
  const scenarioMs = performance.now() - scenarioStartedAt;
  return {
    seed: formatSeed(seed),
    mission: missionIndex,
    strategy,
    family: missionFamilyFor(definition.win.kind),
    kind: definition.win.kind,
    result: state.result,
    truncated: run.truncated,
    duration: state.tick,
    credits: state.credits[0],
    unitsProduced: state.unitsProduced[0],
    aiUnitsProduced: state.unitsProduced[1],
    powerDeficit: run.powerDeficit,
    casualties: state.losses.units[0],
    secondaryCompleted: state.result === "won" ? state.runtime?.secondary.filter((objective) => objective.completed).length ?? 0 : 0,
    mapValid: mapIsValid,
    commandsIssued: run.commandsIssued,
    commandRejections: run.commandRejections,
    nonFiniteState: hasNonFiniteState(state),
    lossReason: state.lossReason,
    failureReason: balanceFailureReason({
      result: state.result,
      truncated: run.truncated,
      lossReason: state.lossReason,
    }),
    firstCombatTick: run.firstCombatTick,
    firstPressureTick: run.firstPressureTick,
    primaryCompletedTick: run.primaryCompletedTick,
    repairCommands: run.repairCommands,
    openingCredits: run.openingCredits,
    openingUnitsProducedByRole: run.openingUnitsProducedByRole,
    baselineRouteLength: map.affordances.baselineRouteLength,
    alternateRouteLength: map.affordances.alternateRouteLength,
    reachableResourceValue: map.affordances.reachableResourceValue,
    nearestResourceDistance: map.affordances.nearestResourceDistance,
    laneCount: map.affordances.laneCount,
    targetDepth: scenario.targetDepth,
    targetRouteLength: scenario.routeLength,
    targetReachable: scenario.targetReachable,
    scenarioMs,
  };
}

type SharedScenarioData = {
  mapValid: boolean;
  affordances?: ScenarioAffordances;
};

function cloneMapForSimulation(map: GeneratedMap): GeneratedMap {
  // Simulation mutates resource depletion tiles and amounts. Keep the
  // generated map's immutable geometry and affordances shared while giving
  // each strategy an isolated mutable view.
  return {
    ...map,
    tiles: [...map.tiles],
    resourceAmount: [...map.resourceAmount],
  };
}

export function runBalanceJob(job: BalanceRunJob, onRecord?: (record: BalanceRecordWithScenario) => void): BalanceRecordWithScenario[] {
  const strategy = job.strategy ?? "competent";
  const maxTicks = job.maxTicks ?? MAX_OPERATION_TICKS;
  const campaigns = new Map<number, Campaign>();
  const maps = new Map<string, GeneratedMap>();
  const records: BalanceRecordWithScenario[] = [];
  for (const { seed, mission } of job.scenarios) {
    assertWithinDeadline(job.deadlineAt);
    const campaign = campaigns.get(seed) ?? createCampaign(seed);
    campaigns.set(seed, campaign);
    const definition = campaign.missions[mission];
    if (!definition) throw new Error(`No mission ${mission}`);
    const mapKey = `${seed}:${mission}`;
    const map = maps.get(mapKey) ?? generateMap(seed, definition);
    maps.set(mapKey, map);
    const record = runOne(seed, mission, strategy, maxTicks, campaign, map, undefined, job.deadlineAt);
    records.push(record);
    onRecord?.(record);
  }
  return records;
}

export function runBalanceSweepJob(
  job: BalanceSweepJob,
  onRecord?: (record: BalanceRecordWithScenario) => void,
): BalanceRecordWithScenario[] {
  const maxTicks = job.maxTicks ?? MAX_OPERATION_TICKS;
  const campaigns = new Map<number, Campaign>();
  const maps = new Map<string, GeneratedMap>();
  const records: BalanceRecordWithScenario[] = [];
  for (const { seed, mission } of job.scenarios) {
    assertWithinDeadline(job.deadlineAt);
    const campaign = campaigns.get(seed) ?? createCampaign(seed);
    campaigns.set(seed, campaign);
    const definition = campaign.missions[mission];
    if (!definition) throw new Error(`No mission ${mission}`);
    const mapKey = `${seed}:${mission}`;
    const map = maps.get(mapKey) ?? generateMap(seed, definition);
    maps.set(mapKey, map);
    const sharedScenario: SharedScenarioData = { mapValid: validMap(map) };
    for (const strategy of job.strategies) {
      const record = runOne(
        seed,
        mission,
        strategy,
        maxTicks,
        campaign,
        cloneMapForSimulation(map),
        sharedScenario,
        job.deadlineAt,
      );
      records.push(record);
      onRecord?.(record);
    }
  }
  return records;
}

export function sortBalanceRecords(records: BalanceRecordWithScenario[]): BalanceRecordWithScenario[] {
  return [...records].sort((a, b) => Number(a.seed) - Number(b.seed)
    || a.mission - b.mission
    || (a.strategy ?? "competent").localeCompare(b.strategy ?? "competent"));
}

function runWorker(
  job: BalanceRunJob,
  onRecord?: (record: BalanceRecordWithScenario) => void,
): Promise<BalanceRecordWithScenario[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../scripts/balanceWorker.cjs", import.meta.url), {
      workerData: {
        from: job.from,
        to: job.to,
        missions: job.missions,
        maxTicks: job.maxTicks,
        deadlineAt: job.deadlineAt,
        strategy: job.strategy,
        scenarios: job.scenarios,
      },
    });
    worker.on("message", (message: { type: "progress" | "complete"; record?: BalanceRecordWithScenario; records?: BalanceRecordWithScenario[] }) => {
      if (message.type === "progress" && message.record) onRecord?.(message.record);
      if (message.type === "complete" && message.records) resolve(message.records);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`Balance worker exited with code ${code}`));
    });
  });
}

type BalanceSweepWorkerMessage =
  | { type: "progress"; record: BalanceRecordWithScenario }
  | { type: "complete"; records: BalanceRecordWithScenario[] }
  | { type: "error"; message: string };

function groupScenariosBySeed(scenarios: BalanceScenario[]): BalanceScenario[][] {
  const groupedBySeed = new Map<number, BalanceScenario[]>();
  for (const scenario of scenarios) {
    const group = groupedBySeed.get(scenario.seed) ?? [];
    group.push(scenario);
    groupedBySeed.set(scenario.seed, group);
  }
  return [...groupedBySeed.values()];
}

function runSweepWorkerPool(
  options: Omit<BalanceSweepJob, "scenarios">,
  seedGroups: BalanceScenario[][],
  workerCount: number,
  onRecord: (record: BalanceRecordWithScenario) => void,
): Promise<BalanceRecordWithScenario[]> {
  return new Promise((resolve, reject) => {
    const workers: Array<{ worker: Worker; closing: boolean }> = [];
    const records: BalanceRecordWithScenario[] = [];
    let nextGroup = 0;
    let closedWorkers = 0;
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      for (const entry of workers) void entry.worker.terminate();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const dispatch = (entry: { worker: Worker; closing: boolean }) => {
      const scenarios = seedGroups[nextGroup++];
      if (!scenarios) {
        entry.closing = true;
        entry.worker.postMessage({ type: "close" });
        return;
      }
      entry.worker.postMessage({ type: "run", scenarios });
    };

    for (let index = 0; index < workerCount; index++) {
      const entry = {
        worker: new Worker(new URL("../../scripts/balanceSweepWorker.cjs", import.meta.url), {
          workerData: {
            from: options.from,
            to: options.to,
            missions: options.missions,
            maxTicks: options.maxTicks,
            deadlineAt: options.deadlineAt,
            strategies: options.strategies,
          },
        }),
        closing: false,
      };
      workers.push(entry);
      entry.worker.on("message", (message: BalanceSweepWorkerMessage) => {
        if (settled) return;
        if (message.type === "progress") {
          onRecord(message.record);
          return;
        }
        if (message.type === "error") {
          fail(new Error(message.message));
          return;
        }
        records.push(...message.records);
        dispatch(entry);
      });
      entry.worker.once("error", fail);
      entry.worker.once("exit", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(`Balance sweep worker exited with code ${code}`));
          return;
        }
        if (entry.closing) {
          closedWorkers += 1;
          if (closedWorkers === workers.length) {
            settled = true;
            resolve(records);
          }
        }
      });
      dispatch(entry);
    }
  });
}

export async function runBalanceSweepScenarios(
  options: Omit<BalanceSweepJob, "scenarios"> & {
    jobs?: number;
    onProgress?: (progress: BalanceProgress) => void;
    scenarioList?: BalanceScenario[];
  },
): Promise<BalanceRecordWithScenario[]> {
  const scenarios = options.scenarioList ?? balanceScenarios(options);
  const seedGroups = groupScenariosBySeed(scenarios);
  const requestedJobs = options.jobs ?? defaultBalanceJobs(scenarios.length);
  const jobs = Math.max(1, Math.min(Math.floor(requestedJobs) || 1, seedGroups.length || 1));
  let completed = 0;
  const report = (record: BalanceRecordWithScenario) => {
    assertWithinDeadline(options.deadlineAt);
    completed += 1;
    options.onProgress?.({ completed, total: scenarios.length * options.strategies.length, record });
  };
  const jobOptions = {
    from: options.from,
    to: options.to,
    missions: options.missions,
    maxTicks: options.maxTicks,
    deadlineAt: options.deadlineAt,
    strategies: options.strategies,
  };
  if (jobs === 1 || seedGroups.length < 2) {
    return sortBalanceRecords(runBalanceSweepJob({ ...jobOptions, scenarios }, report));
  }
  const records = await runSweepWorkerPool(jobOptions, seedGroups, jobs, report);
  return sortBalanceRecords(records);
}

export async function runBalanceScenarios(
  options: BalanceRunOptions & {
    jobs?: number;
    onProgress?: (progress: BalanceProgress) => void;
    scenarioList?: BalanceScenario[];
  },
): Promise<BalanceRecordWithScenario[]> {
  const scenarios = options.scenarioList ?? balanceScenarios(options);
  const requestedJobs = options.jobs ?? defaultBalanceJobs(scenarios.length);
  const jobs = Math.max(1, Math.min(Math.floor(requestedJobs) || 1, scenarios.length || 1));
  let completed = 0;
  const report = (record: BalanceRecordWithScenario) => {
    completed += 1;
    options.onProgress?.({ completed, total: scenarios.length, record });
  };
  const jobOptions = {
    from: options.from,
    to: options.to,
    missions: options.missions,
    maxTicks: options.maxTicks,
    deadlineAt: options.deadlineAt,
    strategy: options.strategy,
  };
  if (jobs === 1 || scenarios.length < 2) return sortBalanceRecords(runBalanceJob({ ...jobOptions, scenarios }, report));

  const assignments = Array.from({ length: jobs }, () => [] as Array<{ seed: number; mission: number }>);
  const seedGroups = groupScenariosBySeed(scenarios);
  seedGroups.forEach((group, index) => assignments[index % jobs]!.push(...group));
  const results = await Promise.all(assignments.filter((assignment) => assignment.length).map((assignment) =>
    runWorker({ ...jobOptions, scenarios: assignment }, report),
  ));
  return sortBalanceRecords(results.flat());
}

/** Remove machine timing so gameplay records can be compared byte-for-byte. */
export function stableBalanceRecords(records: BalanceRecordWithScenario[]): BalanceRecord[] {
  return sortBalanceRecords(records).map(({ scenarioMs: _scenarioMs, ...record }) => {
    void _scenarioMs;
    return record;
  });
}
