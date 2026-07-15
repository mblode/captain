import { describe, expect, it } from "vitest";

import { fmtDuration, renderGain, renderStatus, style } from "./format";
import type { GainMetrics } from "./gain";
import type { FleetRow } from "./view";

const plain = style(false);

const metrics = (over: Partial<GainMetrics> = {}): GainMetrics => ({
  caveats: [
    "decisions are a true ledger",
    "fleet composition is a LIVE SNAPSHOT",
  ],
  decisions: {
    approvalRate: 0.5,
    approvals: 2,
    cadence: [{ count: 2, day: "2026-06-18" }],
    recentRejectReasons: [{ name: "tig-1", note: "split it", ts: 1000 }],
    rejections: 2,
  },
  fleet: {
    byRepo: [{ repo: "linkiq", total: 3 }],
    inFlight: 1,
    needsYou: 1,
    ready: 1,
    total: 3,
  },
  verdicts: {
    fail: 1,
    failingCriteria: [{ count: 1, name: "tests pass" }],
    openPrs: ["https://x/pr/1"],
    pass: 1,
  },
  ...over,
});

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  cwd: "/wt/tig-1",
  group: "in-flight",
  name: "frontyard-tig-1",
  run: "running",
  ticket: "tig-1",
  workspaceId: "ws-1",
  ...over,
});

describe("fmtDuration", () => {
  it("formats bare seconds", () => {
    expect(fmtDuration(30)).toBe("<1m");
    expect(fmtDuration(5 * 60)).toBe("5m");
    expect(fmtDuration((2 * 60 + 5) * 60)).toBe("2h5m");
  });

  it("switches to days past 48h so a week reads 7d, not 168h", () => {
    expect(fmtDuration(47 * 3600)).toBe("47h0m");
    expect(fmtDuration(5 * 86_400)).toBe("5d");
  });
});

describe("renderStatus", () => {
  it("guides the user when the fleet is empty", () => {
    const out = renderStatus([], plain);
    expect(out).toContain("no captain worktrees found");
    expect(out).toContain("captain fanout");
  });

  it("leads with NEEDS YOU and inlines the resolve command", () => {
    const out = renderStatus(
      [
        row(),
        row({
          gate: { id: "feed-1", kind: "plan" },
          group: "needs-you",
          name: "frontyard-tig-2",
          ticket: "tig-2",
          workspaceId: "ws-2",
        }),
      ],
      plain
    );
    expect(out).toContain("2 worktrees");
    expect(out).toContain("1 need you");
    expect(out.indexOf("NEEDS YOU")).toBeLessThan(out.indexOf("IN FLIGHT"));
    // The gate carries its own resolve command.
    expect(out).toContain("captain approve tig-2");
  });

  it("inlines a merge hint when a worktree is ready", () => {
    const out = renderStatus(
      [
        row({
          group: "ready",
          prUrl: "https://x/pr/1",
          run: "idle",
          verdict: "pass",
        }),
      ],
      plain
    );
    expect(out).toContain("gh pr merge https://x/pr/1 --squash");
    expect(out).toContain("✓ verified");
  });

  it("shows a pending placeholder for a ready worktree without a PR url", () => {
    const out = renderStatus(
      [row({ group: "ready", run: "idle", verdict: "pass" })],
      plain
    );
    expect(out).toContain("(PR url pending)");
    expect(out).not.toContain("gh pr merge");
  });

  it("inlines an answer hint for a blocked worktree, with the gate's hint", () => {
    const out = renderStatus(
      [
        row({
          gate: { hint: "which db?", id: "feed-q", kind: "question" },
          group: "needs-you",
        }),
      ],
      plain
    );
    expect(out).toContain("cmux send --workspace ws-1");
    expect(out).toContain("which db?");
  });

  it("addresses cmux hints by workspace UUID, not the display name", () => {
    const out = renderStatus(
      [
        row({
          gate: { id: "feed-1", kind: "plan" },
          group: "needs-you",
          workspaceId: "ws-uuid-487",
        }),
      ],
      plain
    );
    expect(out).toContain("cmux read-screen --workspace ws-uuid-487");
    expect(out).not.toContain("--workspace frontyard-tig-1");
  });

  it("tags rows with their repo when the fleet spans more than one", () => {
    const out = renderStatus(
      [
        row({ name: "a-tig-1", repo: "linkiq" }),
        row({
          name: "b-tig-2",
          repo: "notifications",
          workspaceId: "ws-2",
        }),
      ],
      plain
    );
    expect(out).toContain("linkiq");
    expect(out).toContain("notifications");
  });

  it("renders a merge-order overlap warning", () => {
    const out = renderStatus(
      [row({ group: "ready", run: "idle", verdict: "pass" })],
      plain,
      {
        overlaps: {
          "ws-1": "overlaps x on a.ts — merge one, rebase the other",
        },
      }
    );
    expect(out).toContain("overlaps x on a.ts");
  });

  it("reassures when nothing needs you and nothing is ready", () => {
    const out = renderStatus([row()], plain);
    expect(out).toContain("all worktrees flowing");
  });
});

describe("renderGain", () => {
  it("renders the sections in order: decisions, fleet, verdicts, then the caveats footer", () => {
    const out = renderGain(metrics(), plain);
    expect(out.indexOf("DECISIONS")).toBeLessThan(out.indexOf("FLEET"));
    expect(out.indexOf("FLEET")).toBeLessThan(out.indexOf("VERDICTS"));
    expect(out.indexOf("VERDICTS")).toBeLessThan(out.indexOf("notes:"));
  });

  it("renders the LATENCY section only when latency samples exist", () => {
    expect(renderGain(metrics(), plain)).not.toContain("LATENCY");
    const out = renderGain(
      metrics({
        latency: {
          toDecision: { count: 7, maxSec: 7500, medianSec: 720 },
          toVerdict: { count: 3, maxSec: 10_920, medianSec: 2460 },
        },
      }),
      plain
    );
    expect(out).toContain("LATENCY (launch → detection)");
    expect(out).toContain("launch→decision: median 12m · max 2h5m (n=7)");
    expect(out).toContain("launch→verdict: median 41m · max 3h2m (n=3)");
  });

  it("omits the MERGED section unless --git supplied merged counts", () => {
    expect(renderGain(metrics(), plain)).not.toContain("MERGED");
    expect(
      renderGain(metrics({ merged: [{ count: 3, repo: "linkiq" }] }), plain)
    ).toContain("MERGED");
  });

  it("shows a placeholder instead of a rate when no decisions are recorded", () => {
    const out = renderGain(
      metrics({
        decisions: {
          approvalRate: 0,
          approvals: 0,
          cadence: [],
          recentRejectReasons: [],
          rejections: 0,
        },
      }),
      plain
    );
    expect(out).toContain("no approve/reject decisions recorded yet");
    expect(out).not.toContain("approval rate");
  });

  it("always prints the honesty caveats as a footer", () => {
    const out = renderGain(metrics(), plain);
    for (const caveat of metrics().caveats) {
      expect(out).toContain(caveat);
    }
  });

  it("adds colour only when the style is coloured", () => {
    const coloured = renderGain(metrics(), style(true));
    const flat = renderGain(metrics(), plain);
    expect(flat).not.toContain("[");
    expect(coloured.length).toBeGreaterThan(flat.length);
  });
});
