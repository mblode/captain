import { describe, expect, it } from "vitest";

import { computeGain, parseSince } from "./gain";
import type { GainInput } from "./gain";
import type { LogRecord } from "./log";
import type { Verdict } from "./verdict";
import type { FleetRow } from "./view";

// Pure unit tests for computeGain/parseSince — hand-built fixtures, no I/O, no
// clock read (now is injected), so the output is fully deterministic.

const DAY = 86_400;
// A fixed anchor so cadence day strings are stable. 2026-06-19T00:00:00Z.
const NOW = Math.floor(Date.parse("2026-06-19T12:00:00Z") / 1000);

const decision = (over: Partial<LogRecord> = {}): LogRecord => ({
  kind: "approve",
  name: "frontyard-tig-1",
  ts: NOW,
  ...over,
});

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  cwd: "/wt/tig-1",
  group: "in-flight",
  name: "frontyard-tig-1",
  run: "running",
  workspaceId: "ws-1",
  ...over,
});

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  criteria: [{ evidence: "x", name: "implements", pass: true }],
  issue: "TIG-1",
  rubricHash: "h",
  summary: "ok",
  ts: NOW,
  verdict: "pass",
  ...over,
});

const input = (over: Partial<GainInput> = {}): GainInput => ({
  log: [],
  now: NOW,
  rows: [],
  verdicts: [],
  ...over,
});

describe("computeGain — decisions", () => {
  it("tallies approvals, rejections, and approval rate", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "approve" }),
          decision({ kind: "approve" }),
          decision({ kind: "approve" }),
          decision({ kind: "reject", note: "split it" }),
        ],
      })
    );
    expect(m.decisions.approvals).toBe(3);
    expect(m.decisions.rejections).toBe(1);
    expect(m.decisions.approvalRate).toBeCloseTo(0.75);
  });

  it("approvalRate is 0 (never NaN) with no decisions", () => {
    const m = computeGain(input());
    expect(m.decisions.approvals).toBe(0);
    expect(m.decisions.rejections).toBe(0);
    expect(m.decisions.approvalRate).toBe(0);
  });

  it("recentRejectReasons carries notes, newest first, and is bounded to 5", () => {
    const decisions: LogRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      decisions.push(
        decision({ kind: "reject", note: `note ${i}`, ts: NOW - i * 60 })
      );
    }
    const m = computeGain(input({ log: decisions }));
    expect(m.decisions.recentRejectReasons).toHaveLength(5);
    // newest (ts = NOW, i=0) first
    expect(m.decisions.recentRejectReasons[0].note).toBe("note 0");
    expect(m.decisions.recentRejectReasons[0].ts).toBe(NOW);
  });

  it("a reject with no note surfaces an empty note string, not undefined", () => {
    const m = computeGain(
      input({ log: [decision({ kind: "reject", note: undefined })] })
    );
    expect(m.decisions.recentRejectReasons[0].note).toBe("");
  });

  it("counts unnoted approvals as unexplained and lists the noted ones", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "approve", note: "low risk, scope matches" }),
          decision({ kind: "approve" }),
          decision({ kind: "approve" }),
          decision({ kind: "reject", note: "split it" }),
        ],
      })
    );
    expect(m.decisions.unexplainedApprovals).toBe(2);
    expect(m.decisions.recentApprovalReasons).toHaveLength(1);
    expect(m.decisions.recentApprovalReasons?.[0].note).toBe(
      "low risk, scope matches"
    );
  });

  // The backward-compat contract: a ledger written before --note existed must
  // not report every historical approval as a governance failure.
  it("omits the unexplained-approval block entirely when no approval was ever noted", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "approve" }),
          decision({ kind: "reject", note: "split it" }),
        ],
      })
    );
    expect(m.decisions.unexplainedApprovals).toBeUndefined();
    expect(m.decisions.recentApprovalReasons).toBeUndefined();
    expect(m.caveats.some((c) => c.includes("unexplained approvals"))).toBe(
      false
    );
  });

  // The probe runs over the FULL log (like launches) but the count respects the
  // window — so a window holding only unnoted approvals still reports them.
  it("reports the block once any approval is noted, even outside the window", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "approve", note: "reviewed", ts: NOW - 10 * DAY }),
          decision({ kind: "approve", ts: NOW }),
        ],
        since: NOW - 7 * DAY,
      })
    );
    expect(m.decisions.unexplainedApprovals).toBe(1);
    expect(m.decisions.recentApprovalReasons).toEqual([]);
    expect(m.caveats.some((c) => c.includes("unexplained approvals"))).toBe(
      true
    );
  });

  it("a whitespace-only note is not a rationale", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "approve", note: "reviewed" }),
          decision({ kind: "approve", note: "   " }),
        ],
      })
    );
    expect(m.decisions.unexplainedApprovals).toBe(1);
    expect(m.decisions.recentApprovalReasons).toHaveLength(1);
  });

  it("recentApprovalReasons is newest first and bounded to 5", () => {
    const decisions: LogRecord[] = [];
    for (let i = 0; i < 8; i += 1) {
      decisions.push(
        decision({ kind: "approve", note: `card ${i}`, ts: NOW - i * 60 })
      );
    }
    const m = computeGain(input({ log: decisions }));
    expect(m.decisions.recentApprovalReasons).toHaveLength(5);
    expect(m.decisions.recentApprovalReasons?.[0].note).toBe("card 0");
    expect(m.decisions.recentApprovalReasons?.[0].ts).toBe(NOW);
  });

  it("buckets cadence by UTC day, sorted ascending", () => {
    const m = computeGain(
      input({
        log: [
          decision({
            ts: Math.floor(Date.parse("2026-06-17T01:00:00Z") / 1000),
          }),
          decision({
            ts: Math.floor(Date.parse("2026-06-17T23:00:00Z") / 1000),
          }),
          decision({
            ts: Math.floor(Date.parse("2026-06-18T05:00:00Z") / 1000),
          }),
        ],
      })
    );
    expect(m.decisions.cadence).toEqual([
      { count: 2, day: "2026-06-17" },
      { count: 1, day: "2026-06-18" },
    ]);
  });

  it("since filters decision-based metrics and records the window", () => {
    const m = computeGain(
      input({
        log: [
          // 10 days old: outside the 7-day window
          decision({ kind: "approve", ts: NOW - 10 * DAY }),
          // 1 day old and right now: inside the window
          decision({ kind: "approve", ts: NOW - 1 * DAY }),
          decision({ kind: "reject", ts: NOW }),
        ],
        since: NOW - 7 * DAY,
      })
    );
    expect(m.decisions.approvals).toBe(1);
    expect(m.decisions.rejections).toBe(1);
    expect(m.decisions.window).toEqual({ since: NOW - 7 * DAY });
  });

  it("omits the window when no since is given", () => {
    expect(computeGain(input()).decisions.window).toBeUndefined();
  });
});

describe("computeGain — fleet", () => {
  it("counts each group and grands a total", () => {
    const m = computeGain(
      input({
        rows: [
          row({ group: "needs-you" }),
          row({ group: "needs-you" }),
          row({ group: "in-flight" }),
          row({ group: "ready" }),
        ],
      })
    );
    expect(m.fleet).toMatchObject({
      inFlight: 1,
      needsYou: 2,
      ready: 1,
      total: 4,
    });
  });

  it("groups byRepo (worst-populated first), defaulting a missing repo to '?'", () => {
    const m = computeGain(
      input({
        rows: [
          row({ repo: "linkiq" }),
          row({ repo: "linkiq" }),
          row({ repo: "frontyard" }),
          row({ repo: undefined }),
        ],
      })
    );
    expect(m.fleet.byRepo).toEqual([
      { repo: "linkiq", total: 2 },
      { repo: "?", total: 1 },
      { repo: "frontyard", total: 1 },
    ]);
  });
});

describe("computeGain — verdicts", () => {
  it("counts pass/fail and tallies failing criteria by name (worst first)", () => {
    const m = computeGain(
      input({
        verdicts: [
          { verdict: verdict({ verdict: "pass" }) },
          {
            verdict: verdict({
              criteria: [
                { evidence: "", name: "tests pass", pass: false },
                { evidence: "", name: "lint clean", pass: false },
              ],
              verdict: "fail",
            }),
          },
          {
            verdict: verdict({
              criteria: [{ evidence: "", name: "tests pass", pass: false }],
              verdict: "fail",
            }),
          },
        ],
      })
    );
    expect(m.verdicts.pass).toBe(1);
    expect(m.verdicts.fail).toBe(2);
    expect(m.verdicts.failingCriteria).toEqual([
      { count: 2, name: "tests pass" },
      { count: 1, name: "lint clean" },
    ]);
  });

  it("collects open PR urls from verdicts that carry them", () => {
    const m = computeGain(
      input({
        verdicts: [
          { verdict: verdict({ prUrl: "https://x/pr/1" }) },
          { verdict: verdict({ prUrl: undefined }) },
          { verdict: verdict({ prUrl: "https://x/pr/2" }) },
        ],
      })
    );
    expect(m.verdicts.openPrs).toEqual(["https://x/pr/1", "https://x/pr/2"]);
  });
});

describe("computeGain — merged + caveats", () => {
  it("omits merged when not supplied, includes it (and its caveat) when supplied", () => {
    expect(computeGain(input()).merged).toBeUndefined();
    const m = computeGain(input({ merged: [{ count: 5, repo: "linkiq" }] }));
    expect(m.merged).toEqual([{ count: 5, repo: "linkiq" }]);
    expect(m.caveats.some((c) => c.includes("--git"))).toBe(true);
  });

  it("caveats are ALWAYS present and name the snapshot/ledger distinction", () => {
    const m = computeGain(input());
    expect(m.caveats.length).toBeGreaterThan(0);
    expect(m.caveats.some((c) => c.includes("LIVE SNAPSHOT"))).toBe(true);
    expect(m.caveats.some((c) => c.toLowerCase().includes("ledger"))).toBe(
      true
    );
    // the explicit non-goal: no operation-level throughput by design
    expect(m.caveats.some((c) => c.toLowerCase().includes("throughput"))).toBe(
      true
    );
  });

  it("is deterministic given the same input (injected now)", () => {
    const fixture = input({
      log: [decision(), decision({ kind: "reject" })],
      rows: [row({ group: "ready", repo: "x" })],
      verdicts: [{ verdict: verdict() }],
    });
    expect(computeGain(fixture)).toEqual(computeGain(fixture));
  });
});

describe("computeGain — latency to detection", () => {
  const launch = (over: Partial<LogRecord> = {}): LogRecord => ({
    kind: "launch",
    name: "frontyard-tig-1",
    ts: NOW - 3600,
    ...over,
  });

  it("joins each decision to the most recent prior same-name launch", () => {
    const m = computeGain(
      input({
        log: [
          // relaunched: the decision must measure from the SECOND launch
          launch({ ts: NOW - 7200 }),
          launch({ ts: NOW - 600 }),
          decision({ ts: NOW }),
        ],
      })
    );
    expect(m.latency?.toDecision).toEqual({
      count: 1,
      maxSec: 600,
      medianSec: 600,
    });
  });

  it("a decision with no prior launch (or a mismatched name) carries no sample", () => {
    const m = computeGain(
      input({
        log: [
          launch({ name: "other-tig-9" }),
          // launch AFTER the decision never pairs
          launch({ ts: NOW + 60 }),
          decision({ ts: NOW }),
        ],
      })
    );
    expect(m.latency).toBeUndefined();
  });

  it("launch records never inflate decision tallies or cadence", () => {
    const m = computeGain(
      input({ log: [launch(), launch(), decision({ kind: "approve" })] })
    );
    expect(m.decisions.approvals).toBe(1);
    expect(m.decisions.rejections).toBe(0);
    expect(m.decisions.cadence).toEqual([{ count: 1, day: "2026-06-19" }]);
  });

  it("a pre-window launch still pairs an in-window decision", () => {
    const m = computeGain(
      input({
        log: [launch({ ts: NOW - 10 * DAY }), decision({ ts: NOW })],
        since: NOW - 7 * DAY,
      })
    );
    expect(m.latency?.toDecision?.count).toBe(1);
    expect(m.latency?.toDecision?.maxSec).toBe(10 * DAY);
  });

  it("derives launch→verdict from named verdict entries, skipping untrusted ts", () => {
    const m = computeGain(
      input({
        log: [launch({ ts: NOW - 900 })],
        verdicts: [
          { name: "frontyard-tig-1", verdict: verdict({ ts: NOW }) },
          // parseVerdict defaults a missing ts to 0 — never a sample
          { name: "frontyard-tig-1", verdict: verdict({ ts: 0 }) },
          // unnamed entries can't join
          { verdict: verdict({ ts: NOW }) },
        ],
      })
    );
    expect(m.latency?.toVerdict).toEqual({
      count: 1,
      maxSec: 900,
      medianSec: 900,
    });
    expect(m.latency?.toDecision).toBeUndefined();
  });

  it("since windows verdict samples symmetrically with decisions", () => {
    const m = computeGain(
      input({
        log: [launch({ ts: NOW - 10 * DAY - 900 })],
        since: NOW - 7 * DAY,
        verdicts: [
          {
            name: "frontyard-tig-1",
            verdict: verdict({ ts: NOW - 10 * DAY }),
          },
        ],
      })
    );
    expect(m.latency).toBeUndefined();
  });

  it("median is the middle sample, max the largest", () => {
    const m = computeGain(
      input({
        log: [
          launch({ name: "a-1", ts: NOW - 100 }),
          launch({ name: "b-2", ts: NOW - 300 }),
          launch({ name: "c-3", ts: NOW - 900 }),
          decision({ name: "a-1", ts: NOW }),
          decision({ name: "b-2", ts: NOW }),
          decision({ name: "c-3", ts: NOW }),
        ],
      })
    );
    expect(m.latency?.toDecision).toEqual({
      count: 3,
      maxSec: 900,
      medianSec: 300,
    });
  });

  it("names the latency join rules in the caveats", () => {
    const { caveats } = computeGain(input());
    expect(caveats.some((c) => c.includes("launch→decision"))).toBe(true);
    expect(caveats.some((c) => c.includes("launch→verdict"))).toBe(true);
  });
});

describe("computeGain — rework at the plan gate", () => {
  // No decision at all ⇒ no sample. Reporting "0 of 0 first pass" would read as
  // a measurement; the same rule already governs latency and approval notes.
  it("omits the block entirely when no ticket carries a decision", () => {
    expect(computeGain(input()).rework).toBeUndefined();
    expect(
      computeGain(input({ log: [decision({ kind: "launch" })] })).rework
    ).toBeUndefined();
  });

  it("counts rejections per ticket NAME across the reject→relaunch cycle", () => {
    const m = computeGain(
      input({
        log: [
          // tig-1 came back twice before it was approved
          decision({ kind: "launch", name: "frontyard-tig-1", ts: NOW - 500 }),
          decision({ kind: "reject", name: "frontyard-tig-1", ts: NOW - 400 }),
          decision({ kind: "launch", name: "frontyard-tig-1", ts: NOW - 300 }),
          decision({ kind: "reject", name: "frontyard-tig-1", ts: NOW - 200 }),
          decision({ kind: "launch", name: "frontyard-tig-1", ts: NOW - 100 }),
          decision({ kind: "approve", name: "frontyard-tig-1", ts: NOW }),
          // tig-2 cleared the gate on its first plan
          decision({ kind: "launch", name: "frontyard-tig-2", ts: NOW - 500 }),
          decision({ kind: "approve", name: "frontyard-tig-2", ts: NOW }),
        ],
      })
    );
    expect(m.rework).toEqual({
      firstPass: 1,
      firstPassRate: 0.5,
      tickets: 2,
      topReworked: [{ name: "frontyard-tig-1", rejections: 2 }],
    });
  });

  // Uncapped, like failingCriteria — six entries in, six entries out.
  it("orders topReworked worst first and breaks ties by name", () => {
    const log: LogRecord[] = [];
    for (const [name, rejects] of [
      ["a", 1],
      ["b", 5],
      ["c", 3],
      ["d", 9],
      ["e", 3],
      ["f", 2],
    ] as [string, number][]) {
      for (let i = 0; i < rejects; i += 1) {
        log.push(decision({ kind: "reject", name, ts: NOW - i }));
      }
    }
    const m = computeGain(input({ log }));
    expect(m.rework?.tickets).toBe(6);
    expect(m.rework?.firstPass).toBe(0);
    expect(m.rework?.topReworked).toEqual([
      { name: "d", rejections: 9 },
      { name: "b", rejections: 5 },
      // 3 each: the tie breaks alphabetically
      { name: "c", rejections: 3 },
      { name: "e", rejections: 3 },
      { name: "f", rejections: 2 },
      { name: "a", rejections: 1 },
    ]);
  });

  // The window picks the TICKET SET, not which cycles count: a ticket whose
  // earlier rejections fell outside it is not a first pass, and reporting it as
  // one inflates the headline rate in the flattering direction.
  it("counts cycles from before the window against an in-window ticket", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "reject", name: "slow", ts: NOW - 10 * DAY }),
          decision({ kind: "reject", name: "slow", ts: NOW - 9 * DAY }),
          decision({ kind: "approve", name: "slow", ts: NOW }),
        ],
        since: NOW - DAY,
      })
    );
    expect(m.rework).toEqual({
      firstPass: 0,
      firstPassRate: 0,
      tickets: 1,
      topReworked: [{ name: "slow", rejections: 2 }],
    });
  });

  it("respects the --since window", () => {
    const m = computeGain(
      input({
        log: [
          decision({ kind: "reject", name: "old", ts: NOW - 10 * DAY }),
          decision({ kind: "approve", name: "new", ts: NOW }),
        ],
        since: NOW - DAY,
      })
    );
    expect(m.rework).toEqual({
      firstPass: 1,
      firstPassRate: 1,
      tickets: 1,
      topReworked: [],
    });
  });

  it("always states what rework is and is not", () => {
    expect(computeGain(input()).caveats.join("\n")).toContain(
      "cycles at the gate, not post-merge rework"
    );
  });
});

describe("parseSince", () => {
  it("parses relative days/hours/minutes against now", () => {
    expect(parseSince("7d", NOW)).toBe(NOW - 7 * DAY);
    expect(parseSince("24h", NOW)).toBe(NOW - 24 * 3600);
    expect(parseSince("30m", NOW)).toBe(NOW - 30 * 60);
  });

  it("parses an ISO date to an epoch-seconds floor", () => {
    expect(parseSince("2026-06-01", NOW)).toBe(
      Math.floor(Date.parse("2026-06-01") / 1000)
    );
  });

  it("returns undefined for empty or unparseable input", () => {
    expect(parseSince(undefined, NOW)).toBeUndefined();
    expect(parseSince("", NOW)).toBeUndefined();
    expect(parseSince("not-a-date", NOW)).toBeUndefined();
  });
});

describe("computeGain roster", () => {
  it("joins a launch to its live row and its decision", () => {
    const m = computeGain(
      input({
        log: [
          { kind: "launch", name: "frontyard-tig-1", ts: NOW - 3600 },
          decision({ note: "scoped tightly", ts: NOW - 1800 }),
        ],
        rows: [
          row({
            group: "ready",
            prUrl: "https://gh/pr/1",
            repo: "frontyard",
            summary: "all criteria pass",
            title: "Fix the Pulse recommendation copy",
            verdict: "pass",
          }),
        ],
      })
    );
    expect(m.roster.entries).toEqual([
      {
        decidedAt: NOW - 1800,
        decision: "approve",
        group: "ready",
        launchedAt: NOW - 3600,
        live: true,
        name: "frontyard-tig-1",
        note: "scoped tightly",
        prUrl: "https://gh/pr/1",
        repo: "frontyard",
        summary: "all criteria pass",
        title: "Fix the Pulse recommendation copy",
        verdict: "pass",
      },
    ]);
    expect(m.roster.dropped).toBe(0);
  });

  // The point of driving the roster off the ledger: "all the work that was done"
  // is mostly work whose worktree is already merged and removed.
  it("keeps a finished worktree, degraded to its ledger half", () => {
    const m = computeGain(
      input({
        log: [
          { kind: "launch", name: "frontyard-tig-9", ts: NOW - 7200 },
          decision({ name: "frontyard-tig-9", ts: NOW - 7000 }),
        ],
        rows: [],
      })
    );
    expect(m.roster.entries).toEqual([
      {
        decidedAt: NOW - 7000,
        decision: "approve",
        launchedAt: NOW - 7200,
        live: false,
        name: "frontyard-tig-9",
      },
    ]);
  });

  // A live worktree launched before launch-logging existed has no ledger entry.
  // Inventing a roster row for it would fabricate a launch time.
  it("never fabricates an entry for a row with no launch record", () => {
    const m = computeGain(input({ log: [], rows: [row()] }));
    expect(m.roster.entries).toEqual([]);
  });

  // The reject->relaunch cycle `captain reject` exists to drive. Attributing by
  // "newest decision after this launch" gave the FIRST launch the SECOND
  // launch's approval, so the rejection vanished and the driver reported a run
  // as approved that had been sent back.
  it("gives a relaunched ticket's earlier run its own decision", () => {
    const m = computeGain(
      input({
        log: [
          { kind: "launch", name: "frontyard-tig-1", ts: NOW - 400 },
          decision({ kind: "reject", note: "wrong scope", ts: NOW - 300 }),
          { kind: "launch", name: "frontyard-tig-1", ts: NOW - 200 },
          decision({ kind: "approve", note: "looks good", ts: NOW - 100 }),
        ],
      })
    );
    expect(
      m.roster.entries.map((e) => [e.launchedAt, e.decision, e.note])
    ).toEqual([
      [NOW - 200, "approve", "looks good"],
      [NOW - 400, "reject", "wrong scope"],
    ]);
  });

  it("attaches only a decision at or after the launch", () => {
    const m = computeGain(
      input({
        log: [
          // a decision from an EARLIER run of the same ticket
          decision({ ts: NOW - 9000 }),
          { kind: "launch", name: "frontyard-tig-1", ts: NOW - 3600 },
        ],
      })
    );
    expect(m.roster.entries[0].decision).toBeUndefined();
    expect(m.roster.entries[0].launchedAt).toBe(NOW - 3600);
  });

  it("orders newest first and windows with --since", () => {
    const m = computeGain(
      input({
        log: [
          { kind: "launch", name: "old", ts: NOW - 5 * DAY },
          { kind: "launch", name: "mid", ts: NOW - 2 * DAY },
          { kind: "launch", name: "new", ts: NOW - 60 },
        ],
        since: NOW - 3 * DAY,
      })
    );
    expect(m.roster.entries.map((e) => e.name)).toEqual(["new", "mid"]);
  });

  // AGENTS.md: no silent caps — what the bound leaves out is reported.
  it("caps the roster and reports what it dropped", () => {
    const m = computeGain(
      input({
        log: Array.from({ length: 60 }, (_, i) => ({
          kind: "launch" as const,
          name: `t-${i}`,
          ts: NOW - i * 60,
        })),
      })
    );
    expect(m.roster.entries).toHaveLength(50);
    expect(m.roster.dropped).toBe(10);
    // newest first, so the oldest ten are the ones left out
    expect(m.roster.entries[0].name).toBe("t-0");
  });

  it("names the ledger-vs-snapshot split in the caveats", () => {
    const m = computeGain(input());
    expect(m.caveats.join("\n")).toContain(
      "title, group, verdict and prUrl are a live snapshot"
    );
  });
});
