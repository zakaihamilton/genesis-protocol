import { inObjectiveZone } from "../../types";
import type { Command, Entity, MissionKind, SimState } from "../../types";
import { canRepair } from "../repair";
import { distToEntity } from "../world";
import {
  COMMANDER_CADENCE,
  COMBAT_ORDER_REFRESH,
  OFFENSIVE_KINDS,
  combatUnits,
  objectiveKind,
  playerBuildingsView,
} from "./queries";
import {
  planBuilding,
  planProduction,
} from "./production";
import {
  objectiveEntity,
  parallelOffensiveTargets,
  defensiveThreat,
  scenarioThreat,
  assaultReady,
  orderKey,
} from "./combat";
import type { CommanderMetrics } from "./queries";

const COMMANDER_REPAIR_CREDIT_RESERVE = 40;
const COMMANDER_YARD_REPAIR_THRESHOLD = 0.92;
const COMMANDER_STRUCTURE_REPAIR_THRESHOLD = 0.6;

function repairPriority(kind: Entity["kind"]): number {
  if (kind === "constructionYard") return 0;
  if (kind === "power") return 1;
  if (kind === "refinery") return 2;
  if (kind === "barracks") return 3;
  if (kind === "factory") return 4;
  return 5;
}

function planRepair(state: SimState): Command | undefined {
  if (state.credits[0] < COMMANDER_REPAIR_CREDIT_RESERVE) return undefined;
  // Repair one structure at a time. This keeps the credit drain predictable
  // and prevents the cadence from toggling an already-active repair order.
  if (playerBuildingsView(state).some((building) => building.repairing)) return undefined;

  const target = playerBuildingsView(state)
    .filter((building) => canRepair(building))
    .filter((building) => building.hp / building.maxHp <= (
      building.kind === "constructionYard"
        ? COMMANDER_YARD_REPAIR_THRESHOLD
        : COMMANDER_STRUCTURE_REPAIR_THRESHOLD
    ))
    .sort((a, b) => repairPriority(a.kind) - repairPriority(b.kind) || a.id - b.id)[0];
  return target ? { type: "repair", buildingId: target.id } : undefined;
}

export class CompetentCommander {
  private lastCombatOrder = "";
  private lastCombatOrderTick = Number.NEGATIVE_INFINITY;
  private assaultKind?: MissionKind;
  private assaultTargetId?: number;
  private metrics: CommanderMetrics = { plans: 0, commands: 0, commandsByType: {} };

  plan(state: SimState): Command[] {
    if (state.result !== "playing" || state.tutorialStage !== undefined || state.tick % COMMANDER_CADENCE !== 0) return [];
    const yard = playerBuildingsView(state, "constructionYard")[0];
    if (!yard) return [];

    this.metrics.plans += 1;
    const commands: Command[] = [];
    const repair = planRepair(state);
    if (repair) {
      commands.push(repair);
    } else {
      const building = planBuilding(state, yard);
      if (building) commands.push(building);
      if (!building) commands.push(...planProduction(state));
    }

    const threat = defensiveThreat(state, yard) ?? scenarioThreat(state);
    const objective = objectiveEntity(state);
    const extractionCargo = objectiveKind(state) === "extraction"
      ? (state.runtime?.targetIds ?? []).map((id) => state.entities.find((entity) => entity.id === id && entity.hp > 0)).filter((entity): entity is Entity => !!entity && !entity.neutral && !inObjectiveZone(entity.x, entity.y, state.runtime?.zone))
      : [];
    const extractionCargoIds = new Set(extractionCargo.map((entity) => entity.id));
    const extractionEscortTarget = [...extractionCargo]
      .sort((a, b) => distToEntity(b, yard) - distToEntity(a, yard) || a.id - b.id)[0];
    const combat = combatUnits(state);
    const objectiveCombat = objectiveKind(state) === "extraction"
      ? combat.filter((entity) => !extractionCargoIds.has(entity.id))
      : combat;
    const scenarioObjective = ["escort", "rescue", "extraction"].includes(objectiveKind(state)) && (
      objective?.neutral === true || extractionCargo.length > 0
    );

    if (extractionCargo.length) {
      commands.push({ type: "move", unitIds: extractionCargo.map((entity) => entity.id), x: yard.x, y: yard.y, formation: "line" });
    }

    if (combat.length) {
      const combatCommands: Command[] = [];
      const offensiveObjective = objective && objective.owner === 1 && OFFENSIVE_KINDS.has(objectiveKind(state));
      const assaultTargets = offensiveObjective
        ? objectiveKind(state) !== "sabotage" && parallelOffensiveTargets(state).length > 1
          ? parallelOffensiveTargets(state)
          : objective ? [objective] : []
        : [];
      if (!offensiveObjective || this.assaultKind !== objectiveKind(state)) {
        this.assaultKind = offensiveObjective ? objectiveKind(state) : undefined;
        this.assaultTargetId = undefined;
      }
      if (offensiveObjective && objective && (this.assaultTargetId === undefined || this.assaultTargetId !== objective.id)) {
        if (this.assaultTargetId !== undefined || assaultReady(state, objective, combat)) {
          this.assaultTargetId = objective.id;
        }
      }
      const assaultCommitted = offensiveObjective && this.assaultTargetId !== undefined;
      const defenderLimit = Math.min(4, Math.max(2, Math.floor(combat.length / 3)));
      const scenarioDefenderLimit = objectiveKind(state) === "rescue" ? 3 : 1;
      const reservedDefenders = scenarioObjective
        ? Math.min(scenarioDefenderLimit, Math.max(0, objectiveCombat.length - 1))
        : offensiveObjective
          ? Math.min(state.missionIndex < 2 ? 0 : 1, Math.max(0, objectiveCombat.length - 1))
        : defenderLimit;
      const defenders = (threat || offensiveObjective || scenarioObjective)
        ? [...objectiveCombat]
          .sort((a, b) => distToEntity(a, yard) - distToEntity(b, yard) || a.id - b.id)
          .slice(0, reservedDefenders)
        : [];
      const defenderIds = new Set(defenders.map((entity) => entity.id));
      const assaultForce = offensiveObjective || scenarioObjective
        ? objectiveCombat.filter((entity) => !defenderIds.has(entity.id))
        : combat;

      if (offensiveObjective && objective) {
        if (threat) {
          combatCommands.push({ type: "attack", unitIds: combat.map((entity) => entity.id), targetId: threat.id });
        } else if (assaultCommitted && assaultForce.length) {
          if (defenders.length) {
            combatCommands.push({ type: "move", unitIds: defenders.map((entity) => entity.id), x: yard.x, y: yard.y, formation: "line" });
          }
          for (let index = 0; index < assaultTargets.length; index++) {
            const target = assaultTargets[index]!;
            const unitIds = assaultForce.filter((_, unitIndex) => unitIndex % assaultTargets.length === index).map((entity) => entity.id);
            if (unitIds.length) {
              combatCommands.push({ type: "attackMove", unitIds, x: target.x, y: target.y, formation: "wedge" });
            }
          }
        } else {
          combatCommands.push({ type: "move", unitIds: combat.map((entity) => entity.id), x: yard.x, y: yard.y, formation: "line" });
        }
      } else if (threat) {
        if (objectiveKind(state) === "escort" && objectiveCombat.length) {
          combatCommands.push({ type: "attack", unitIds: objectiveCombat.map((entity) => entity.id), targetId: threat.id });
        } else if (objectiveKind(state) === "extraction" && objective && objectiveCombat.length) {
          const escortTarget = objectiveKind(state) === "extraction" ? extractionEscortTarget ?? objective : objective;
          combatCommands.push({ type: "attackMove", unitIds: objectiveCombat.map((entity) => entity.id), x: escortTarget.x, y: escortTarget.y, formation: "wedge" });
        } else {
          // Keep the rescue guard assigned to local defense instead of sending it with the rescue force.
          const rescueDefense = objectiveKind(state) === "rescue" && scenarioObjective;
          if (rescueDefense && defenders.length) {
            combatCommands.push({ type: "attack", unitIds: defenders.map((entity) => entity.id), targetId: threat.id });
          }
          const responseForce = rescueDefense ? assaultForce : combat;
          if (responseForce.length) {
            combatCommands.push({ type: "attack", unitIds: responseForce.map((entity) => entity.id), targetId: threat.id });
          }
        }
      } else {
        const force = scenarioObjective ? assaultForce : combat;
        const extractionRecovery = objectiveKind(state) === "extraction" && extractionCargo.length > 0 && objective?.neutral !== true;
        if (scenarioObjective && defenders.length) {
          combatCommands.push({ type: "move", unitIds: defenders.map((entity) => entity.id), x: yard.x, y: yard.y, formation: "line" });
        }
        if (force.length && extractionRecovery) {
          const needsCargoEscort = extractionEscortTarget !== undefined && force.some((entity) => distToEntity(entity, extractionEscortTarget) > 6);
          const recoveryDestination = needsCargoEscort ? extractionEscortTarget : yard;
          combatCommands.push({ type: "attackMove", unitIds: force.map((entity) => entity.id), x: recoveryDestination.x, y: recoveryDestination.y, formation: "line" });
        } else if (force.length && objective && (objective.neutral || objective.class === "unit" && objective.owner === 0)) {
          const escortDestination = { x: objective.x, y: objective.y };
          if (objectiveKind(state) === "escort") {
            combatCommands.push({ type: "attackMove", unitIds: force.map((entity) => entity.id), x: escortDestination.x, y: escortDestination.y, formation: "wedge" });
          } else {
            combatCommands.push({ type: "move", unitIds: force.map((entity) => entity.id), x: objective.x, y: objective.y, formation: "line" });
          }
        } else if (force.length && ["harvestQuota", "forceQuota", "structureQuota", "holdTheLine"].includes(objectiveKind(state))) {
          combatCommands.push({ type: "move", unitIds: force.map((entity) => entity.id), x: yard.x, y: yard.y, formation: "line" });
        }
      }

      if (combatCommands.length) {
        const key = combatCommands
          .map((command) => `${orderKey(command)}:${"unitIds" in command ? command.unitIds.join(",") : ""}`)
          .join("|");
        if (key !== this.lastCombatOrder || state.tick - this.lastCombatOrderTick >= COMBAT_ORDER_REFRESH) {
          commands.push(...combatCommands);
          this.lastCombatOrder = key;
          this.lastCombatOrderTick = state.tick;
        }
      }
    }

    this.metrics.commands += commands.length;
    for (const command of commands) {
      this.metrics.commandsByType[command.type] = (this.metrics.commandsByType[command.type] ?? 0) + 1;
    }
    return commands;
  }

  getMetrics(): CommanderMetrics {
    return {
      plans: this.metrics.plans,
      commands: this.metrics.commands,
      commandsByType: { ...this.metrics.commandsByType },
    };
  }
}
