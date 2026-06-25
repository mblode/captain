import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../errors";
import { renderRubric } from "../rubric";
import { approve, gain, reject, resolveTargets, status } from "./commands";
import type {
  CmuxFeedItem,
  CmuxPort,
  CmuxWorkspace,
  RunState,
} from "./control";
import { appendLog } from "./log";
import type { FleetRow } from "./view";

const fleetRow = (over: Partial<FleetRow> = {}): FleetRow => ({
  cwd: "/wt/tig-1",
  group: "needs-you",
  name: "frontyard-tig-430",
  run: "idle",
  workspaceId: "ws-uuid-aaa",
  ...over,
});

describe("resolveTargets", () => {
  const pool = [
    fleetRow(),
    fleetRow({ name: "frontyard-tig-431", workspaceId: "ws-uuid-bbb" }),
  ];

  it('"all" returns the whole pool', () => {
    expect(resolveTargets(pool, "all").matched).toHaveLength(2);
  });

  it("matches by friendly ticket substring, no uuid needed", () => {
    const { matched, unknown } = resolveTargets(pool, "tig-430,tig-431");
    expect(matched.map((r) => r.name)).toEqual([
      "frontyard-tig-430",
      "frontyard-tig-431",
    ]);
    expect(unknown).toEqual([]);
  });

  it("matches by exact workspace id too", () => {
    expect(resolveTargets(pool, "ws-uuid-aaa").matched).toHaveLength(1);
  });

  it("reports unknown tokens", () => {
    const { matched, unknown } = resolveTargets(pool, "tig-999");
    expect(matched).toHaveLength(0);
    expect(unknown).toEqual(["tig-999"]);
  });

  it("de-duplicates overlapping tokens", () => {
    expect(
      resolveTargets(pool, "tig-430,frontyard-tig-430").matched
    ).toHaveLength(1);
  });

  it("a repo label matches the whole repo's batch", () => {
    const tagged = pool.map((r) => ({ ...r, repo: "frontyard" }));
    expect(resolveTargets(tagged, "frontyard").matched).toHaveLength(2);
  });

  // One ticket fanned into two repos — the cross-repo case captain must handle
  // natively, without a workspace uuid.
  const crossRepo = [
    fleetRow({
      name: "frontyard-tig-424",
      repo: "frontyard",
      ticket: "tig-424",
      workspaceId: "ws-fy",
    }),
    fleetRow({
      name: "ltfollowers-tig-424",
      repo: "ltfollowers",
      ticket: "tig-424",
      workspaceId: "ws-lf",
    }),
  ];

  it("a bare ticket shared across repos is ambiguous, not first-matched", () => {
    const { matched, ambiguous, unknown } = resolveTargets(
      crossRepo,
      "tig-424"
    );
    expect(matched).toHaveLength(0);
    expect(unknown).toEqual([]);
    expect(ambiguous).toEqual([
      {
        candidates: ["frontyard-tig-424", "ltfollowers-tig-424"],
        token: "tig-424",
      },
    ]);
  });

  it("the qualified name disambiguates without a uuid", () => {
    const { matched } = resolveTargets(crossRepo, "ltfollowers-tig-424");
    expect(matched.map((r) => r.name)).toEqual(["ltfollowers-tig-424"]);
  });

  it("the workspace id still resolves the cross-repo collision too", () => {
    const { matched } = resolveTargets(crossRepo, "ws-fy");
    expect(matched.map((r) => r.name)).toEqual(["frontyard-tig-424"]);
  });
});

// approve/reject/status driven end to end through the REAL surface (fleetRows
// over temp worktrees with a `.captain/` marker) with an in-memory CmuxPort.

interface FakePort extends CmuxPort {
  replies: { id: string; approve: boolean }[];
  sent: { workspaceId: string; text: string }[];
  toasts: { title: string; body: string }[];
}

interface FakePortOpts {
  runs?: Record<string, RunState>;
  // false simulates a dead cmux daemon (status probes false)
  reachable?: boolean;
  // throw from send() to simulate a failed feedback delivery
  sendThrows?: boolean;
}

const fakePort = (
  workspaces: CmuxWorkspace[],
  feed: CmuxFeedItem[],
  opts: FakePortOpts = {}
): FakePort => {
  const replies: FakePort["replies"] = [];
  const sent: FakePort["sent"] = [];
  const toasts: FakePort["toasts"] = [];
  return {
    feedList: () => feed,
    listWorkspaces: () => workspaces,
    notify: (title, body) => {
      toasts.push({ body, title });
    },
    reachable: () => opts.reachable ?? true,
    replies,
    replyExitPlan: (id, isApproved) => {
      replies.push({ approve: isApproved, id });
    },
    runStates: () => opts.runs ?? {},
    send: (workspaceId, text) => {
      if (opts.sendThrows) {
        throw new Error("cmux send failed");
      }
      sent.push({ text, workspaceId });
    },
    sent,
    toasts,
  };
};

const capture = (): { out: PassThrough; text: () => string } => {
  const out = new PassThrough();
  let buf = "";
  out.on("data", (c: Buffer) => {
    buf += c.toString();
  });
  return { out, text: () => buf };
};

describe("stateless approve/reject/status over the real surface", () => {
  let root: string;

  const worktree = (name: string, withVerdict?: object): string => {
    const cwd = join(root, name);
    mkdirSync(join(cwd, ".captain"), { recursive: true });
    const { hash, text } = renderRubric(undefined, name.toUpperCase());
    writeFileSync(join(cwd, ".captain", "rubric.md"), text);
    if (withVerdict) {
      writeFileSync(
        join(cwd, ".captain", "verdict.json"),
        JSON.stringify({
          criteria: [{ evidence: "x", name: "implements", pass: true }],
          issue: name.toUpperCase(),
          rubricHash: hash,
          summary: "all criteria pass",
          ts: 1,
          verdict: "pass",
          ...withVerdict,
        })
      );
    }
    return cwd;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "captain-commands-"));
    vi.stubEnv("CAPTAIN_HOME", join(root, "home"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  });

  it("approve replies to the plan gate directly and logs the decision", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "tig-430" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    approve("tig-430", out, port);
    expect(port.replies).toEqual([{ approve: true, id: "feed-1" }]);
    expect(text()).toContain("approved");
    const log = readFileSync(join(root, "home", "log.jsonl"), "utf-8");
    expect(JSON.parse(log.trim())).toMatchObject({ kind: "approve" });
  });

  it("approve all approves every plan gate and nothing else", () => {
    const a = worktree("tig-430");
    const b = worktree("tig-431");
    const c = worktree("tig-432");
    const port = fakePort(
      [
        { cwd: a, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: b, id: "ws-2", name: "tig-431", ref: "r" },
        { cwd: c, id: "ws-3", name: "tig-432", ref: "r" },
      ],
      [
        { cwd: a, id: "feed-1", kind: "exitPlan", status: "pending" },
        { cwd: b, id: "feed-2", kind: "exitPlan", status: "pending" },
        // tig-432 is blocked on a question, not a plan — must not be approved.
        { cwd: c, id: "feed-3", kind: "question", status: "pending" },
      ]
    );
    const { out } = capture();
    approve("all", out, port);
    expect(port.replies.map((r) => r.id).toSorted()).toEqual([
      "feed-1",
      "feed-2",
    ]);
  });

  it("a resolved plan item never reads as approvable", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [
        {
          cwd,
          id: "feed-old",
          kind: "exitPlan",
          resolved_at: "2026-06-10T00:00:00Z",
          status: "expired",
        },
      ]
    );
    const { out, text } = capture();
    approve("tig-430", out, port);
    expect(port.replies).toHaveLength(0);
    expect(text()).toContain("nothing to approve");
  });

  it("reject replies false AND types the feedback into the workspace", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out } = capture();
    reject("tig-430", "split the migration", out, port);
    expect(port.replies).toEqual([{ approve: false, id: "feed-1" }]);
    expect(port.sent).toEqual([
      {
        text: "Plan rejected — revise it: split the migration",
        workspaceId: "ws-1",
      },
    ]);
  });

  it("status derives groups live: gate, verdict pass, and in flight", () => {
    const gated = worktree("tig-430");
    const ready = worktree("tig-431", { prUrl: "https://x/pr/1" });
    const flowing = worktree("tig-432");
    const port = fakePort(
      [
        { cwd: gated, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: ready, id: "ws-2", name: "tig-431", ref: "r" },
        { cwd: flowing, id: "ws-3", name: "tig-432", ref: "r" },
      ],
      [{ cwd: gated, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    status({}, out, port);
    const rendered = text();
    expect(rendered).toContain("NEEDS YOU");
    expect(rendered).toContain("READY TO MERGE");
    expect(rendered).toContain("gh pr merge https://x/pr/1 --squash");
    expect(rendered).toContain("captain approve tig-430");
  });

  it("status collapses a group-anchor workspace sharing a worktree cwd", () => {
    const managed = worktree("tig-491");
    const port = fakePort(
      [
        // the sidebar group's anchor: an idle shell in the same worktree dir,
        // with no claude_code tag in `cmux top`
        { cwd: managed, id: "WS-ANCHOR", name: "Group 1", ref: "r" },
        { cwd: managed, id: "WS-AGENT", name: "tig-491", ref: "r" },
      ],
      [],
      { runs: { "ws-agent": "needs-input" } }
    );
    const { out, text } = capture();
    status({ json: true }, out, port);
    const rows = JSON.parse(text()) as FleetRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe("WS-AGENT");
  });

  it("status ignores cmux workspaces without a .captain marker", () => {
    const managed = worktree("tig-430");
    const port = fakePort(
      [
        { cwd: managed, id: "ws-1", name: "tig-430", ref: "r" },
        {
          cwd: join(root, "random-dir"),
          id: "ws-9",
          name: "scratch",
          ref: "r",
        },
      ],
      []
    );
    const { out, text } = capture();
    status({ json: true }, out, port);
    const rows = JSON.parse(text()) as FleetRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe("ws-1");
  });

  it("status --json --summary returns counts + needs-you detail only", () => {
    const gated = worktree("tig-430");
    const ready = worktree("tig-431", { prUrl: "https://x/pr/1" });
    const flowing = worktree("tig-432");
    const port = fakePort(
      [
        { cwd: gated, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: ready, id: "ws-2", name: "tig-431", ref: "r" },
        { cwd: flowing, id: "ws-3", name: "tig-432", ref: "r" },
      ],
      [{ cwd: gated, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    status({ json: true, summary: true }, out, port);
    const parsed = JSON.parse(text()) as {
      counts: { needsYou: number; inFlight: number; ready: number };
      needsYou: FleetRow[];
    };
    expect(parsed.counts).toEqual({ inFlight: 1, needsYou: 1, ready: 1 });
    expect(parsed.needsYou).toHaveLength(1);
    expect(parsed.needsYou[0]).toMatchObject({
      gate: { kind: "plan" },
      group: "needs-you",
    });
  });

  it("status --summary (TTY) shows counts and only the NEEDS YOU rows", () => {
    const gated = worktree("tig-430");
    const flowing = worktree("tig-432");
    const port = fakePort(
      [
        { cwd: gated, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: flowing, id: "ws-3", name: "tig-432", ref: "r" },
      ],
      [{ cwd: gated, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    status({ summary: true }, out, port);
    const rendered = text();
    expect(rendered).toContain("NEEDS YOU");
    expect(rendered).toContain("captain approve tig-430");
    expect(rendered).toContain("1 need you");
    // the in-flight row is counted but not detailed
    expect(rendered).not.toContain("tig-432");
  });

  it("approve --json emits approved + unknown, no prose", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    approve("tig-430,tig-999", out, port, { json: true });
    expect(port.replies).toEqual([{ approve: true, id: "feed-1" }]);
    const parsed = JSON.parse(text()) as {
      approved: string[];
      unknown: string[];
      ambiguous: unknown[];
    };
    expect(parsed).toEqual({
      ambiguous: [],
      approved: ["tig-430"],
      unknown: ["tig-999"],
    });
    expect(text()).not.toContain("next:");
  });

  it("reject --json emits rejected + note, or unknown when no match", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const ok = capture();
    reject("tig-430", "split it", ok.out, port, { json: true });
    expect(JSON.parse(ok.text())).toEqual({
      feedbackDelivered: true,
      note: "split it",
      rejected: "tig-430",
    });
    const miss = capture();
    reject("tig-999", "n/a", miss.out, port, { json: true });
    expect(JSON.parse(miss.text())).toEqual({ unknown: ["tig-999"] });
  });

  it("reject still replies false when the feedback send fails, flagging it", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }],
      { sendThrows: true }
    );
    const { out, text } = capture();
    reject("tig-430", "split it", out, port, { json: true });
    // The rejection still went through even though the feedback didn't land.
    expect(port.replies).toEqual([{ approve: false, id: "feed-1" }]);
    expect(JSON.parse(text())).toEqual({
      feedbackDelivered: false,
      note: "split it",
      rejected: "tig-430",
    });
  });

  it("approve --json throws a typed BAD_REF (exit 2) for a fully-bad ref", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out } = capture();
    try {
      approve("tig-999", out, port, { json: true });
      throw new Error("expected approve to throw");
    } catch (error) {
      const e = error as CliError;
      expect(e).toBeInstanceOf(CliError);
      expect(e.errorType).toBe("BAD_REF");
      expect(e.exitCode).toBe(2);
    }
    // The bad ref was unresolvable, so nothing was approved.
    expect(port.replies).toEqual([]);
  });

  it("status reports a structured error + exit 11 when cmux is unreachable", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }],
      { reachable: false }
    );
    const prev = process.exitCode;
    const { out, text } = capture();
    status({ json: true }, out, port);
    const parsed = JSON.parse(text()) as { error: { type: string } };
    expect(parsed.error.type).toBe("CMUX_UNREACHABLE");
    expect(process.exitCode).toBe(11);
    process.exitCode = prev;
  });

  it("status --json stays plain and machine-readable", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    status({ json: true }, out, port);
    const rows = JSON.parse(text()) as FleetRow[];
    expect(rows[0]).toMatchObject({
      gate: { id: "feed-1", kind: "plan" },
      group: "needs-you",
    });
  });

  // gain: stateless telemetry derived over the SAME real surface, with the
  // decision log pre-seeded under the CAPTAIN_HOME temp.
  interface GainJson {
    decisions: {
      approvals: number;
      rejections: number;
      approvalRate: number;
      recentRejectReasons: { name: string; note: string; ts: number }[];
      cadence: { day: string; count: number }[];
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
      failingCriteria: { name: string; count: number }[];
      openPrs: string[];
    };
    merged?: { repo: string; count: number }[];
    caveats: string[];
  }

  const fleetOfThree = (): {
    port: ReturnType<typeof fakePort>;
  } => {
    const gated = worktree("tig-430");
    const ready = worktree("tig-431", { prUrl: "https://x/pr/1" });
    const flowing = worktree("tig-432");
    const port = fakePort(
      [
        { cwd: gated, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: ready, id: "ws-2", name: "tig-431", ref: "r" },
        { cwd: flowing, id: "ws-3", name: "tig-432", ref: "r" },
      ],
      [{ cwd: gated, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    return { port };
  };

  it("gain --json matches live fleet counts, openPrs, and the seeded decisions", () => {
    const { port } = fleetOfThree();
    appendLog({ kind: "approve", name: "tig-431", ts: 1000 });
    appendLog({ kind: "approve", name: "tig-431", ts: 2000 });
    appendLog({ kind: "reject", name: "tig-430", note: "split it", ts: 3000 });
    const { out, text } = capture();
    gain({ json: true }, out, port);
    const m = JSON.parse(text()) as GainJson;
    expect(m.fleet).toMatchObject({ needsYou: 1, ready: 1, total: 3 });
    expect(m.verdicts.pass).toBe(1);
    expect(m.verdicts.openPrs).toEqual(["https://x/pr/1"]);
    expect(m.decisions).toMatchObject({ approvals: 2, rejections: 1 });
    expect(m.decisions.approvalRate).toBeCloseTo(2 / 3);
    expect(m.decisions.recentRejectReasons[0].note).toBe("split it");
    expect(m.caveats.length).toBeGreaterThan(0);
    // no --git ⇒ merged omitted entirely
    expect(m.merged).toBeUndefined();
  });

  it("gain skips a malformed log line instead of throwing", () => {
    const { port } = fleetOfThree();
    appendLog({ kind: "approve", name: "tig-431", ts: 1000 });
    // append a truncated/garbage tail line directly
    writeFileSync(
      join(root, "home", "log.jsonl"),
      `${readFileSync(join(root, "home", "log.jsonl"), "utf-8")}{not json\n`
    );
    const { out, text } = capture();
    expect(() => gain({ json: true }, out, port)).not.toThrow();
    const m = JSON.parse(text()) as GainJson;
    expect(m.decisions.approvals).toBe(1);
  });

  it("gain --since windows the decision metrics and records the floor", () => {
    const { port } = fleetOfThree();
    // an old approval well outside any recent window, one fresh approval
    appendLog({ kind: "approve", name: "tig-431", ts: 1000 });
    appendLog({
      kind: "approve",
      name: "tig-431",
      ts: Math.floor(Date.now() / 1000),
    });
    const { out, text } = capture();
    gain({ json: true, since: "1d" }, out, port);
    const m = JSON.parse(text()) as GainJson;
    expect(m.decisions.approvals).toBe(1);
    expect(m.decisions.window).toBeDefined();
  });

  it("gain --json output is pure JSON, no prose", () => {
    const { port } = fleetOfThree();
    const { out, text } = capture();
    gain({ json: true }, out, port);
    // parses cleanly and the whole buffer is exactly that JSON + newline
    const parsed = JSON.parse(text()) as GainJson;
    expect(JSON.stringify(parsed, null, 2)).toBe(text().trimEnd());
  });

  it("gain reports a structured CMUX_UNREACHABLE + exit 11 when cmux is down", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [],
      { reachable: false }
    );
    const prev = process.exitCode;
    const { out, text } = capture();
    gain({ json: true }, out, port);
    const parsed = JSON.parse(text()) as { error: { type: string } };
    expect(parsed.error.type).toBe("CMUX_UNREACHABLE");
    expect(process.exitCode).toBe(11);
    process.exitCode = prev;
  });

  it("gain (TTY) renders the honesty caveats as a footer", () => {
    const { port } = fleetOfThree();
    const { out, text } = capture();
    gain({}, out, port);
    const rendered = text();
    expect(rendered).toContain("Captain — gain");
    expect(rendered).toContain("LIVE SNAPSHOT");
    expect(rendered).toContain("ledger");
  });
});
