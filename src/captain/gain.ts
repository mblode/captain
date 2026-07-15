// 100% PURE (lint-enforced: no fs/subprocess — like view.ts/verdict.ts) — the
// fleet-telemetry decision module. commands.ts gathers the inputs (the log, the
// live rows, the raw verdicts, optionally a `gh`-derived merged count); this
// module turns them into metrics by plain arithmetic and grouping. There is no
// persisted counter and no event stream: every number is derived on demand from
// reads, exactly like `status`.

import type { LogRecord } from "./log";
import type { Verdict } from "./verdict";
import { groupCounts } from "./view";
import type { FleetRow } from "./view";

// What commands.ts hands computeGain. `now`/`since` are epoch SECONDS to match
// log.ts (LogRecord.ts and verdict.ts are both seconds). `since` is injected so
// the window cut-off is testable; `now` is injected so cadence/age are
// deterministic.
export interface GainInput {
  // the full ledger — decisions AND launch records; computeGain partitions
  log: LogRecord[];
  rows: FleetRow[];
  // raw valid verdicts (hash-checked by the caller) for criteria-level detail;
  // `name` is the row identity, used to join launch→verdict latency
  verdicts: { repo?: string; name?: string; verdict: Verdict }[];
  // opt-in `--git` approximation; omitted entirely when not requested
  merged?: { repo: string; count: number }[];
  now: number;
  // epoch-seconds floor; when set, decision-based metrics count only ts >= since
  since?: number;
}

// One day's decision tally, for a sparkline-ish cadence view. `day` is the
// UTC calendar date (YYYY-MM-DD) the decisions fell on.
export interface CadenceDay {
  day: string;
  count: number;
}

// Latency-to-detection samples: how long a launch travelled before a human
// decision / a verifier verdict caught it. Median + max + sample count only.
export interface LatencyStats {
  count: number;
  medianSec: number;
  maxSec: number;
}

export interface GainMetrics {
  decisions: {
    approvals: number;
    rejections: number;
    // approvals / (approvals + rejections); 0 when there are no decisions
    approvalRate: number;
    // the most recent rejections with their notes (bounded), newest first
    recentRejectReasons: { name: string; note: string; ts: number }[];
    cadence: CadenceDay[];
    // present only when a --since window was applied (the epoch-seconds floor)
    window?: { since: number };
  };
  fleet: {
    needsYou: number;
    inFlight: number;
    ready: number;
    total: number;
    byRepo: { repo: string; total: number }[];
  };
  verdicts: {
    pass: number;
    fail: number;
    // criteria that failed, tallied by name across failing verdicts (worst
    // first) — where the verifier keeps catching the fleet
    failingCriteria: { name: string; count: number }[];
    openPrs: string[];
  };
  merged?: { repo: string; count: number }[];
  // launch→detection latency; omitted entirely when no sample joins
  latency?: { toDecision?: LatencyStats; toVerdict?: LatencyStats };
  // ALWAYS present — the honesty contract. These caveats name exactly what each
  // metric is and is not, so a reader (human or skill) never over-reads a live
  // snapshot as a trend.
  caveats: string[];
}

// How many recent reject reasons to surface — enough to spot a pattern, few
// enough to stay glanceable.
const RECENT_REJECTS = 5;

// PURE: epoch-seconds floor for a "since" spec. "7d"/"24h"/"30m" are relative
// to `now`; a bare ISO date ("2026-06-01") or datetime parses absolute.
// Anything unparseable → undefined (no window), so a typo degrades to "all
// history" rather than silently dropping every decision.
export const parseSince = (
  s: string | undefined,
  now: number
): number | undefined => {
  if (!s) {
    return undefined;
  }
  const rel = s.trim().match(/^(\d+)\s*([dhm])$/iu);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const perUnit: Record<string, number> = { d: 86_400, h: 3600, m: 60 };
    return now - n * (perUnit[unit] ?? 60);
  }
  const ms = Date.parse(s.trim());
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return Math.floor(ms / 1000);
};

// UTC calendar date (YYYY-MM-DD) for an epoch-seconds timestamp.
const dayOf = (ts: number): string =>
  new Date(ts * 1000).toISOString().slice(0, 10);

// The honesty contract, always present. Each line states exactly what a metric
// is — and refuses to claim what captain doesn't record. Order: the one true
// ledger first, then the snapshot caveats, then the opt-in + the non-goal.
const caveatsFor = (input: GainInput): string[] => {
  const lines = [
    "decisions (approvals/rejections) are gap-free per-machine history from log.jsonl — a true ledger",
    "fleet composition is a LIVE SNAPSHOT of cmux right now, not a trend over time",
    "verdict pass/fail is a live read of each worktree's verdict.json — overwritten per worktree, so it is not a historical ledger",
    "operation-level throughput (e.g. 'ops/day') is NOT recorded by design — captain keeps no event stream",
    "latency joins launch→decision/verdict records by name — decisions predating launch logging (or a cleared ledger) carry no sample",
    "launch→verdict latency is a live read of current verdict files, not a ledger",
  ];
  if (input.merged) {
    lines.push(
      "merged counts come from --git (gh/git), an opt-in approximation gathered at call time"
    );
  } else {
    lines.push("merged counts omitted — pass --git to approximate them via gh");
  }
  return lines;
};

// PURE: median/max over elapsed-seconds samples; undefined when empty so the
// caller can omit the whole stats block.
const latencyStats = (samples: number[]): LatencyStats | undefined => {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    maxSec: sorted.at(-1) ?? 0,
    medianSec: sorted[Math.floor((sorted.length - 1) / 2)],
  };
};

// The most recent launch of `name` at or before `ts` — the join rule for every
// latency sample. No prior launch (pre-feature history, name mismatch, cleared
// ledger) → undefined, and the event simply carries no sample.
const launchBefore = (
  launches: LogRecord[],
  name: string,
  ts: number
): number | undefined => {
  let best: number | undefined;
  for (const l of launches) {
    if (l.name === name && l.ts <= ts && (best === undefined || l.ts > best)) {
      best = l.ts;
    }
  }
  return best;
};

// PURE: derive every metric. No I/O, no clock read (now is injected) — given
// the same input it returns the same output, so the unit tests need no mocking.
export const computeGain = (input: GainInput): GainMetrics => {
  const inWindow = (ts: number): boolean =>
    input.since === undefined || ts >= input.since;
  // Launches are searched over the FULL log (a launch just before the window
  // must still pair its in-window decision); decisions respect the window.
  const launches = input.log.filter((r) => r.kind === "launch");
  const decisions = input.log.filter(
    (r) => r.kind !== "launch" && inWindow(r.ts)
  );

  const approvals = decisions.filter((d) => d.kind === "approve").length;
  const rejections = decisions.filter((d) => d.kind === "reject").length;
  const total = approvals + rejections;
  const approvalRate = total === 0 ? 0 : approvals / total;

  const recentRejectReasons = decisions
    .filter((d) => d.kind === "reject")
    .toSorted((a, b) => b.ts - a.ts)
    .slice(0, RECENT_REJECTS)
    .map((d) => ({ name: d.name, note: d.note ?? "", ts: d.ts }));

  const cadenceMap = new Map<string, number>();
  for (const d of decisions) {
    const day = dayOf(d.ts);
    cadenceMap.set(day, (cadenceMap.get(day) ?? 0) + 1);
  }
  const cadence = [...cadenceMap.entries()]
    .map(([day, count]) => ({ count, day }))
    .toSorted((a, b) => a.day.localeCompare(b.day));

  const repoMap = new Map<string, number>();
  for (const r of input.rows) {
    const repo = r.repo ?? "?";
    repoMap.set(repo, (repoMap.get(repo) ?? 0) + 1);
  }
  const byRepo = [...repoMap.entries()]
    .map(([repo, t]) => ({ repo, total: t }))
    .toSorted((a, b) => b.total - a.total || a.repo.localeCompare(b.repo));

  // Pass/fail off the verdict array (one row each); criteria detail needs the
  // raw verdict, so the failing-criteria tally walks the same source.
  const pass = input.verdicts.filter(
    (v) => v.verdict.verdict === "pass"
  ).length;
  const fail = input.verdicts.filter(
    (v) => v.verdict.verdict === "fail"
  ).length;
  const failMap = new Map<string, number>();
  for (const { verdict } of input.verdicts) {
    if (verdict.verdict !== "fail") {
      continue;
    }
    for (const c of verdict.criteria) {
      if (c.pass === false) {
        failMap.set(c.name, (failMap.get(c.name) ?? 0) + 1);
      }
    }
  }
  const failingCriteria = [...failMap.entries()]
    .map(([name, count]) => ({ count, name }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const openPrs = input.verdicts
    .map((v) => v.verdict.prUrl)
    .filter((url): url is string => typeof url === "string" && url.length > 0);

  // Latency to detection: how far did a launch travel before a human decision
  // (gap-free, from the ledger) / a verifier verdict (live snapshot) caught it?
  const toDecision = latencyStats(
    decisions.flatMap((d) => {
      const launched = launchBefore(launches, d.name, d.ts);
      return launched === undefined ? [] : [d.ts - launched];
    })
  );
  const toVerdict = latencyStats(
    input.verdicts.flatMap((v) => {
      // verdict.ts is agent-written and defaults to 0 when missing — untrusted,
      // so a zero/absent ts contributes no sample. The window applies to the
      // detection event (the verdict), symmetric with toDecision.
      if (!v.name || v.verdict.ts <= 0 || !inWindow(v.verdict.ts)) {
        return [];
      }
      const launched = launchBefore(launches, v.name, v.verdict.ts);
      return launched === undefined ? [] : [v.verdict.ts - launched];
    })
  );
  const latency =
    toDecision || toVerdict
      ? {
          ...(toDecision ? { toDecision } : {}),
          ...(toVerdict ? { toVerdict } : {}),
        }
      : undefined;

  const decisionsBlock: GainMetrics["decisions"] = {
    approvalRate,
    approvals,
    cadence,
    recentRejectReasons,
    rejections,
  };
  if (input.since !== undefined) {
    decisionsBlock.window = { since: input.since };
  }

  return {
    caveats: caveatsFor(input),
    decisions: decisionsBlock,
    fleet: {
      byRepo,
      ...groupCounts(input.rows),
      total: input.rows.length,
    },
    ...(latency ? { latency } : {}),
    ...(input.merged ? { merged: input.merged } : {}),
    verdicts: { fail, failingCriteria, openPrs, pass },
  };
};
