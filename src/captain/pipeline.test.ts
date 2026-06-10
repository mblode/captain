import { describe, expect, it } from "vitest";

import { checkHalt, onPlanApproved, transition } from "./pipeline";
import type { HookEvent, Stage, Worktree } from "./types";

const wt = (stage: Stage, over: Partial<Worktree> = {}): Worktree => ({
  agent: "claude",
  cwd: "/repo/tig-1",
  name: "tig-1",
  since: 0,
  stage,
  workspaceId: "ws-1",
  ...over,
});

const ev = (hookEventName: string): HookEvent => ({
  cwd: "/repo/tig-1",
  hookEventName,
  seq: 1,
  workspaceId: "ws-1",
});

describe("transition", () => {
  it("routes ExitPlanMode to the PLAN_READY gate", () => {
    const t = transition(wt("PLANNING"), ev("ExitPlanMode"));
    expect(t?.nextStage).toBe("PLAN_READY");
    expect(t?.gate).toBe("plan");
  });

  it("ignores a re-emitted ExitPlanMode once a worktree is past approval", () => {
    // cmux re-emits frames and bypass-mode agents re-present plans mid-implement;
    // neither may regress an implementing (or later) worktree back to PLAN_READY.
    expect(transition(wt("IMPLEMENTING"), ev("ExitPlanMode"))).toBeNull();
    expect(transition(wt("SIMPLIFY"), ev("ExitPlanMode"))).toBeNull();
    expect(transition(wt("PR_OPEN"), ev("ExitPlanMode"))).toBeNull();
    // ...but a re-emit while still parked at the gate stays idempotently gated.
    expect(transition(wt("PLAN_READY"), ev("ExitPlanMode"))?.nextStage).toBe(
      "PLAN_READY"
    );
  });

  it("auto-advances the pipeline on Stop in the real cadence order", () => {
    expect(transition(wt("IMPLEMENTING"), ev("Stop"))).toMatchObject({
      nextStage: "SIMPLIFY",
      send: "/simplify",
    });
    expect(transition(wt("SIMPLIFY"), ev("Stop"))).toMatchObject({
      nextStage: "REVIEW",
      send: "/pr-reviewer",
    });
    expect(transition(wt("REVIEW"), ev("Stop"))).toMatchObject({
      nextStage: "PR_OPEN",
      send: "/pr-creator",
    });
    expect(transition(wt("PR_OPEN"), ev("Stop"))).toMatchObject({
      nextStage: "BABYSITTING",
      send: "/pr-babysitter",
    });
  });

  it("does not advance on Stop in a gated/terminal stage", () => {
    expect(transition(wt("PLAN_READY"), ev("Stop"))).toBeNull();
    expect(transition(wt("BABYSITTING"), ev("Stop"))).toBeNull();
    expect(transition(wt("READY_TO_MERGE"), ev("Stop"))).toBeNull();
  });

  it("routes AskUserQuestion to BLOCKED", () => {
    expect(
      transition(wt("IMPLEMENTING"), ev("AskUserQuestion"))?.nextStage
    ).toBe("BLOCKED");
  });

  it("only blocks on Notification while actively working", () => {
    expect(transition(wt("IMPLEMENTING"), ev("Notification"))?.nextStage).toBe(
      "BLOCKED"
    );
    expect(transition(wt("READY_TO_MERGE"), ev("Notification"))).toBeNull();
  });

  it("moves a fresh worktree to PLANNING on first activity", () => {
    expect(transition(wt("ADOPTED"), ev("UserPromptSubmit"))?.nextStage).toBe(
      "PLANNING"
    );
    expect(transition(wt("IMPLEMENTING"), ev("PreToolUse"))).toBeNull();
  });

  it("ignores SubagentStop and SessionStart", () => {
    expect(transition(wt("IMPLEMENTING"), ev("SubagentStop"))).toBeNull();
    expect(transition(wt("ADOPTED"), ev("SessionStart"))).toBeNull();
  });
});

describe("checkHalt", () => {
  const stallSecs = 1800;

  it("halts a HALTABLE worktree quiet past the stall threshold", () => {
    const t = checkHalt(wt("IMPLEMENTING", { lastSeen: 0 }), 2000, stallSecs);
    expect(t?.nextStage).toBe("BLOCKED");
    expect(t?.gate).toBe("needs-input");
    expect(t?.send).toBeUndefined();
  });

  it("returns null when recent activity is within the threshold", () => {
    expect(
      checkHalt(wt("IMPLEMENTING", { lastSeen: 1900 }), 2000, stallSecs)
    ).toBeNull();
  });

  it("returns null for non-HALTABLE stages even when long quiet", () => {
    expect(
      checkHalt(wt("ADOPTED", { lastSeen: 0 }), 9000, stallSecs)
    ).toBeNull();
    expect(
      checkHalt(wt("BABYSITTING", { lastSeen: 0 }), 9000, stallSecs)
    ).toBeNull();
    expect(
      checkHalt(wt("PLAN_READY", { lastSeen: 0 }), 9000, stallSecs)
    ).toBeNull();
  });

  it("returns null when a gate is already set", () => {
    expect(
      checkHalt(
        wt("IMPLEMENTING", { gate: "needs-input", lastSeen: 0 }),
        9000,
        stallSecs
      )
    ).toBeNull();
  });

  it("falls back to since when lastSeen is undefined", () => {
    // No lastSeen on pre-field state: the stall clock reads `since`.
    expect(
      checkHalt(wt("REVIEW", { since: 0 }), 2000, stallSecs)?.nextStage
    ).toBe("BLOCKED");
    expect(
      checkHalt(wt("REVIEW", { since: 1900 }), 2000, stallSecs)
    ).toBeNull();
  });
});

describe("gates", () => {
  it("approving a plan moves to IMPLEMENTING", () => {
    expect(onPlanApproved()).toBe("IMPLEMENTING");
  });
});
