// 100% PURE (lint-enforced: no fs/subprocess). `captain gain`: what the weekly
// review reads. Counted from the task files and the project's log, both of
// which are complete history, so nothing here is a live snapshot.

import type { LogRecord } from "./captain/log";
import type { Harness, Task, TaskState } from "./task";

// Epoch-seconds floor for a "since" spec: "7d" / "24h" / "30m" relative to now,
// or an ISO date. Unparseable means no window, so a typo reports everything
// rather than silently reporting nothing.
export const parseSince = (
  s: string | undefined,
  now: number
): number | undefined => {
  if (!s) {
    return undefined;
  }
  const rel = /^(\d+)\s*([dhm])$/iu.exec(s.trim());
  if (rel) {
    const perUnit: Record<string, number> = { d: 86_400, h: 3600, m: 60 };
    return now - Number(rel[1]) * (perUnit[rel[2].toLowerCase()] ?? 60);
  }
  const ms = Date.parse(s.trim());
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
};

export interface GainInput {
  log: LogRecord[];
  tasks: Task[];
  now: number;
  since?: string;
}

export interface GainMetrics {
  window?: { since: number };
  // the task list right now
  tasks: Record<TaskState, number>;
  // log events inside the window
  started: number;
  done: number;
  dropped: number;
  approvals: number;
  rejections: number;
  // approvals recorded without a --note: was the reason written down?
  unexplainedApprovals: number;
  // of the tasks with a plan decision in the window, the share never rejected.
  // Omitted when there is no decision to measure.
  firstPassRate?: number;
  // median seconds from first start to done, for tasks done in the window.
  // Omitted when no task has both.
  medianCycleSec?: number;
  // starts and completions per harness, to tune which harness gets what
  byHarness: { harness: string; started: number; done: number }[];
}

const median = (values: number[]): number | undefined => {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// A start record's note is "<harness> <model> <effort>".
const harnessOf = (r: LogRecord): string => (r.note ?? "").split(" ")[0] || "?";

export const computeGain = (input: GainInput): GainMetrics => {
  const floor = parseSince(input.since, input.now);
  const inWindow = input.log.filter(
    (r) => floor === undefined || r.ts >= floor
  );
  const of = (kind: LogRecord["kind"]): LogRecord[] =>
    inWindow.filter((r) => r.kind === kind);

  const decided = new Map<string, boolean>();
  for (const r of inWindow) {
    if (r.kind === "approve" || r.kind === "reject") {
      decided.set(
        r.name,
        (decided.get(r.name) ?? true) && r.kind === "approve"
      );
    }
  }
  const firstPass = [...decided.values()].filter(Boolean).length;

  const firstStart = new Map<string, number>();
  for (const r of input.log) {
    if (r.kind === "start" && !firstStart.has(r.name)) {
      firstStart.set(r.name, r.ts);
    }
  }
  const cycles = of("done")
    .map((r) => {
      const began = firstStart.get(r.name);
      return began === undefined ? undefined : r.ts - began;
    })
    .filter((n): n is number => n !== undefined && n >= 0);

  const taskHarness = new Map(input.tasks.map((t) => [t.id, t.harness]));
  const byHarness = new Map<string, { started: number; done: number }>();
  const bump = (h: string, key: "started" | "done"): void => {
    const entry = byHarness.get(h) ?? { done: 0, started: 0 };
    entry[key] += 1;
    byHarness.set(h, entry);
  };
  for (const r of of("start")) {
    bump(harnessOf(r), "started");
  }
  for (const r of of("done")) {
    bump(taskHarness.get(r.name) ?? ("?" as Harness), "done");
  }

  const counts = { active: 0, done: 0, dropped: 0, todo: 0 };
  for (const t of input.tasks) {
    counts[t.state] += 1;
  }

  const approvals = of("approve");
  const cycle = median(cycles);
  return {
    approvals: approvals.length,
    byHarness: [...byHarness.entries()]
      .map(([harness, v]) => ({ harness, ...v }))
      .toSorted((a, b) => a.harness.localeCompare(b.harness)),
    done: of("done").length,
    dropped: of("drop").length,
    firstPassRate:
      decided.size > 0
        ? Math.round((firstPass / decided.size) * 100) / 100
        : undefined,
    medianCycleSec: cycle,
    rejections: of("reject").length,
    started: of("start").length,
    tasks: counts,
    unexplainedApprovals: approvals.filter((r) => !r.note?.trim()).length,
    window: floor === undefined ? undefined : { since: floor },
  };
};
