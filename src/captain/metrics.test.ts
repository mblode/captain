import { describe, expect, it } from "vitest";

import { computeMetrics } from "./metrics";
import { deriveTuning } from "./tuning";
import type { HistoryRecord, Stage, Worktree } from "./types";

const r = (
  workspaceId: string,
  ts: number,
  from: Stage,
  to: Stage,
  over: Partial<HistoryRecord> = {}
): HistoryRecord => ({
  event: "Stop",
  from,
  kind: "advance",
  name: workspaceId,
  seq: ts,
  to,
  ts,
  workspaceId,
  ...over,
});

const wt = (workspaceId: string, stage: Stage, since: number): Worktree => ({
  agent: "claude",
  cwd: `/repo/${workspaceId}`,
  name: workspaceId,
  retries: 0,
  since,
  stage,
  workspaceId,
});

describe("computeMetrics", () => {
  it("derives stage durations from consecutive records", () => {
    // A record's `to` marks stage entry; the duration runs until the next record.
    // ws-1 enters IMPLEMENTING at 100, leaves at 160 → 60s in IMPLEMENTING.
    const history = [
      r("ws-1", 100, "PLAN_READY", "IMPLEMENTING", { kind: "approve" }),
      r("ws-1", 160, "IMPLEMENTING", "SIMPLIFY"),
    ];
    const m = computeMetrics(history, [], 200);
    expect(m.stages.IMPLEMENTING?.totalSec).toBe(60);
    expect(m.stages.IMPLEMENTING?.count).toBe(1);
  });

  it("folds the live open interval into the current stage", () => {
    const m = computeMetrics([], [wt("ws-1", "REVIEW", 100)], 250);
    expect(m.stages.REVIEW?.totalSec).toBe(150);
  });

  it("counts PR-ready, autonomy, and intervention rate", () => {
    const history = [
      // ws-1: clean run to a PR (no reject/block) → autonomous.
      r("ws-1", 10, "IMPLEMENTING", "SIMPLIFY"),
      r("ws-1", 20, "SIMPLIFY", "REVIEW"),
      r("ws-1", 30, "REVIEW", "PR_OPEN"),
      r("ws-1", 40, "PR_OPEN", "BABYSITTING"),
      // ws-2: got blocked mid-flight → not autonomous, one intervention.
      r("ws-2", 50, "IMPLEMENTING", "SIMPLIFY"),
      r("ws-2", 60, "SIMPLIFY", "BLOCKED", {
        event: "Notification",
        gate: "needs-input",
        kind: "gate",
      }),
      r("ws-2", 70, "PR_OPEN", "BABYSITTING"),
    ];
    const m = computeMetrics(history, [], 100);
    expect(m.prsReady).toBe(2);
    expect(m.autonomousRuns).toBe(1);
    expect(m.autonomyRate).toBeCloseTo(0.5);
    expect(m.interventions.blocks).toBe(1);
    // 6 advances, 1 intervention → 1/6.
    expect(m.interventionRate).toBeCloseTo(1 / 6);
  });
});

describe("deriveTuning", () => {
  it("caps nothing when the log is empty (cold-start parity)", () => {
    const m = computeMetrics([], [], 100);
    expect(deriveTuning(m).maxRetries).toEqual({});
  });

  it("gives a flaky stage a smaller retry budget", () => {
    // SIMPLIFY: 1 clean advance + 3 busy-defer reworks → high bounce rate.
    const history = [
      r("ws-1", 10, "SIMPLIFY", "REVIEW"),
      r("ws-1", 11, "SIMPLIFY", "SIMPLIFY", { kind: "rework" }),
      r("ws-2", 12, "SIMPLIFY", "SIMPLIFY", { kind: "rework" }),
      r("ws-3", 13, "SIMPLIFY", "SIMPLIFY", { kind: "rework" }),
    ];
    const tuning = deriveTuning(computeMetrics(history, [], 100));
    expect(tuning.maxRetries.SIMPLIFY).toBeDefined();
    expect(tuning.maxRetries.SIMPLIFY).toBeLessThanOrEqual(2);
    expect(tuning.maxRetries.SIMPLIFY).toBeGreaterThanOrEqual(1);
  });

  it("leaves a perfectly reliable stage uncapped", () => {
    const history = [
      r("ws-1", 10, "REVIEW", "PR_OPEN"),
      r("ws-2", 11, "REVIEW", "PR_OPEN"),
      r("ws-3", 12, "REVIEW", "PR_OPEN"),
    ];
    const tuning = deriveTuning(computeMetrics(history, [], 100));
    expect(tuning.maxRetries.REVIEW).toBeUndefined();
  });
});
