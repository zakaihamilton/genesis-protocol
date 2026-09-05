import { describe, expect, it } from "vitest";
import { createCampaign } from "../../lib/gen/campaign";
import { MAX_MISSION_TICKS } from "../../lib/gen/pacing";
import { BUILDING_STATS } from "../../lib/catalog";
import { createMission, inspect, tick } from "../../lib/sim/api";
import { CompetentCommander } from "../../lib/sim/commander";
import { planBuilding } from "../../lib/sim/commander/production";
import { missionDifficulty } from "../../lib/sim/difficulty";
import { addBuilding, addUnit, makeFixture } from "../../lib/sim/fixtures";
import { enemyEntities, playerBuildings, playerUnits } from "../../lib/sim/commander/queries";
import { powerBreakdown } from "../../lib/sim/world";

const IS_COVERAGE = Boolean(process.env.NODE_V8_COVERAGE || process.env.VITEST_COVERAGE);

function runGeneratedMission(seed: number, missionIndex: number) {
  const state = createMission({ seed, missionIndex });
  const commander = new CompetentCommander();
  const horizon = state.runtime?.deadline ?? state.win.ticks ?? MAX_MISSION_TICKS;
  for (let i = 0; i < horizon && state.result === "playing"; i++) {
    tick(state, commander.plan(state));
  }
  return state;
}

describe("competent commander", () => {
  it("returns snapshots instead of exposing cached query state", () => {
    const state = makeFixture({ width: 20, height: 20, win: { kind: "annihilate" } });
    const building = addBuilding(state, 0, "power", 2, 2);
    const unit = addUnit(state, 0, "infantry", 4, 4);
    const enemy = addUnit(state, 1, "infantry", 15, 15);

    playerBuildings(state).length = 0;
    playerUnits(state).length = 0;
    enemyEntities(state).length = 0;
    const totals = powerBreakdown(state, 0);
    totals.produced = 0;
    totals.surplus = 0;

    expect(playerBuildings(state)).toContainEqual(building);
    expect(playerUnits(state)).toContainEqual(unit);
    expect(enemyEntities(state)).toContainEqual(enemy);
    expect(powerBreakdown(state, 0)).toMatchObject({ produced: 50, used: 0, surplus: 50 });
  });

  it("queues a force-quota role and wins through the public command API", () => {
    const state = makeFixture({ width: 24, height: 24, win: { kind: "forceQuota", role: "tank", target: 1 } });
    addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "factory", 2, 5);
    addBuilding(state, 1, "constructionYard", 18, 18);
    const commander = new CompetentCommander();

    for (let i = 0; i < BUILDING_STATS.factory.buildTicks + 30 && state.result === "playing"; i++) {
      tick(state, commander.plan(state));
    }

    expect(state.result).toBe("won");
    expect(state.unitsProducedByRole.tank).toBeGreaterThanOrEqual(1);
    expect(commander.getMetrics().commandsByType.produce).toBeGreaterThan(0);
  });

  it("repairs a damaged command HQ without toggling an active repair", () => {
    const state = makeFixture({ width: 24, height: 24, win: { kind: "forceQuota", role: "infantry", target: 1 } });
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    yard.hp = 2_800;
    const commander = new CompetentCommander();

    const first = commander.plan(state);
    expect(first).toContainEqual({ type: "repair", buildingId: yard.id });
    const result = tick(state, first);
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: "commandRejected" }));
    expect(yard.repairing).toBe(true);
    expect(yard.hp).toBeGreaterThan(2_800);

    state.tick = 24;
    expect(commander.plan(state)).not.toContainEqual({ type: "repair", buildingId: yard.id });
  });

  it("keeps two identical missions and commander plans deterministic", () => {
    const a = createMission({ seed: 421, missionIndex: 0 });
    const b = createMission({ seed: 421, missionIndex: 0 });
    const commanderA = new CompetentCommander();
    const commanderB = new CompetentCommander();

    for (let i = 0; i < 720 && a.result === "playing"; i++) {
      const ordersA = commanderA.plan(a);
      const ordersB = commanderB.plan(b);
      expect(ordersA).toEqual(ordersB);
      tick(a, ordersA);
      tick(b, ordersB);
    }

    expect(inspect(a)).toEqual(inspect(b));
    expect(commanderA.getMetrics()).toEqual(commanderB.getMetrics());
  });

  it("gives the first offensive mission enough infrastructure to stage an assault", () => {
    const state = createMission({ seed: 0, missionIndex: 0 });
    const player = state.entities.filter((entity) => entity.owner === 0);

    expect(player.some((entity) => entity.class === "building" && entity.kind === "factory")).toBe(true);
    expect(player.some((entity) => entity.class === "building" && entity.kind === "turret")).toBe(true);
    expect(player.some((entity) => entity.class === "unit" && entity.kind === "antiArmor")).toBe(true);
    expect(player.some((entity) => entity.class === "unit" && entity.kind === "tank")).toBe(true);
  });

  it("issues useful macro orders across every generated mission kind", () => {
    const campaign = createCampaign(0);
    for (const mission of campaign.missions) {
      const state = createMission({ seed: 0, missionIndex: mission.index });
      const commander = new CompetentCommander();
      let rejections = 0;
      for (let i = 0; i < 240 && state.result === "playing"; i++) {
        const result = tick(state, commander.plan(state));
        rejections += result.events.filter((event) => event.type === "commandRejected").length;
      }
      expect(commander.getMetrics().commands).toBeGreaterThan(0);
      expect(rejections).toBe(0);
    }
  });

  it("does not retry an impossible single-instance building for a structure quota", () => {
    const state = createMission({ seed: 23, missionIndex: 7 });
    const commander = new CompetentCommander();
    let rejections = 0;

    for (let i = 0; i < 4_000 && state.result === "playing"; i++) {
      const result = tick(state, commander.plan(state));
      rejections += result.events.filter((event) => event.type === "commandRejected").length;
    }

    expect(state.missionKind).toBe("structureQuota");
    expect(rejections).toBe(0);
  });

  it.skipIf(IS_COVERAGE).each([
    [2, 7, "structureQuota"],
    [1, 7, "escort"],
    [3, 1, "extraction"],
  ] as const)("completes generated %s/%s (%s) objectives with deterministic command execution", (seed, missionIndex, kind) => {
    const state = runGeneratedMission(seed, missionIndex);

    expect(state.missionKind).toBe(kind);
    expect(state.result).toBe("won");
  });

  it("keeps a committed assault focused on its objective until it wins", () => {
    const state = makeFixture({ width: 24, height: 24, win: { kind: "sabotage", targetCount: 1, ticks: 5000 } });
    addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "barracks", 2, 5);
    const attackers = Array.from({ length: 8 }, (_, index) => addUnit(state, 0, index % 2 ? "antiArmor" : "infantry", 5 + (index % 4), 6 + Math.floor(index / 4)));
    addBuilding(state, 1, "constructionYard", 18, 18);
    const marked = addBuilding(state, 1, "objective", 12, 12, 0, true);
    marked.hp = 30;
    state.win.targetIds = [marked.id];
    state.runtime = { kind: "sabotage", phase: "active", targetIds: [marked.id], rescued: 0, required: 1, secondary: [] };
    const commander = new CompetentCommander();

    for (let i = 0; i < 1200 && state.result === "playing"; i++) tick(state, commander.plan(state));

    expect(attackers.some((attacker) => attacker.hp > 0)).toBe(true);
    expect(state.result).toBe("won");
  });

  it("moves a rescue force toward neutral scenario targets", () => {
    const state = makeFixture({ width: 20, height: 20, win: { kind: "rescue", targetCount: 1, ticks: 5000 } });
    state.missionIndex = 2;
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "barracks", 2, 5);
    const infantry = addUnit(state, 0, "infantry", 4, 4);
    const target = addUnit(state, 0, "infantry", 8, 8);
    target.neutral = true;
    target.scenarioRole = "stranded";
    state.runtime = {
      kind: "rescue",
      phase: "active",
      targetIds: [target.id],
      zone: { x: yard.x, y: yard.y },
      rescued: 0,
      required: 1,
      secondary: [],
    };
    const commander = new CompetentCommander();
    const orders = commander.plan(state);

    expect(orders).toContainEqual(expect.objectContaining({ type: "move", unitIds: [infantry.id], x: target.x, y: target.y }));
  });

  it("keeps three combat units at the yard during a rescue operation", () => {
    const state = makeFixture({ width: 28, height: 28, win: { kind: "rescue", targetCount: 1, ticks: 5000 } });
    state.missionIndex = 4;
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "barracks", 2, 5);
    addBuilding(state, 0, "factory", 2, 8);
    const combat = Array.from({ length: 5 }, (_, index) => addUnit(state, 0, "infantry", 5 + index, 5));
    const target = addUnit(state, 0, "infantry", 20, 20);
    target.neutral = true;
    target.scenarioRole = "stranded";
    state.runtime = {
      kind: "rescue",
      phase: "active",
      targetIds: [target.id],
      zone: { x: yard.x, y: yard.y },
      rescued: 0,
      required: 1,
      secondary: [],
    };

    const orders = new CompetentCommander().plan(state);
    const guard = orders.find((order) => order.type === "move" && order.x === yard.x && order.y === yard.y);
    const rescue = orders.find((order) => order.type === "move" && order.x === target.x && order.y === target.y);

    expect(guard && "unitIds" in guard ? guard.unitIds : []).toHaveLength(3);
    expect(rescue && "unitIds" in rescue ? rescue.unitIds : []).toHaveLength(combat.length - 3);
  });

  it("keeps the rescue guard separate from the rescue force when threatened", () => {
    const state = makeFixture({ width: 28, height: 28, win: { kind: "rescue", targetCount: 1, ticks: 5000 } });
    state.missionIndex = 4;
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "barracks", 2, 5);
    addBuilding(state, 0, "factory", 2, 8);
    const combat = Array.from({ length: 5 }, (_, index) => addUnit(state, 0, "infantry", 5 + index, 5));
    const target = addUnit(state, 0, "infantry", 20, 20);
    target.neutral = true;
    target.scenarioRole = "stranded";
    const threat = addUnit(state, 1, "infantry", 4, 4);
    state.runtime = {
      kind: "rescue",
      phase: "active",
      targetIds: [target.id],
      zone: { x: yard.x, y: yard.y },
      rescued: 0,
      required: 1,
      secondary: [],
    };

    const orders = new CompetentCommander().plan(state);
    const guard = orders.find((order) => order.type === "attack" && order.targetId === threat.id && "unitIds" in order && order.unitIds.length === 3);
    const response = orders.find((order) => order.type === "attack" && order.targetId === threat.id && "unitIds" in order && order.unitIds.length === combat.length - 3);
    const guardIds = guard && "unitIds" in guard ? guard.unitIds : [];
    const responseIds = response && "unitIds" in response ? response.unitIds : [];

    expect(guardIds).toHaveLength(3);
    expect(responseIds).toHaveLength(combat.length - 3);
    expect(new Set([...guardIds, ...responseIds])).toHaveLength(combat.length);
  });

  it.each(["rescue", "holdTheLine"] as const)("prioritizes an early defensive turret for %s missions", (kind) => {
    const win = kind === "rescue"
      ? { kind, targetCount: 1, ticks: 5000 }
      : { kind, ticks: 5000 };
    const state = makeFixture({ width: 24, height: 24, win });
    state.missionIndex = 0;
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "barracks", 2, 5);

    expect(planBuilding(state, yard)).toMatchObject({ type: "build", building: "turret" });
  });

  it("keeps the exact hold-the-line reinforcement curve", () => {
    expect(Array.from({ length: 8 }, (_, index) => missionDifficulty(index).holdLineReinforcements)).toEqual([1, 2, 2, 3, 3, 3, 4, 3]);
  });

  it("keeps contacted extraction cargo on its return route", () => {
    const state = makeFixture({ width: 20, height: 20, win: { kind: "extraction", targetCount: 1, ticks: 5000 } });
    state.missionIndex = 2;
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    const escort = addUnit(state, 0, "infantry", 6, 6);
    const cargo = addUnit(state, 0, "infantry", 10, 10);
    cargo.scenarioRole = "cargo";
    const targetId = cargo.id;
    state.runtime = {
      kind: "extraction",
      phase: "extraction",
      targetIds: [targetId],
      zone: { x: yard.x, y: yard.y },
      rescued: 0,
      required: 1,
      secondary: [],
    };

    const orders = new CompetentCommander().plan(state);
    const cargoOrders = orders.filter((order) => "unitIds" in order && order.unitIds.includes(cargo.id));

    expect(cargoOrders).toHaveLength(1);
    expect(cargoOrders[0]).toMatchObject({ type: "move", unitIds: [cargo.id], x: yard.x, y: yard.y });
    expect(orders).toContainEqual(expect.objectContaining({ type: "attackMove", unitIds: [escort.id], x: yard.x, y: yard.y }));
  });

  it("stages a small assault force instead of sending it into a marked base", () => {
    const state = makeFixture({ width: 24, height: 24, win: { kind: "sabotage", targetCount: 1, ticks: 5000 } });
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    addBuilding(state, 0, "barracks", 2, 5);
    addUnit(state, 0, "infantry", 4, 4);
    addBuilding(state, 1, "constructionYard", 18, 18);
    const marked = addBuilding(state, 1, "objective", 14, 14, 0, true);
    state.win.targetIds = [marked.id];
    const commander = new CompetentCommander();

    const orders = commander.plan(state);

    expect(orders).toContainEqual(expect.objectContaining({ type: "move", x: yard.x, y: yard.y }));
    expect(orders.some((order) => order.type === "attack")).toBe(false);
  });

  it("commits a ready offensive force while leaving a home guard", () => {
    const state = makeFixture({ width: 24, height: 24, win: { kind: "sabotage", targetCount: 1, ticks: 5000 } });
    state.missionIndex = 2;
    const yard = addBuilding(state, 0, "constructionYard", 2, 2);
    addBuilding(state, 0, "power", 5, 2);
    const attackers = Array.from({ length: 8 }, (_, index) => addUnit(state, 0, index % 2 ? "antiArmor" : "infantry", 5 + (index % 4), 6 + Math.floor(index / 4)));
    addBuilding(state, 1, "constructionYard", 18, 18);
    const marked = addBuilding(state, 1, "objective", 14, 14, 0, true);
    state.win.targetIds = [marked.id];

    const orders = new CompetentCommander().plan(state);
    const attack = orders.find((order) => order.type === "attackMove" && order.x === marked.x && order.y === marked.y);
    const guarded = orders.find((order) => order.type === "move" && order.x === yard.x && order.y === yard.y);

    expect(attack).toBeDefined();
    expect(attack && "unitIds" in attack ? attack.unitIds.length : 0).toBeGreaterThan(0);
    expect(attack && "unitIds" in attack ? attack.unitIds.length : 0).toBeLessThan(attackers.length);
    expect(guarded).toBeDefined();
  });
});
