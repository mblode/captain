import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError } from "../errors";
import { renderRubric } from "../rubric";
import { runRequired } from "../shell";
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
  ticket: "tig-430",
  workspaceId: "ws-uuid-aaa",
  ...over,
});

describe("resolveTargets", () => {
  const pool = [
    fleetRow(),
    fleetRow({
      name: "frontyard-tig-431",
      ticket: "tig-431",
      workspaceId: "ws-uuid-bbb",
    }),
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

  // A bare ticket resolves by EXACT ticket, never a substring — `tig-1` must
  // not bleed into `tig-10`, in either direction.
  it("an exact ticket never substring-matches a longer ticket (tig-1 ≠ tig-10)", () => {
    const only10 = [
      fleetRow({
        name: "frontyard-tig-10",
        ticket: "tig-10",
        workspaceId: "ws-uuid-c10",
      }),
    ];
    const { matched, unknown } = resolveTargets(only10, "tig-1");
    expect(matched).toHaveLength(0);
    expect(unknown).toEqual(["tig-1"]);
  });

  it("with both tig-1 and tig-10 present, tig-1 resolves to exactly tig-1", () => {
    const both = [
      fleetRow({
        name: "frontyard-tig-1",
        ticket: "tig-1",
        workspaceId: "ws-uuid-c1",
      }),
      fleetRow({
        name: "frontyard-tig-10",
        ticket: "tig-10",
        workspaceId: "ws-uuid-c10",
      }),
    ];
    const { matched, ambiguous, unknown } = resolveTargets(both, "tig-1");
    expect(matched.map((r) => r.name)).toEqual(["frontyard-tig-1"]);
    expect(ambiguous).toEqual([]);
    expect(unknown).toEqual([]);
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
  sendAttempts: string[];
  toasts: { title: string; body: string }[];
}

interface FakePortOpts {
  runs?: Record<string, RunState>;
  // false simulates a dead cmux daemon (status probes false)
  reachable?: boolean;
  // throw from send() to simulate a failed feedback delivery
  sendThrows?: boolean;
  sendThrowsFor?: string[];
}

const fakePort = (
  workspaces: CmuxWorkspace[],
  feed: CmuxFeedItem[],
  opts: FakePortOpts = {}
): FakePort => {
  const replies: FakePort["replies"] = [];
  const sent: FakePort["sent"] = [];
  const sendAttempts: string[] = [];
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
      sendAttempts.push(workspaceId);
      if (opts.sendThrows || opts.sendThrowsFor?.includes(workspaceId)) {
        throw new Error("cmux send failed");
      }
      sent.push({ text, workspaceId });
    },
    sendAttempts,
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

  const repoCheckout = (name: string): string => {
    const cwd = join(root, name);
    mkdirSync(join(cwd, ".captain"), { recursive: true });
    runRequired("git", ["init", "--quiet", cwd]);
    const { text } = renderRubric(undefined, name.toUpperCase());
    writeFileSync(join(cwd, ".captain", "rubric.md"), text);
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

  it("reject acts on EVERY matched worktree, not just the first", () => {
    const a = worktree("tig-430");
    const b = worktree("tig-431");
    const port = fakePort(
      [
        { cwd: a, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: b, id: "ws-2", name: "tig-431", ref: "r" },
      ],
      [
        { cwd: a, id: "feed-1", kind: "exitPlan", status: "pending" },
        { cwd: b, id: "feed-2", kind: "exitPlan", status: "pending" },
      ]
    );
    const { out, text } = capture();
    reject("all", "rethink it", out, port, { json: true });
    // both plan gates replied false, both got the feedback typed in
    expect(port.replies.map((r) => r.id).toSorted()).toEqual([
      "feed-1",
      "feed-2",
    ]);
    expect(port.sent.map((sent) => sent.workspaceId).toSorted()).toEqual([
      "ws-1",
      "ws-2",
    ]);
    const parsed = JSON.parse(text()) as { rejected: string[] };
    expect(parsed.rejected.toSorted()).toEqual(["tig-430", "tig-431"]);
    // both decisions land in the log, not just the first
    const log = readFileSync(join(root, "home", "log.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    expect(log.filter((entry) => entry.kind === "reject")).toHaveLength(2);
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

  it("status targets friendly ticket and workspace refs", () => {
    const first = worktree("tig-430");
    const second = worktree("tig-431");
    const third = worktree("tig-432");
    const port = fakePort(
      [
        { cwd: first, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: second, id: "ws-2", name: "tig-431", ref: "r" },
        { cwd: third, id: "ws-3", name: "tig-432", ref: "r" },
      ],
      []
    );
    const { out, text } = capture();
    status({ json: true, refs: "tig-430,ws-3" }, out, port);
    const rows = JSON.parse(text()) as FleetRow[];
    expect(rows.map((row) => row.workspaceId)).toEqual(["ws-1", "ws-3"]);
  });

  it("status --repo accepts an exact or unique repo label only", () => {
    const frontyard = repoCheckout("frontyard");
    const frontyardTools = repoCheckout("frontyard-tools");
    const port = fakePort(
      [
        { cwd: frontyard, id: "ws-fy", name: "tig-430", ref: "r" },
        { cwd: frontyardTools, id: "ws-tools", name: "tig-431", ref: "r" },
      ],
      []
    );

    const exact = capture();
    status({ json: true, repo: "frontyard" }, exact.out, port);
    expect(
      (JSON.parse(exact.text()) as FleetRow[]).map((row) => row.repo)
    ).toEqual(["frontyard"]);

    expect(() =>
      status({ json: true, repo: "front" }, capture().out, port)
    ).toThrow(/ambiguous repo/u);
    try {
      status({ json: true, repo: "missing" }, capture().out, port);
      throw new Error("expected status to throw");
    } catch (error) {
      expect(error).toMatchObject({ errorType: "BAD_REF", exitCode: 2 });
    }
  });

  it("status rejects unknown and ambiguous refs instead of rendering empty", () => {
    const first = worktree("frontyard-tig-424");
    const second = worktree("ltfollowers-tig-424");
    const port = fakePort(
      [
        { cwd: first, id: "ws-fy", name: "frontyard-tig-424", ref: "r" },
        { cwd: second, id: "ws-lf", name: "ltfollowers-tig-424", ref: "r" },
      ],
      []
    );
    expect(() =>
      status({ refs: "tig-424,tig-999" }, capture().out, port)
    ).toThrow(CliError);
  });

  it("status --json preserves its array shape with compact serialization", () => {
    const cwd = worktree("tig-430");
    const port = fakePort([{ cwd, id: "ws-1", name: "tig-430", ref: "r" }], []);
    const { out, text } = capture();
    status({ json: true }, out, port);
    const parsed = JSON.parse(text()) as FleetRow[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(text()).toBe(`${JSON.stringify(parsed)}\n`);
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
      snapshot: string;
    };
    expect(parsed.counts).toEqual({ inFlight: 1, needsYou: 1, ready: 1 });
    expect(parsed.needsYou).toHaveLength(1);
    expect(parsed.needsYou[0]).toMatchObject({
      gate: { kind: "plan" },
      group: "needs-you",
    });
    expect(parsed.snapshot).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("status --summary --json supports stateless aggregate delta polling", () => {
    const cwd = worktree("tig-430");
    const runs: Record<string, RunState> = { "ws-1": "busy" };
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [],
      { runs }
    );
    const first = capture();
    status({ json: true, summary: true }, first.out, port);
    const initial = JSON.parse(first.text()) as { snapshot: string };

    const unchanged = capture();
    status(
      { json: true, since: initial.snapshot, summary: true },
      unchanged.out,
      port
    );
    expect(JSON.parse(unchanged.text())).toEqual({
      changed: false,
      snapshot: initial.snapshot,
    });

    // Raw process churn inside IN FLIGHT is not an actionable summary change.
    runs["ws-1"] = "idle";
    const stillUnchanged = capture();
    status(
      { json: true, since: initial.snapshot, summary: true },
      stillUnchanged.out,
      port
    );
    expect(JSON.parse(stillUnchanged.text())).toEqual({
      changed: false,
      snapshot: initial.snapshot,
    });

    runs["ws-1"] = "needs-input";
    const changed = capture();
    status(
      { json: true, since: initial.snapshot, summary: true },
      changed.out,
      port
    );
    expect(JSON.parse(changed.text())).toMatchObject({
      changed: true,
      counts: { inFlight: 0, needsYou: 1, ready: 0 },
    });
  });

  it("targeted delta polling reports a disappearing ref once", () => {
    const cwd = worktree("tig-430");
    const workspaces = [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }];
    const port = fakePort(workspaces, []);
    const first = capture();
    status({ json: true, refs: "tig-430", summary: true }, first.out, port);
    const initial = JSON.parse(first.text()) as { snapshot: string };

    workspaces.splice(0);
    const disappeared = capture();
    status(
      {
        json: true,
        refs: "tig-430",
        since: initial.snapshot,
        summary: true,
      },
      disappeared.out,
      port
    );
    const changed = JSON.parse(disappeared.text()) as {
      changed: boolean;
      missing: string[];
      snapshot: string;
    };
    expect(changed).toMatchObject({ changed: true, missing: ["tig-430"] });
    expect(changed.snapshot).not.toBe(initial.snapshot);

    const settled = capture();
    status(
      {
        json: true,
        refs: "tig-430",
        since: changed.snapshot,
        summary: true,
      },
      settled.out,
      port
    );
    expect(JSON.parse(settled.text())).toEqual({
      changed: false,
      snapshot: changed.snapshot,
    });
  });

  it("targeted delta polling never tolerates an ambiguous ref", () => {
    const first = worktree("frontyard-tig-424");
    const second = worktree("ltfollowers-tig-424");
    const port = fakePort(
      [
        { cwd: first, id: "ws-fy", name: "frontyard-tig-424", ref: "r" },
        { cwd: second, id: "ws-lf", name: "ltfollowers-tig-424", ref: "r" },
      ],
      []
    );
    expect(() =>
      status(
        { json: true, refs: "tig-424", since: "old", summary: true },
        capture().out,
        port
      )
    ).toThrow(/ambiguous/u);
  });

  it("status rejects contradictory filters and invalid --since combinations", () => {
    const port = fakePort([], []);
    try {
      status({ needs: true, ready: true }, capture().out, port);
      throw new Error("expected status to throw");
    } catch (error) {
      expect(error).toMatchObject({ errorType: "BAD_OPTIONS", exitCode: 2 });
    }
    expect(() =>
      status({ needs: true, summary: true }, capture().out, port)
    ).toThrow(/--summary cannot be combined/u);
    expect(() => status({ since: "abc" }, capture().out, port)).toThrow(
      /--since requires --summary --json/u
    );
    expect(() =>
      status(
        { json: true, since: "abc", summary: true, watch: true },
        capture().out,
        port
      )
    ).toThrow(/cannot be used with --watch/u);
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

  it("reject emits rejected + note and throws BAD_REF when fully unknown", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const ok = capture();
    reject("tig-430", "split it", ok.out, port, { json: true });
    expect(JSON.parse(ok.text())).toEqual({
      ambiguous: [],
      note: "split it",
      rejected: ["tig-430"],
      undelivered: [],
      unknown: [],
    });
    try {
      reject("tig-999", "n/a", capture().out, port, { json: true });
      throw new Error("expected reject to throw");
    } catch (error) {
      expect(error).toMatchObject({ errorType: "BAD_REF", exitCode: 2 });
    }
    expect(() => reject("tig-999", "n/a", capture().out, port)).toThrow(
      CliError
    );
  });

  it("reject --json preserves partial success while reporting bad refs", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const result = capture();
    reject("tig-430,tig-999", "split it", result.out, port, { json: true });
    expect(JSON.parse(result.text())).toMatchObject({
      rejected: ["tig-430"],
      unknown: ["tig-999"],
    });
  });

  it("reject is fail-closed when any feedback delivery fails", () => {
    const first = worktree("tig-430");
    const second = worktree("tig-431");
    const port = fakePort(
      [
        { cwd: first, id: "ws-1", name: "tig-430", ref: "r" },
        { cwd: second, id: "ws-2", name: "tig-431", ref: "r" },
      ],
      [
        { cwd: first, id: "feed-1", kind: "exitPlan", status: "pending" },
        { cwd: second, id: "feed-2", kind: "exitPlan", status: "pending" },
      ],
      { sendThrowsFor: ["ws-1"] }
    );
    try {
      reject("all", "split it", capture().out, port, { json: true });
      throw new Error("expected reject to throw");
    } catch (error) {
      expect(error).toMatchObject({
        errorType: "CMUX_UNREACHABLE",
        exitCode: 11,
      });
      expect((error as Error).message).toContain(
        "cmux send --workspace 'ws-1'"
      );
    }
    // Every delivery was attempted before the failure was reported, but no
    // gate or decision ledger entry was changed.
    expect(port.sendAttempts).toEqual(["ws-1", "ws-2"]);
    expect(port.sent.map((item) => item.workspaceId)).toEqual(["ws-2"]);
    expect(port.replies).toEqual([]);
    expect(() =>
      readFileSync(join(root, "home", "log.jsonl"), "utf-8")
    ).toThrow();
  });

  it("reject validates and trims feedback before reading cmux", () => {
    const unreachable = fakePort([], [], { reachable: false });
    try {
      reject("all", "   ", capture().out, unreachable, { json: true });
      throw new Error("expected reject to throw");
    } catch (error) {
      expect(error).toMatchObject({ errorType: "BAD_OPTIONS", exitCode: 2 });
    }

    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const result = capture();
    reject("tig-430", "  split it  ", result.out, port, { json: true });
    expect(JSON.parse(result.text()).note).toBe("split it");
    expect(port.sent[0]?.text).toBe("Plan rejected — revise it: split it");
  });

  it("successful controls report audit-log failures without becoming failures", () => {
    const cwd = worktree("tig-430");
    const feed = [
      { cwd, id: "feed-1", kind: "exitPlan" as const, status: "pending" },
    ];
    const blockedHome = join(root, "blocked-home");
    writeFileSync(blockedHome, "not a directory");
    vi.stubEnv("CAPTAIN_HOME", blockedHome);

    const approvePort = fakePort(
      [{ cwd, id: "ws-approve", name: "tig-430", ref: "r" }],
      feed
    );
    const approved = capture();
    approve("tig-430", approved.out, approvePort, { json: true });
    expect(approvePort.replies).toEqual([{ approve: true, id: "feed-1" }]);
    expect(JSON.parse(approved.text()).unlogged).toEqual(["tig-430"]);

    const rejectPort = fakePort(
      [{ cwd, id: "ws-reject", name: "tig-430", ref: "r" }],
      feed
    );
    const rejected = capture();
    reject("tig-430", "split it", rejected.out, rejectPort, { json: true });
    expect(rejectPort.replies).toEqual([{ approve: false, id: "feed-1" }]);
    expect(JSON.parse(rejected.text()).unlogged).toEqual(["tig-430"]);

    const humanPort = fakePort(
      [{ cwd, id: "ws-human", name: "tig-430", ref: "r" }],
      feed
    );
    const human = capture();
    approve("tig-430", human.out, humanPort);
    expect(human.text()).toContain(
      "approval succeeded but the audit log failed"
    );
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

  it("approve/reject fail with CMUX_UNREACHABLE before any control side effect", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }],
      { reachable: false }
    );
    for (const act of [
      () => approve("tig-430", capture().out, port, { json: true }),
      () => reject("tig-430", "change it", capture().out, port, { json: true }),
    ]) {
      try {
        act();
        throw new Error("expected control command to throw");
      } catch (error) {
        const cliError = error as CliError;
        expect(cliError).toBeInstanceOf(CliError);
        expect(cliError.errorType).toBe("CMUX_UNREACHABLE");
        expect(cliError.exitCode).toBe(11);
      }
    }
    expect(port.replies).toEqual([]);
    expect(port.sent).toEqual([]);
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

  it("status without --watch derives once and returns no handle", () => {
    const cwd = worktree("tig-430");
    const port = fakePort([{ cwd, id: "ws-1", name: "tig-430", ref: "r" }], []);
    const { out } = capture();
    expect(status({ json: true }, out, port)).toBeUndefined();
  });

  it("status --watch paints immediately, re-renders each interval, stop() halts it", () => {
    const cwd = worktree("tig-430");
    const port = fakePort(
      [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }],
      [{ cwd, id: "feed-1", kind: "exitPlan", status: "pending" }]
    );
    const { out, text } = capture();
    const renders = (): number => text().match(/watching every/gu)?.length ?? 0;
    vi.useFakeTimers();
    try {
      const stop = status({ interval: 0.01, watch: true }, out, port);
      // Paints once synchronously, before any timer fires.
      expect(renders()).toBe(1);
      // ~3 ticks at 10ms.
      vi.advanceTimersByTime(35);
      expect(renders()).toBeGreaterThanOrEqual(3);
      const atStop = renders();
      stop?.();
      // After stop, the interval is cleared — no further renders accrue.
      vi.advanceTimersByTime(100);
      expect(renders()).toBe(atStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("status --watch --json emits JSONL with no prose header", () => {
    const cwd = worktree("tig-430");
    const port = fakePort([{ cwd, id: "ws-1", name: "tig-430", ref: "r" }], []);
    const { out, text } = capture();
    vi.useFakeTimers();
    try {
      const stop = status(
        { interval: 0.01, json: true, watch: true },
        out,
        port
      );
      vi.advanceTimersByTime(25);
      const lines = text().trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(text()).not.toContain("watching every");
      stop?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("status --watch survives a targeted workspace disappearing", () => {
    const cwd = worktree("tig-430");
    const workspaces = [{ cwd, id: "ws-1", name: "tig-430", ref: "r" }];
    const port = fakePort(workspaces, []);
    const { out, text } = capture();
    vi.useFakeTimers();
    try {
      const stop = status(
        { interval: 0.01, refs: "tig-430", watch: true },
        out,
        port
      );
      workspaces.splice(0);
      expect(() => vi.advanceTimersByTime(15)).not.toThrow();
      expect(text()).toContain("no Captain worktree matches: tig-430");
      stop?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("status --watch falls back to a 5s interval for a non-positive value", () => {
    const cwd = worktree("tig-430");
    const port = fakePort([{ cwd, id: "ws-1", name: "tig-430", ref: "r" }], []);
    const { out, text } = capture();
    vi.useFakeTimers();
    try {
      const stop = status({ interval: 0, watch: true }, out, port);
      expect(text()).toContain("watching every 5s");
      stop?.();
    } finally {
      vi.useRealTimers();
    }
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
    latency?: {
      toDecision?: { count: number; medianSec: number; maxSec: number };
      toVerdict?: { count: number; medianSec: number; maxSec: number };
    };
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
    appendLog({ kind: "launch", name: "tig-431", ts: 500 });
    appendLog({ kind: "approve", name: "tig-431", ts: 1000 });
    appendLog({ kind: "approve", name: "tig-431", ts: 2000 });
    appendLog({ kind: "reject", name: "tig-430", note: "split it", ts: 3000 });
    const { out, text } = capture();
    gain({ json: true }, out, port);
    const m = JSON.parse(text()) as GainJson;
    expect(m.fleet).toMatchObject({ needsYou: 1, ready: 1, total: 3 });
    // launch→decision latency joins the ledgered launch by name; the launch
    // record itself never counts as a decision.
    expect(m.latency?.toDecision).toEqual({
      count: 2,
      maxSec: 1500,
      medianSec: 500,
    });
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
