import { describe, expect, it } from "vitest";

import { fmtAge, groupOf, renderStatus, style } from "./format.js";
import type { Stage, Worktree } from "./types.js";

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
    const out = renderStatus("f1", [], plain);
    expect(out).toContain("no worktrees tracked yet");
  });

  it("leads with NEEDS YOU and surfaces the next action", () => {
    const out = renderStatus(
      "f1",
      [wt("tig-1", "IMPLEMENTING"), wt("tig-2", "PLAN_READY")],
      plain
    );
    expect(out).toContain("2 worktrees");
    expect(out).toContain("1 need you");
    // NEEDS YOU section comes before IN FLIGHT.
    expect(out.indexOf("NEEDS YOU")).toBeLessThan(out.indexOf("IN FLIGHT"));
    expect(out).toContain("captain gates --fleet f1");
  });

  it("points at merge when everything is ready", () => {
    const out = renderStatus("f1", [wt("tig-1", "READY_TO_MERGE")], plain);
    expect(out).toContain("captain ready --fleet f1");
  });
});
