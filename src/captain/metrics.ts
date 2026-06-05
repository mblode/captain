import type {
  FleetMetrics,
  HistoryRecord,
  Stage,
  StageMetric,
  Worktree,
} from "./types";

// Stages the watcher auto-advances through (a Stop here injects the next command).
export const ADVANCING_STAGES = new Set<Stage>([
  "IMPLEMENTING",
  "SIMPLIFY",
  "REVIEW",
  "PR_OPEN",
]);

// Stages that mean the agent got a PR open — a "run" reached the finish line.
const PR_READY_STAGES = new Set<Stage>(["BABYSITTING", "READY_TO_MERGE"]);

const median = (xs: number[]): number => {
  if (xs.length === 0) {
    return 0;
  }
  const sorted = [...xs].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
};

const bump = (m: Map<Stage, number>, k: Stage): void => {
  m.set(k, (m.get(k) ?? 0) + 1);
};

// A block = the agent parked on a question/needs-input gate (not a routine plan gate).
const isBlock = (r: HistoryRecord): boolean =>
  r.kind === "gate" && (r.gate === "question" || r.gate === "needs-input");

// Group the log by worktree, each list sorted into chronological order.
const groupByWs = (history: HistoryRecord[]): Map<string, HistoryRecord[]> => {
  const byWs = new Map<string, HistoryRecord[]>();
  for (const r of history) {
    const list = byWs.get(r.workspaceId) ?? [];
    list.push(r);
    byWs.set(r.workspaceId, list);
  }
  for (const list of byWs.values()) {
    list.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  }
  return byWs;
};

// Per-stage duration samples: the closed interval between consecutive records (a
// record's `to` marks stage entry), plus the still-open interval for each live
// worktree folded from `since` — so the current stage counts without double-count.
const collectDurations = (
  byWs: Map<string, HistoryRecord[]>,
  worktrees: Worktree[],
  nowSec: number
): Map<Stage, number[]> => {
  const samples = new Map<Stage, number[]>();
  const add = (stage: Stage, sec: number): void => {
    if (sec < 0) {
      return;
    }
    const list = samples.get(stage) ?? [];
    list.push(sec);
    samples.set(stage, list);
  };
  for (const list of byWs.values()) {
    for (const [i, rec] of list.entries()) {
      const next = list[i + 1];
      if (next) {
        add(rec.to, next.ts - rec.ts);
      }
    }
  }
  for (const wt of worktrees) {
    add(wt.stage, nowSec - wt.since);
  }
  return samples;
};

interface Tally {
  prReadyWs: Set<string>;
  rejectedWs: Set<string>;
  blockedWs: Set<string>;
  advancesBy: Map<Stage, number>;
  reworksBy: Map<Stage, number>;
  plans: number;
  rejects: number;
  blocks: number;
  advances: number;
}

// Count interventions and per-stage advance/rework tallies in one pass. A rework
// is a busy-defer, or a block that fired while still in an advancing stage — both
// feed the self-tuning policy's view of how reliably a stage advances.
const tally = (history: HistoryRecord[]): Tally => {
  const t: Tally = {
    advances: 0,
    advancesBy: new Map(),
    blockedWs: new Set(),
    blocks: 0,
    plans: 0,
    prReadyWs: new Set(),
    rejectedWs: new Set(),
    rejects: 0,
    reworksBy: new Map(),
  };
  for (const r of history) {
    if (PR_READY_STAGES.has(r.to)) {
      t.prReadyWs.add(r.workspaceId);
    }
    if (r.kind === "advance") {
      t.advances += 1;
      bump(t.advancesBy, r.from);
    } else if (r.kind === "rework") {
      bump(t.reworksBy, r.from);
    } else if (r.kind === "reject") {
      t.rejects += 1;
      t.rejectedWs.add(r.workspaceId);
    } else if (r.kind === "gate" && r.gate === "plan") {
      t.plans += 1;
    } else if (isBlock(r)) {
      t.blocks += 1;
      t.blockedWs.add(r.workspaceId);
      if (ADVANCING_STAGES.has(r.from)) {
        bump(t.reworksBy, r.from);
      }
    }
  }
  return t;
};

const rollupStages = (
  samples: Map<Stage, number[]>,
  t: Tally
): Partial<Record<Stage, StageMetric>> => {
  const stages: Partial<Record<Stage, StageMetric>> = {};
  const keys = new Set<Stage>([
    ...samples.keys(),
    ...t.advancesBy.keys(),
    ...t.reworksBy.keys(),
  ]);
  for (const stage of keys) {
    const xs = samples.get(stage) ?? [];
    stages[stage] = {
      advances: t.advancesBy.get(stage) ?? 0,
      count: xs.length,
      medianSec: median(xs),
      reworks: t.reworksBy.get(stage) ?? 0,
      totalSec: xs.reduce((a, b) => a + b, 0),
    };
  }
  return stages;
};

// Pure: roll the audit log + live state into the whole-fleet measurement view.
export const computeMetrics = (
  history: HistoryRecord[],
  worktrees: Worktree[],
  nowSec: number
): FleetMetrics => {
  const byWs = groupByWs(history);
  const samples = collectDurations(byWs, worktrees, nowSec);
  const t = tally(history);
  for (const wt of worktrees) {
    if (PR_READY_STAGES.has(wt.stage)) {
      t.prReadyWs.add(wt.workspaceId);
    }
  }

  const runs = new Set<string>([
    ...byWs.keys(),
    ...worktrees.map((w) => w.workspaceId),
  ]).size;
  const autonomousRuns = [...t.prReadyWs].filter(
    (id) => !(t.rejectedWs.has(id) || t.blockedWs.has(id))
  ).length;
  const total = t.plans + t.rejects + t.blocks;
  const firstTs = history.length
    ? Math.min(...history.map((r) => r.ts))
    : nowSec;
  const windowDays = (nowSec - firstTs) / 86_400;

  return {
    autonomousRuns,
    autonomyRate: t.prReadyWs.size ? autonomousRuns / t.prReadyWs.size : 0,
    interventionRate: t.advances ? total / t.advances : 0,
    interventions: {
      blocks: t.blocks,
      plans: t.plans,
      rejects: t.rejects,
      total,
    },
    prsReady: t.prReadyWs.size,
    runs,
    stages: rollupStages(samples, t),
    throughputPerDay: windowDays > 0 ? t.prReadyWs.size / windowDays : 0,
  };
};
