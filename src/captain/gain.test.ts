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
  decisions: [],
  now: NOW,
  rows: [],
  verdicts: [],
  ...over,
});

describe("computeGain — decisions", () => {
  it("tallies approvals, rejections, and approval rate", () => {
    const m = computeGain(
      input({
        decisions: [
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
    const m = computeGain(input({ decisions }));
    expect(m.decisions.recentRejectReasons).toHaveLength(5);
    // newest (ts = NOW, i=0) first
    expect(m.decisions.recentRejectReasons[0].note).toBe("note 0");
    expect(m.decisions.recentRejectReasons[0].ts).toBe(NOW);
  });

  it("a reject with no note surfaces an empty note string, not undefined", () => {
    const m = computeGain(
      input({ decisions: [decision({ kind: "reject", note: undefined })] })
    );
    expect(m.decisions.recentRejectReasons[0].note).toBe("");
  });

  it("buckets cadence by UTC day, sorted ascending", () => {
    const m = computeGain(
      input({
        decisions: [
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
        decisions: [
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
      decisions: [decision(), decision({ kind: "reject" })],
      rows: [row({ group: "ready", repo: "x" })],
      verdicts: [{ verdict: verdict() }],
    });
    expect(computeGain(fixture)).toEqual(computeGain(fixture));
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
