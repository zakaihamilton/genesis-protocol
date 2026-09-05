import { describe, expect, it } from "vitest";
import { MAX_OPERATION_TICKS } from "../../lib/gen/pacing";
import { balanceFailureReason } from "../../lib/sim/balance";
import {
  runBalanceJob,
  stableBalanceRecords,
  type BalanceScenario,
} from "../../lib/sim/balanceRunner";

const COMPETENT_EDGE_SCENARIOS: BalanceScenario[] = [
  { seed: 1, mission: 5 },
  { seed: 2, mission: 4 },
  { seed: 12, mission: 5 },
  { seed: 16, mission: 5 },
  { seed: 22, mission: 6 },
  { seed: 26, mission: 6 },
  { seed: 28, mission: 6 },
  { seed: 29, mission: 6 },
  { seed: 30, mission: 2 },
  { seed: 33, mission: 7 },
  { seed: 38, mission: 7 },
  { seed: 39, mission: 7 },
];

function runEdgeScenarios() {
  return runBalanceJob({
    from: 0,
    to: 0,
    missions: [2, 4, 5, 6, 7],
    maxTicks: MAX_OPERATION_TICKS,
    strategy: "competent",
    scenarios: COMPETENT_EDGE_SCENARIOS,
  });
}

describe("competent commander balance regressions", () => {
  it("replays the known edge scenarios deterministically without infrastructure failures", () => {
    const first = runEdgeScenarios();
    const second = runEdgeScenarios();
    const firstStable = stableBalanceRecords(first);
    const secondStable = stableBalanceRecords(second);

    expect(secondStable).toEqual(firstStable);
    expect(firstStable).toHaveLength(COMPETENT_EDGE_SCENARIOS.length);
    expect(first.map((record) => `${String(record.seed)} / M${record.mission ?? -1}`)).toEqual([
      "0001 / M5",
      "0002 / M4",
      "0012 / M5",
      "0016 / M5",
      "0022 / M6",
      "0026 / M6",
      "0028 / M6",
      "0029 / M6",
      "0030 / M2",
      "0033 / M7",
      "0038 / M7",
      "0039 / M7",
    ]);

    for (const record of firstStable) {
      expect(record).toMatchObject({
        mapValid: true,
        targetReachable: true,
        commandRejections: 0,
        powerDeficit: false,
        nonFiniteState: false,
      });

      if (record.result === "lost") {
        expect(record.lossReason).toBeDefined();
        expect(record.failureReason).toBe(record.lossReason);
      } else if (record.result === "playing") {
        // A non-terminal record is only acceptable when the full generated
        // operation horizon was consumed rather than an accidental cap.
        expect(record.truncated).toBe(false);
        expect(record.duration).toBeGreaterThan(0);
      }
      expect(record.failureReason).toBe(balanceFailureReason(record));
    }
  }, 120_000);
});
