import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderRubric } from "../rubric";
import { approve, reject, resolveTargets, status } from "./commands";
import type { CmuxFeedItem, CmuxPort, CmuxWorkspace } from "./control";
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
});

// approve/reject/status driven end to end through the REAL surface (fleetRows
// over temp worktrees with a `.captain/` marker) with an in-memory CmuxPort.

interface FakePort extends CmuxPort {
  replies: { id: string; approve: boolean }[];
  sent: { workspaceId: string; text: string }[];
  toasts: { title: string; body: string }[];
}

const fakePort = (
  workspaces: CmuxWorkspace[],
  feed: CmuxFeedItem[]
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
    replies,
    replyExitPlan: (id, isApproved) => {
      replies.push({ approve: isApproved, id });
    },
    runStates: () => ({}),
    send: (workspaceId, text) => {
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
});
