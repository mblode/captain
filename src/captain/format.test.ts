import { describe, expect, it } from "vitest";

import { fmtAge, groupOf, renderStatus, style } from "./format";
import type { Stage, Worktree } from "./types";

const plain = style(false);
const wt = (name: string, stage: Stage, since = 0): Worktree => ({
  agent: "claude",
  cwd: `/repo/${name}`,
  name,
  retries: 0,
  since,
  stage,
  workspaceId: name,
});

describe("fmtAge", () => {
  it("shows an em dash for unset timestamps", () => {
    expect(fmtAge(0)).toBe("—");
  });

  it("formats minutes and hours", () => {
    const t = Math.floor(Date.now() / 1000);
    expect(fmtAge(t)).toBe("just now");
    expect(fmtAge(t - 5 * 60)).toBe("5m");
    expect(fmtAge(t - (2 * 60 + 5) * 60)).toBe("2h5m");
  });
});

describe("groupOf", () => {
  it("maps stages to the right group", () => {
    expect(groupOf("PLAN_READY")).toBe("needs-you");
    expect(groupOf("BLOCKED")).toBe("needs-you");
    expect(groupOf("SIMPLIFY")).toBe("in-flight");
    expect(groupOf("READY_TO_MERGE")).toBe("ready");
  });
});

describe("renderStatus", () => {
  it("guides the user when the fleet is empty", () => {
    const out = renderStatus([], plain, "not running");
    expect(out).toContain("no worktrees tracked yet");
    expect(out).toContain("watcher: not running");
  });

  it("leads with NEEDS YOU and inlines the resolve command", () => {
    const out = renderStatus(
      [
        wt("frontyard-tig-1", "IMPLEMENTING"),
        wt("frontyard-tig-2", "PLAN_READY"),
      ],
      plain,
      "running (pid 42)"
    );
    expect(out).toContain("2 worktrees");
    expect(out).toContain("1 need you");
    expect(out).toContain("watcher: running (pid 42)");
    // NEEDS YOU section comes before IN FLIGHT.
    expect(out.indexOf("NEEDS YOU")).toBeLessThan(out.indexOf("IN FLIGHT"));
    // The gate carries its own resolve command — no separate `gates` command.
    expect(out).toContain("captain approve --plans tig-2");
  });

  it("inlines a merge hint when a worktree is ready", () => {
    const ready = {
      ...wt("frontyard-tig-1", "READY_TO_MERGE"),
      prUrl: "https://x/pr/1",
    };
    const out = renderStatus([ready], plain, "running (pid 42)");
    expect(out).toContain("gh pr merge https://x/pr/1 --squash");
  });

  it("shows a pending placeholder for a ready worktree without a PR url", () => {
    const out = renderStatus(
      [wt("frontyard-tig-1", "READY_TO_MERGE")],
      plain,
      "running (pid 42)"
    );
    expect(out).toContain("(PR url pending)");
    expect(out).not.toContain("gh pr merge");
  });

  it("inlines an answer hint for a blocked worktree, with its note", () => {
    const blocked = { ...wt("frontyard-tig-1", "BLOCKED"), note: "which db?" };
    const out = renderStatus([blocked], plain, "running (pid 42)");
    expect(out).toContain("cmux send --workspace frontyard-tig-1");
    expect(out).toContain("which db?");
  });

  it("reassures when nothing needs you and nothing is ready", () => {
    const out = renderStatus(
      [wt("frontyard-tig-1", "IMPLEMENTING")],
      plain,
      "running (pid 42)"
    );
    expect(out).toContain("all worktrees flowing");
  });
});
