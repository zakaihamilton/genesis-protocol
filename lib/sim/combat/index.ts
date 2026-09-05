import { distToEntity, livingView } from "../world";
import { rngFromState } from "../../seed/rng";
import { buildGrid, statsFor, isCombatThreat, acquire, acquirePreferred, closestEnemy } from "./grid";
import { lineOfSight, firingPosition } from "./targeting";
import { strike, chase, resumeAttackMove } from "./damage";
import { createPendingAlerts, flushPlayerAlerts } from "./alerts";
import type { SimEvent, SimState } from "../../types";
import { tryFindPath } from "../pathBudget";

const EMPTY_EVENTS: SimEvent[] = [];

export function tickCombat(state: SimState, eventSink?: SimEvent[], collectEvents = true): SimEvent[] {
  const events = eventSink ?? (collectEvents ? [] : undefined);
  const pending = collectEvents ? createPendingAlerts() : undefined;
  const rng = rngFromState(state.rngState);
  const grid = buildGrid(state);
  for (const e of livingView(state)) {
    if (e.class === "unit") e.suppression = Math.max(0, (e.suppression ?? 0) - 1);
    const st = statsFor(e);
    if (st.damage <= 0 || e.neutral) continue;
    if (e.constructing > 0) continue;
    if (e.cooldown > 0) e.cooldown -= 1;

    const ordered = e.class === "unit" && !e.idle;
    if (ordered && e.attackTarget !== undefined) {
      const assignedCandidate = grid.byId[e.attackTarget];
      const assigned = assignedCandidate && assignedCandidate.hp > 0 ? assignedCandidate : undefined;
      if (!assigned) {
        e.attackTarget = undefined;
        resumeAttackMove(state, e);
      } else {
        const d = distToEntity(e, assigned);
        if (d <= st.range) {
          e.path = [];
          e.routePending = false;
          e.flowGoal = undefined;
          if (lineOfSight(state, e, assigned)) {
            strike(state, e, assigned, st, rng, events, pending);
          } else {
            const flank = firingPosition(state, e, assigned, st.range);
            if (flank) {
              const path = tryFindPath(state, e, flank);
              if (path !== undefined) e.path = path;
            }
          }
          if (e.attackTarget === undefined) resumeAttackMove(state, e);
        } else {
          const intercept = e.owner === 1 && !isCombatThreat(state, assigned)
            ? closestEnemy(grid, e, st.range, true)
            : undefined;
          if (intercept && lineOfSight(state, e, intercept)) {
            e.attackTarget = intercept.id;
            e.path = [];
            e.routePending = false;
            e.flowGoal = undefined;
            strike(state, e, intercept, st, rng, events, pending);
          } else {
            chase(state, e, assigned);
          }
        }
        continue;
      }
    }

    if (ordered && e.path.length > 0) {
      if (e.orderMode === "attackMove") {
        const visible = acquire(grid, e, false);
        if (visible && lineOfSight(state, e, visible)) {
          e.attackTarget = visible.id;
          e.path = [];
          e.routePending = false;
          e.flowGoal = undefined;
          if (distToEntity(e, visible) <= st.range) {
            strike(state, e, visible, st, rng, events, pending);
            if (e.attackTarget === undefined) resumeAttackMove(state, e);
          } else chase(state, e, visible);
        } else {
          const opportunity = closestEnemy(grid, e, st.range, false);
          if (opportunity && lineOfSight(state, e, opportunity)) strike(state, e, opportunity, st, rng, events, pending);
        }
      } else {
        const opportunity = closestEnemy(grid, e, st.range, false);
        if (opportunity && lineOfSight(state, e, opportunity)) strike(state, e, opportunity, st, rng, events, pending);
      }
      continue;
    }

    if (ordered) e.idle = true;

    const stance = e.class === "unit" ? (e.stance ?? "aggressive") : "aggressive";
    const hold = stance === "hold";
    const defend = stance === "defensive";
    const inRangeThreat = hold ? undefined : closestEnemy(grid, e, st.range, true);
    let target = inRangeThreat ?? (hold ? undefined : e.attackTarget !== undefined ? grid.byId[e.attackTarget] : undefined);
    if (target && target.hp <= 0) target = undefined;
    if (target && !isCombatThreat(state, target)) {
      const threat = hold || defend ? closestEnemy(grid, e, st.range, true) : acquire(grid, e, true);
      if (threat) {
        target = threat;
        e.path = [];
        e.routePending = false;
      }
    }
    if (!target && !hold && !defend) target = acquirePreferred(grid, e);
    if (target) e.attackTarget = target.id;
    else {
      if (hold || defend) e.attackTarget = undefined;
      continue;
    }

    const d = distToEntity(e, target);
    if (d <= st.range && lineOfSight(state, e, target)) {
      e.path = [];
      e.routePending = false;
      strike(state, e, target, st, rng, events, pending);
      continue;
    }

    if (e.class === "unit" && !hold && !defend) chase(state, e, target);
    else {
      e.path = [];
      e.routePending = false;
      e.attackTarget = undefined;
    }
  }
  if (events && pending) flushPlayerAlerts(state, pending, events);
  state.rngState = rng.state;
  return events ?? EMPTY_EVENTS;
}
