import { describe, expect, it } from "vitest";

import { resolveTargets } from "./commands.js";
import type { FleetState, Stage } from "./types.js";

const state = (...rows: [string, string, Stage][]): FleetState => ({
  fleetId: "f1",
  updatedAt: 0,
  worktrees: Object.fromEntries(
    rows.map(([id, name, stage]) => [
      id,
      {
        agent: "claude" as const,
        cwd: `/repo/${name}`,
        name,
        retries: 0,
        since: 0,
        stage,
        workspaceId: id,
      },
    ])
  ),
});

describe("resolveTargets", () => {
  const s = state(
    ["ws-uuid-aaa", "frontyard-tig-430", "PLAN_READY"],
    ["ws-uuid-bbb", "frontyard-tig-431", "PLAN_READY"],
    ["ws-uuid-ccc", "frontyard-tig-449", "IMPLEMENTING"]
  );

  it('"all" returns every worktree in the stage', () => {
    const { matched } = resolveTargets(s, "all", "PLAN_READY");
    expect(matched.map((w) => w.name).toSorted()).toEqual([
      "frontyard-tig-430",
      "frontyard-tig-431",
    ]);
  });

  it("matches by friendly ticket substring, no uuid needed", () => {
    const { matched, unknown } = resolveTargets(
      s,
      "tig-430,tig-431",
      "PLAN_READY"
    );
    expect(matched.map((w) => w.name)).toEqual([
      "frontyard-tig-430",
      "frontyard-tig-431",
    ]);
    expect(unknown).toEqual([]);
  });

  it("matches by exact workspace id too", () => {
    const { matched } = resolveTargets(s, "ws-uuid-aaa", "PLAN_READY");
    expect(matched).toHaveLength(1);
  });

  it("reports unknown tokens and ignores wrong-stage worktrees", () => {
    const { matched, unknown } = resolveTargets(
      s,
      "tig-449,tig-999",
      "PLAN_READY"
    );
    // tig-449 is IMPLEMENTING (wrong stage); tig-999 doesn't exist.
    expect(matched).toHaveLength(0);
    expect(unknown).toEqual(["tig-449", "tig-999"]);
  });

  it("de-duplicates overlapping tokens", () => {
    const { matched } = resolveTargets(
      s,
      "tig-430,frontyard-tig-430",
      "PLAN_READY"
    );
    expect(matched).toHaveLength(1);
  });
});
