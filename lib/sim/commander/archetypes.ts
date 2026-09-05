import {
  BUILDING_STATS,
  UNIT_STATS,
  isUnitAvailable,
  producerFor,
  productionQueueSize,
} from "../../catalog";
import type { BalanceStrategy, BuildingKind, Command, Entity, SimState, UnitKind } from "../../types";
import { canRepair } from "../repair";
import { canPlaceBuilding, distToEntity, findBuildSite, powerBreakdown, powerFor } from "../world";
import { defensiveThreat, objectiveEntity } from "./combat";
import {
  OFFENSIVE_KINDS,
  YARD_THREAT_RADIUS,
  combatUnits,
  enemyEntitiesView,
  playerBuildingsView,
  queuedUnitCount,
  readyProducers,
  totalUnitCount,
} from "./queries";

export type ArchetypeStrategy = Exclude<BalanceStrategy, "competent" | "baseline">;

export const ARCHETYPE_STRATEGIES: readonly ArchetypeStrategy[] = ["rush", "turtle", "greed", "infantry", "vehicles"];

const ARCHETYPE_CADENCE = 24;
const MAX_ARCHETYPE_QUEUE = 3;
// A turtle is a deliberately conservative diagnostic, not an unbounded
// unit-factory benchmark. Keeping its standing force small also prevents a
// defensive run from spending most of its wall time resolving hundreds of
// low-value late-game entities after the outcome is already decided.
const MAX_TURTLE_COMBAT_UNITS = 24;

function buildCommand(state: SimState, kind: BuildingKind, yard: Entity, reserve = 120): Command | undefined {
  if (state.credits[0] < BUILDING_STATS[kind].cost + reserve) return undefined;
  const site = findBuildSite(state, kind, yard.x + 3, yard.y, 14, 0);
  if (!site || !canPlaceBuilding(state, kind, site.x, site.y, 0)) return undefined;
  return { type: "build", building: kind, x: site.x, y: site.y };
}

function hasBuilding(state: SimState, kind: BuildingKind): boolean {
  return playerBuildingsView(state, kind).some((building) => building.constructing === 0);
}

function buildingCount(state: SimState, kind: BuildingKind): number {
  return playerBuildingsView(state, kind).length;
}

function pendingBuilding(state: SimState): boolean {
  return playerBuildingsView(state).some((building) => building.constructing > 0);
}

function repairPriority(kind: Entity["kind"]): number {
  if (kind === "constructionYard") return 0;
  if (kind === "turret") return 1;
  if (kind === "power") return 2;
  return 3;
}

function repairCommand(state: SimState, strategy: ArchetypeStrategy): Command | undefined {
  if (strategy !== "turtle") return undefined;
  if (playerBuildingsView(state).some((building) => building.repairing)) return undefined;
  const target = playerBuildingsView(state)
    .filter((building) => canRepair(building))
    .sort((a, b) => repairPriority(a.kind) - repairPriority(b.kind) || a.id - b.id)[0];
  return target ? { type: "repair", buildingId: target.id } : undefined;
}

function archetypeBuilding(state: SimState, strategy: ArchetypeStrategy, yard: Entity): Command | undefined {
  const power = powerBreakdown(state, 0);
  if (power.surplus < 10 && !playerBuildingsView(state, "power").some((building) => building.constructing > 0)) {
    return buildCommand(state, "power", yard, 0);
  }

  const pending = pendingBuilding(state);
  const threat = enemyEntitiesView(state).find(
    (entity) => entity.class === "unit" && entity.kind !== "harvester" && distToEntity(yard, entity) <= YARD_THREAT_RADIUS,
  );
  const turrets = buildingCount(state, "turret");

  if (strategy === "turtle" && !pending && turrets < 2 + Math.floor(state.missionIndex / 3)) {
    return buildCommand(state, "turret", yard, 0);
  }
  if (strategy === "greed" && buildingCount(state, "refinery") < 2 && !pending) {
    return buildCommand(state, "refinery", yard, 0);
  }
  if ((strategy === "rush" || strategy === "greed" || strategy === "vehicles") && !hasBuilding(state, "factory") && !pending) {
    return buildCommand(state, "factory", yard);
  }
  if ((strategy === "rush" || strategy === "infantry" || strategy === "turtle") && !hasBuilding(state, "barracks") && !pending) {
    return buildCommand(state, "barracks", yard);
  }
  if (strategy === "vehicles" && !hasBuilding(state, "barracks") && !pending) {
    return buildCommand(state, "barracks", yard);
  }
  if ((threat || strategy === "turtle") && turrets < 1 + Math.floor(state.missionIndex / 3) && !pending) {
    return buildCommand(state, "turret", yard, 0);
  }
  if (strategy === "greed" && state.tick > 1800 && !hasBuilding(state, "barracks") && !pending) {
    return buildCommand(state, "barracks", yard);
  }
  return undefined;
}

function desiredUnit(state: SimState, strategy: ArchetypeStrategy, producer: Entity): UnitKind | undefined {
  const harvesters = totalUnitCount(state, "harvester") + queuedUnitCount(state, "harvester");
  const enemyTanks = enemyEntitiesView(state).filter((entity) => entity.kind === "tank").length;
  const antiArmor = totalUnitCount(state, "antiArmor") + queuedUnitCount(state, "antiArmor");

  if (strategy === "greed" && producer.kind === "factory" && harvesters < 4) return "harvester";
  if (strategy === "rush" && producer.kind === "factory") return "tank";
  if (strategy === "vehicles" && producer.kind === "factory") return "tank";
  if ((strategy === "infantry" || strategy === "turtle") && producer.kind === "barracks") {
    return enemyTanks > antiArmor ? "antiArmor" : "infantry";
  }
  if ((strategy === "rush" || strategy === "vehicles") && producer.kind === "barracks") {
    return antiArmor < 4 + Math.floor(state.missionIndex / 2) ? "antiArmor" : "infantry";
  }
  if (producer.kind === "factory") return strategy === "greed" ? "tank" : "harvester";
  return "infantry";
}

function productionCommands(state: SimState, strategy: ArchetypeStrategy): Command[] {
  const commands: Command[] = [];
  let availableCredits = state.credits[0];
  const harvesters = totalUnitCount(state, "harvester") + queuedUnitCount(state, "harvester");
  let combatCount = combatUnits(state).length
    + queuedUnitCount(state, "infantry")
    + queuedUnitCount(state, "antiArmor")
    + queuedUnitCount(state, "tank");
  const producers = [...readyProducers(state, "barracks"), ...readyProducers(state, "factory")]
    .sort((a, b) => a.id - b.id);
  for (const producer of producers) {
    if (productionQueueSize(producer) >= MAX_ARCHETYPE_QUEUE) continue;
    if (strategy === "greed" && producer.kind === "barracks" && harvesters < 4) continue;
    const unit = desiredUnit(state, strategy, producer);
    if (!unit || !isUnitAvailable(unit, state.missionIndex) || producerFor(unit) !== producer.kind) continue;
    if (strategy === "turtle" && unit !== "harvester" && combatCount >= MAX_TURTLE_COMBAT_UNITS) continue;
    if (availableCredits < UNIT_STATS[unit].cost || powerFor(state, 0) < 0) continue;
    commands.push({ type: "produce", fromId: producer.id, unit });
    availableCredits -= UNIT_STATS[unit].cost;
    if (unit !== "harvester") combatCount += 1;
    if (commands.length >= 2) break;
  }
  return commands;
}

function combatTarget(state: SimState): Entity | undefined {
  return objectiveEntity(state)
    ?? enemyEntitiesView(state).find((entity) => entity.kind === "constructionYard");
}

function orderKey(command: Command): string {
  if (command.type === "attack") return `attack:${command.targetId}`;
  if (command.type === "move" || command.type === "attackMove") return `${command.type}:${command.x}:${command.y}`;
  return command.type;
}

function commitTick(state: SimState, strategy: ArchetypeStrategy): number {
  const horizon = state.runtime?.deadline ?? state.win.ticks ?? 3600;
  if (strategy === "rush") return Math.max(180, Math.floor(horizon * 0.10));
  if (strategy === "greed") return Math.floor(horizon * 0.90);
  if (strategy === "turtle") return Math.floor(horizon * 0.90);
  return Math.floor(horizon * 0.35);
}

function isDefensiveOnlyMission(state: SimState, strategy: ArchetypeStrategy): boolean {
  if (strategy === "greed") {
    return OFFENSIVE_KINDS.has(state.win.kind) || state.win.kind === "rescue" || state.win.kind === "extraction";
  }
  // Turtle may late-counterattack combat objectives so those runs finish.
  // Walking to a friendly rescue/extraction contact would complete those
  // missions as cheese rather than a defensive diagnostic.
  return strategy === "turtle" && (state.win.kind === "rescue" || state.win.kind === "extraction");
}

function commandCombat(state: SimState, strategy: ArchetypeStrategy, yard: Entity): Command | undefined {
  const combat = combatUnits(state);
  if (!combat.length) return undefined;
  const threat = defensiveThreat(state, yard);
  if (threat) return { type: "attack", unitIds: combat.map((unit) => unit.id), targetId: threat.id };

  const target = combatTarget(state);
  // Greed is deliberately defensive on combat/scenario missions. It may
  // respond to a base threat, but does not turn an economic opening into a
  // guaranteed objective win by eventually attacking everything. Turtle uses
  // its normal late counterattack on combat objectives so those runs stay
  // bounded, and stays home on rescue/extraction so contact is not cheese.
  if (!target || isDefensiveOnlyMission(state, strategy) || state.tick < commitTick(state, strategy)) {
    return { type: "move", unitIds: combat.map((unit) => unit.id), x: yard.x, y: yard.y, formation: "line" };
  }

  const targetIsFriendlyScenario = target.owner === 0 && (target.neutral || target.scenarioRole !== undefined);
  if (targetIsFriendlyScenario && (strategy === "turtle" || strategy === "greed")) {
    return { type: "move", unitIds: combat.map((unit) => unit.id), x: target.x, y: target.y, formation: "line" };
  }
  return { type: "attackMove", unitIds: combat.map((unit) => unit.id), x: target.x, y: target.y, formation: strategy === "rush" ? "wedge" : "line" };
}

export class ArchetypeCommander {
  private lastOrder = "";
  private lastOrderTick = Number.NEGATIVE_INFINITY;

  constructor(public readonly strategy: ArchetypeStrategy) {}

  plan(state: SimState): Command[] {
    if (state.result !== "playing" || state.tutorialStage !== undefined || state.tick % ARCHETYPE_CADENCE !== 0) return [];
    const yard = playerBuildingsView(state, "constructionYard")[0];
    if (!yard) return [];

    const commands: Command[] = [];
    const repair = repairCommand(state, this.strategy);
    if (repair) commands.push(repair);
    const building = archetypeBuilding(state, this.strategy, yard);
    if (building) commands.push(building);
    // A rush commander commits its bank to the opening attack instead of
    // quietly converting a successful rush into a normal production curve.
    // This keeps the diagnostic honest on force/economy quotas while still
    // exercising the same public production commands during the opening.
    if (!building && !(this.strategy === "rush" && state.tick >= commitTick(state, this.strategy))) {
      commands.push(...productionCommands(state, this.strategy));
    }
    const combat = commandCombat(state, this.strategy, yard);
    if (combat) {
      const key = `${orderKey(combat)}:${"unitIds" in combat ? combat.unitIds.join(",") : ""}`;
      if (key !== this.lastOrder || state.tick - this.lastOrderTick >= 96) {
        commands.push(combat);
        this.lastOrder = key;
        this.lastOrderTick = state.tick;
      }
    }
    return commands;
  }
}

export function isArchetypeStrategy(strategy: BalanceStrategy): strategy is ArchetypeStrategy {
  return ARCHETYPE_STRATEGIES.includes(strategy as ArchetypeStrategy);
}
