import { performance } from "node:perf_hooks";
import { MAX_OPERATION_TICKS } from "../lib/gen/pacing";
import {
  ARCHETYPE_STRATEGIES,
  balanceScenarios,
  defaultBalanceJobs,
  isArchetypeStrategy,
  runBalanceScenarios,
  runBalanceSweepScenarios,
  stratifiedBalanceScenarios,
  stableBalanceRecords,
  BalanceTimeBudgetExceeded,
  type BalanceRunOptions,
} from "../lib/sim/balanceRunner";
import { archetypeFailureRecords, balanceFailureReason, checkArchetypeBalance, checkBalance, DEFAULT_BALANCE_THRESHOLDS, summarizeBalance, type BalanceRecord, type BalanceThresholds } from "../lib/sim/balance";
import type { BalanceStrategy } from "../lib/types";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const from = Number(arg("from", "0"));
const to = Number(arg("to", "99"));
const missionArg = arg("mission", "all");
const maxTicks = Number(arg("ticks", String(MAX_OPERATION_TICKS)));
const strategyArg = arg("strategy", "competent");
const details = arg("details", "false") === "true";
const shouldCheck = arg("check", "false") === "true";
const stratified = arg("stratified", "false") === "true";
const progressEnabled = arg("progress", "true") !== "false";
const progressEvery = Math.max(1, Number(arg("progress-every", "1")) || 1);
const requestedJobs = Math.max(0, Number(arg("jobs", "0")) || 0);
const maxElapsedMs = Math.max(0, Number(arg("max-elapsed-ms", "0")) || 0);
const missions = missionArg === "all" ? [...Array(8).keys()] : [Number(missionArg)];

const supportedStrategies: readonly string[] = ["competent", "baseline", ...ARCHETYPE_STRATEGIES];
if (strategyArg !== "archetypes" && !supportedStrategies.includes(strategyArg)) {
  throw new Error(`Unknown strategy ${strategyArg}; use competent, baseline, ${ARCHETYPE_STRATEGIES.join(", ")}, or archetypes`);
}

async function main() {
  const archetypeSweep = strategyArg === "archetypes";
  const strategies: BalanceStrategy[] = archetypeSweep
    ? [...ARCHETYPE_STRATEGIES]
    : [strategyArg as BalanceStrategy];
  const baseOptions: Omit<BalanceRunOptions, "strategy"> = { from, to, missions, maxTicks };
  const scenarioList = archetypeSweep || stratified ? stratifiedBalanceScenarios(from, to, 8) : undefined;
  const scenarioCount = scenarioList?.length ?? balanceScenarios({ ...baseOptions, strategy: strategies[0] }).length;
  const jobs = requestedJobs > 0 ? requestedJobs : defaultBalanceJobs(scenarioCount);
  const startedAt = performance.now();
  const deadlineAt = maxElapsedMs > 0 ? startedAt + maxElapsedMs : undefined;
  const records = [] as Awaited<ReturnType<typeof runBalanceScenarios>>;
  if (archetypeSweep) {
    const sweepRecords = await runBalanceSweepScenarios({
      ...baseOptions,
      strategies,
      jobs,
      scenarioList,
      deadlineAt,
      onProgress: progressEnabled ? ({ completed, total, record }) => {
        if (completed % progressEvery !== 0 && completed !== total) return;
        console.error(`[balance:${record.strategy}] ${completed}/${total} ${record.seed} mission ${record.mission} → ${record.result}`);
      } : undefined,
    });
    records.push(...sweepRecords);
  } else {
    const strategy = strategies[0]!;
    const strategyRecords = await runBalanceScenarios({
      ...baseOptions,
      strategy,
      jobs,
      scenarioList,
      deadlineAt,
      onProgress: progressEnabled ? ({ completed, total, record }) => {
        if (completed % progressEvery !== 0 && completed !== total) return;
        console.error(`[balance:${strategy}] ${completed}/${total} ${record.seed} mission ${record.mission} → ${record.result}`);
      } : undefined,
    });
    records.push(...strategyRecords);
  }
  const elapsedMs = performance.now() - startedAt;
  const elapsedBudgetExceeded = maxElapsedMs > 0 && elapsedMs >= maxElapsedMs;
  const summary = summarizeBalance(records);
  const thresholds: BalanceThresholds = {
  ...DEFAULT_BALANCE_THRESHOLDS,
  minWinRate: Number(arg("min-win-rate", String(DEFAULT_BALANCE_THRESHOLDS.minWinRate))),
  maxWinRate: Number(arg("max-win-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxWinRate))),
  maxTimeoutRate: Number(arg("max-timeout-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxTimeoutRate))),
  minKindSamples: Number(arg("min-kind-samples", String(DEFAULT_BALANCE_THRESHOLDS.minKindSamples))),
  minKindWinRate: Number(arg("min-kind-win-rate", String(DEFAULT_BALANCE_THRESHOLDS.minKindWinRate))),
  maxKindTimeoutRate: Number(arg("max-kind-timeout-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxKindTimeoutRate))),
  maxTruncatedRate: Number(arg("max-truncated-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxTruncatedRate))),
  maxMapFailureRate: Number(arg("max-map-failure-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxMapFailureRate))),
  maxPowerDeficitRate: Number(arg("max-power-deficit-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxPowerDeficitRate))),
  maxCommandRejectionRate: Number(arg("max-command-rejection-rate", String(DEFAULT_BALANCE_THRESHOLDS.maxCommandRejectionRate))),
  maxAverageCasualties: Number(arg("max-average-casualties", String(DEFAULT_BALANCE_THRESHOLDS.maxAverageCasualties))),
  };
  const acceptance = shouldCheck
    ? archetypeSweep
      ? checkArchetypeBalance(summary, records)
      : isArchetypeStrategy(strategyArg as BalanceStrategy)
        ? checkArchetypeBalance(summary, records, [strategyArg as BalanceStrategy])
        : checkBalance(summary, thresholds)
    : undefined;
  const failureSet = new Set<BalanceRecord>(records.filter((record) => record.result !== "won"
    || record.truncated
    || !record.mapValid
    || record.commandRejections > 0
    || record.powerDeficit
    || record.nonFiniteState === true));
  if (archetypeSweep || isArchetypeStrategy(strategyArg as BalanceStrategy)) {
    const strategiesToReport = archetypeSweep ? undefined : [strategyArg as BalanceStrategy];
    for (const record of archetypeFailureRecords(summary, records, strategiesToReport)) failureSet.add(record);
  }
  const failedScenarios = records
    .filter((record) => failureSet.has(record))
    .map((record) => ({
      seed: record.seed,
      mission: record.mission,
      kind: record.kind,
      strategy: record.strategy,
      result: record.result,
      lossReason: record.lossReason ?? null,
      failureReason: record.failureReason ?? balanceFailureReason(record) ?? null,
      timing: {
        ticks: record.duration,
        scenarioMs: Number(record.scenarioMs.toFixed(2)),
      },
      diagnostics: {
        firstCombatTick: record.firstCombatTick ?? null,
        firstPressureTick: record.firstPressureTick ?? null,
        primaryCompletedTick: record.primaryCompletedTick ?? null,
        repairCommands: record.repairCommands ?? 0,
        openingCredits: record.openingCredits ?? null,
        baselineRouteLength: record.baselineRouteLength ?? null,
        alternateRouteLength: record.alternateRouteLength ?? null,
        reachableResourceValue: record.reachableResourceValue ?? null,
        nearestResourceDistance: record.nearestResourceDistance ?? null,
        laneCount: record.laneCount ?? null,
        targetDepth: record.targetDepth ?? null,
        targetRouteLength: record.targetRouteLength ?? null,
        targetReachable: record.targetReachable ?? null,
      },
    }));

  const scenarioTimes = records.map((record) => record.scenarioMs);
  const slowestIndex = scenarioTimes.reduce((best, value, index) => value > (scenarioTimes[best] ?? -1) ? index : best, 0);
  const slowest = records[slowestIndex];
  console.log(JSON.stringify({
  strategy: strategyArg,
  strategies,
  jobs,
  range: { from, to },
  missions: [...new Set(missions)].filter((mission) => Number.isInteger(mission) && mission >= 0 && mission < 8).sort((a, b) => a - b),
  ticks: maxTicks,
  samples: records.length,
  timing: {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    maxElapsedMs: maxElapsedMs || null,
    elapsedBudgetExceeded,
    averageScenarioMs: records.length ? Number((scenarioTimes.reduce((sum, ms) => sum + ms, 0) / records.length).toFixed(2)) : 0,
    slowestScenarioMs: slowest ? Number(slowest.scenarioMs.toFixed(2)) : 0,
    slowestScenario: slowest ? { seed: slowest.seed, mission: slowest.mission, kind: slowest.kind } : null,
  },
  winRate: summary.winRate,
  wins: summary.wins,
  losses: summary.losses,
  timeouts: summary.timeouts,
  truncatedRate: summary.truncatedRate,
  mapFailures: Math.round(summary.mapFailureRate * summary.samples),
  commandRejectionRate: summary.commandRejectionRate,
  powerDeficitRate: summary.powerDeficitRate,
  averages: {
    duration: summary.averageDuration,
    credits: summary.averageCredits,
    casualties: summary.averageCasualties,
    unitsProduced: summary.averageUnitsProduced,
    commands: summary.averageCommands,
    commandRejections: summary.averageCommandRejections,
  },
  byMissionKind: summary.byMissionKind,
  byMission: summary.byMission,
  byStrategy: summary.byStrategy,
  failures: failedScenarios,
  ...(acceptance ? { acceptance: { ...acceptance, thresholds } } : {}),
  ...(details ? { records: stableBalanceRecords(records) } : {}),
  }, null, 2));

  if ((acceptance && !acceptance.passed) || elapsedBudgetExceeded) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  if (error instanceof BalanceTimeBudgetExceeded) {
    console.error(`Balance sweep exceeded --max-elapsed-ms ${maxElapsedMs}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
