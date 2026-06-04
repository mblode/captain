import { describe, expect, it } from "vitest";

import { isHumanGated, onPlanApproved, transition } from "./pipeline.js";
import type { HookEvent, Stage, Worktree } from "./types.js";

const wt = (stage: Stage): Worktree => ({
  agent: "claude",
  cwd: "/repo/tig-1",
  name: "tig-1",
  retries: 0,
  since: 0,
  stage,
  workspaceId: "ws-1",
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

describe("gates", () => {
  it("approving a plan moves to IMPLEMENTING", () => {
    expect(onPlanApproved()).toBe("IMPLEMENTING");
  });

  it("flags the human-gated stages", () => {
    expect(isHumanGated("PLAN_READY")).toBe(true);
    expect(isHumanGated("READY_TO_MERGE")).toBe(true);
    expect(isHumanGated("BLOCKED")).toBe(true);
    expect(isHumanGated("SIMPLIFY")).toBe(false);
  });
});
