import { describe, expect, it } from "vitest";

import type { LogRecord } from "./captain/log";
import { computeGain, parseSince } from "./stats";
import type { Task } from "./task";

const NOW = 1_800_000_000;
const DAY = 86_400;

const task = (id: string, over: Partial<Task> = {}): Task => ({
  blockedBy: [],
  body: "",
  branch: "",
  created: "",
  effort: "",
  harness: "codex",
  id,
  model: "",
  risk: "low",
  source: "",
  state: "todo",
  title: id,
  worktree: "",
  ...over,
});

const rec = (
  kind: LogRecord["kind"],
  name: string,
  ts: number,
  note?: string
): LogRecord => ({ kind, name, note, ts });

describe("parseSince", () => {
  it("reads relative and absolute windows, and ignores garbage", () => {
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(parseSince("2026-01-01", NOW)).toBe(Date.parse("2026-01-01") / 1000);
    expect(parseSince("soon", NOW)).toBeUndefined();
  });
});

describe("computeGain", () => {
  const log = [
    rec("start", "a", NOW - 10 * DAY, "codex default medium"),
    rec("start", "b", NOW - 2 * DAY, "claude default high"),
    rec("approve", "b", NOW - 2 * DAY + 60),
    rec("reject", "c", NOW - DAY, "wrong table"),
    rec("approve", "c", NOW - DAY + 60, "fixed"),
    rec("done", "b", NOW - DAY),
    rec("done", "a", NOW - 3 * DAY),
    rec("drop", "d", NOW - 1),
  ];
  const tasks = [
    task("a", { state: "done" }),
    task("b", { harness: "claude", state: "done" }),
    task("c", { harness: "claude", state: "active" }),
    task("d", { state: "dropped" }),
  ];

  it("counts flow, decisions, first pass and cycle time", () => {
    const m = computeGain({ log, now: NOW, tasks });
    expect(m).toMatchObject({
      approvals: 2,
      done: 2,
      dropped: 1,
      firstPassRate: 0.5,
      rejections: 1,
      started: 2,
      tasks: { active: 1, done: 2, dropped: 1, todo: 0 },
      unexplainedApprovals: 1,
    });
    // a: 7 days, b: 1 day → median 4 days
    expect(m.medianCycleSec).toBe(4 * DAY);
    expect(m.byHarness).toEqual([
      { done: 1, harness: "claude", started: 1 },
      { done: 1, harness: "codex", started: 1 },
    ]);
  });

  it("windows the log but measures cycles from the first start ever", () => {
    const m = computeGain({ log, now: NOW, since: "5d", tasks });
    expect(m.started).toBe(1);
    expect(m.done).toBe(2);
    expect(m.window).toEqual({ since: NOW - 5 * DAY });
  });

  it("omits rates it has no sample for", () => {
    const m = computeGain({ log: [], now: NOW, tasks: [] });
    expect(m.firstPassRate).toBeUndefined();
    expect(m.medianCycleSec).toBeUndefined();
  });
});
