import { describe, expect, it } from "vitest";

import { filterHistory, resolveTargets } from "./commands";
import type { FleetState, HistoryRecord, Stage } from "./types";

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

const rec = (name: string, ts: number, workspaceId = name): HistoryRecord => ({
  event: "Stop",
  from: "IMPLEMENTING",
  kind: "advance",
  name,
  seq: ts,
  to: "SIMPLIFY",
  ts,
  workspaceId,
});

describe("filterHistory", () => {
  const log = [
    rec("frontyard-tig-430", 100, "ws-a"),
    rec("frontyard-tig-431", 200, "ws-b"),
    rec("frontyard-tig-430", 300, "ws-a"),
  ];

  it("returns the whole log when no filter is given", () => {
    expect(filterHistory(log, {}, 1000)).toHaveLength(3);
  });

  it("keeps only events newer than the --since window", () => {
    // now=1000, since 800s → cutoff 200, so ts 100 drops out.
    const out = filterHistory(log, { since: "800s" }, 1000);
    expect(out.map((r) => r.ts)).toEqual([200, 300]);
  });

  it("supports compound durations like 1h30m", () => {
    // 1h30m = 5400s; now=5500 → cutoff 100, so all three remain.
    expect(filterHistory(log, { since: "1h30m" }, 5500)).toHaveLength(3);
  });

  it("ignores an unparseable --since rather than dropping everything", () => {
    expect(filterHistory(log, { since: "soon" }, 1000)).toHaveLength(3);
  });

  it("narrows to a worktree by friendly substring", () => {
    const out = filterHistory(log, { ref: "tig-430" }, 1000);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.name === "frontyard-tig-430")).toBe(true);
  });

  it("narrows to a worktree by exact workspace id", () => {
    expect(filterHistory(log, { ref: "ws-b" }, 1000)).toHaveLength(1);
  });

  it("combines --since and --ref", () => {
    const out = filterHistory(log, { ref: "tig-430", since: "800s" }, 1000);
    expect(out.map((r) => r.ts)).toEqual([300]);
  });
});
