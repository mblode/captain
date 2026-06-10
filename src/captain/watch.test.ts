import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderRubric } from "../rubric";
import { reconcile } from "./adopt";
import type { CmuxFeedItem, CmuxPort, CmuxWorkspace } from "./control";
import { readHistory } from "./history";
import { appendIntent } from "./intents";
import { drainIntents } from "./intents-drain";
import * as state from "./state";
import { sweepVerdicts } from "./sweeps";
import type { FleetState, HookEvent, Verdict, Worktree } from "./types";
import { handleEvent } from "./watch";

const FLEET = "default";

// The five regression tests the live session paid for, driven through the REAL
// orchestration modules (adopt/intents-drain/sweeps/watch → commit) with an
// in-memory CmuxPort — the seam control.ts defines; no mock framework.

interface FakePort extends CmuxPort {
  sent: { workspaceId: string; text: string }[];
  toasts: { title: string; body: string }[];
  replies: { id: string; approve: boolean }[];
}

const fakePort = (over: Partial<CmuxPort> = {}): FakePort => {
  const sent: FakePort["sent"] = [];
  const toasts: FakePort["toasts"] = [];
  const replies: FakePort["replies"] = [];
  return {
    feedList: (): CmuxFeedItem[] => [],
    listWorkspaces: (): CmuxWorkspace[] => [],
    notify: (title, body) => {
      toasts.push({ body, title });
    },
    readScreen: () => "",
    replies,
    replyExitPlan: (id, approve) => {
      replies.push({ approve, id });
    },
    send: (workspaceId, text) => {
      sent.push({ text, workspaceId });
    },
    sent,
    toasts,
    ...over,
  };
};

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  agent: "claude",
  cwd: "/wt/tig-1",
  lastSeen: 0,
  name: "tig-1",
  since: 0,
  stage: "IMPLEMENTING",
  workspaceId: "ws-1",
  ...over,
});

const fleet = (...wts: Worktree[]): FleetState => ({
  fleetId: FLEET,
  updatedAt: 0,
  worktrees: Object.fromEntries(wts.map((w) => [w.workspaceId, w])),
});

const ev = (over: Partial<HookEvent> = {}): HookEvent => ({
  cwd: "/wt/tig-1",
  hookEventName: "Stop",
  seq: 1,
  workspaceId: "ws-1",
  ...over,
});

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  criteria: [{ evidence: "src/x.ts:10", name: "implements", pass: true }],
  issue: "TIG-430",
  rubricHash: "unset",
  summary: "all criteria pass",
  ts: 1_700_000_000,
  verdict: "pass",
  ...over,
});

describe("watcher orchestration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "captain-watch-"));
    // Redirect ALL fleet state to the tmp dir. The fleetDir spy covers the
    // modules that import it (history/intents); stubbing HOME covers state.ts's
    // own internal statePath → fleetDir → homedir() calls, which a namespace
    // spy can't intercept. Both resolve to the same directory.
    vi.stubEnv("HOME", root);
    vi.spyOn(state, "fleetDir").mockImplementation((fleetId: string) =>
      join(root, ".claude", "captain", fleetId)
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // Session bug 1: the cmux RPC intermittently returns an empty workspace list
  // from a detached daemon — that must read as "no data this tick", not "every
  // workspace vanished, prune the fleet".
  it("an empty listWorkspaces result never prunes tracked worktrees", () => {
    const s = fleet(
      wt(),
      wt({ cwd: "/wt/tig-2", name: "tig-2", workspaceId: "ws-2" })
    );
    reconcile(s, []);
    expect(Object.keys(s.worktrees).toSorted()).toEqual(["ws-1", "ws-2"]);
    // A non-empty list still prunes genuinely vanished workspaces.
    reconcile(s, [
      { cwd: "/wt/tig-1", id: "ws-1", name: "tig-1", ref: "tig-1" },
    ]);
    expect(Object.keys(s.worktrees)).toEqual(["ws-1"]);
  });

  // Session bug 2: cmux re-emits ExitPlanMode (and bypass-permissions agents
  // re-present their plan mid-implementation) — that must never regress an
  // already-approved worktree back to the plan gate.
  it("a re-emitted ExitPlanMode does not regress an IMPLEMENTING worktree", () => {
    const port = fakePort();
    const w = wt({ stage: "IMPLEMENTING" });
    const s = fleet(w);
    handleEvent(s, ev({ hookEventName: "ExitPlanMode", seq: 9 }), { port });
    expect(w.stage).toBe("IMPLEMENTING");
    expect(port.toasts).toHaveLength(0);
    expect(readHistory(FLEET)).toHaveLength(0);
  });

  it("a re-emitted plan gate never double-notifies (idempotent in commit)", () => {
    const port = fakePort();
    const w = wt({ gate: "plan", stage: "PLAN_READY" });
    const s = fleet(w);
    handleEvent(s, ev({ hookEventName: "ExitPlanMode", seq: 9 }), { port });
    expect(w.stage).toBe("PLAN_READY");
    expect(port.toasts).toHaveLength(0);
    expect(readHistory(FLEET)).toHaveLength(0);
  });

  // Session bug 3: a human decision must apply exactly once, even across a
  // watcher crash/restart — the byte-offset cursor persists with the state.
  it("drains intents exactly once across a watcher restart", () => {
    const feed: CmuxFeedItem[] = [
      { cwd: "/wt/tig-1", id: "feed-1", kind: "exitPlan", status: "pending" },
      { cwd: "/wt/tig-2", id: "feed-2", kind: "exitPlan", status: "pending" },
    ];
    const port = fakePort({ feedList: () => feed });
    const s = fleet(
      wt({ gate: "plan", stage: "PLAN_READY" }),
      wt({
        cwd: "/wt/tig-2",
        gate: "plan",
        name: "tig-2",
        stage: "PLAN_READY",
        workspaceId: "ws-2",
      })
    );
    appendIntent(FLEET, { kind: "approve", ts: 1, workspaceId: "ws-1" });
    appendIntent(FLEET, {
      kind: "reject",
      note: "split the migration",
      ts: 2,
      workspaceId: "ws-2",
    });
    drainIntents(s, { port });
    expect(s.worktrees["ws-1"].stage).toBe("IMPLEMENTING");
    expect(s.worktrees["ws-2"].stage).toBe("PLANNING");
    expect(s.worktrees["ws-2"].note).toBe("split the migration");
    expect(port.replies).toEqual([
      { approve: true, id: "feed-1" },
      { approve: false, id: "feed-2" },
    ]);

    // "Restart": reload the persisted state (cursor included) and drain again.
    const port2 = fakePort({ feedList: () => feed });
    const restarted = state.loadState(FLEET);
    expect(restarted.intentsOffset).toBeGreaterThan(0);
    // Simulate the agents having moved on; a re-applied intent would yank them.
    restarted.worktrees["ws-1"].stage = "SIMPLIFY";
    drainIntents(restarted, { port: port2 });
    expect(restarted.worktrees["ws-1"].stage).toBe("SIMPLIFY");
    expect(port2.replies).toHaveLength(0);
    const kinds = readHistory(FLEET).map((r) => r.kind);
    expect(kinds).toEqual(["approve", "reject"]);
  });

  // Session bug 4: never type into a busy surface — defer, record a rework, and
  // let the next Stop retry.
  it("defers the advance when the screen looks busy", () => {
    const port = fakePort({ readScreen: () => "… esc to interrupt …" });
    const w = wt({ since: 5, stage: "IMPLEMENTING" });
    const s = fleet(w);
    handleEvent(s, ev({ seq: 3 }), { port });
    expect(port.sent).toHaveLength(0);
    expect(w.stage).toBe("IMPLEMENTING");
    expect(w.since).toBe(5);
    const recs = readHistory(FLEET);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      action: "/simplify",
      from: "IMPLEMENTING",
      kind: "rework",
      seq: 3,
      to: "IMPLEMENTING",
    });
  });

  it("advances (send + clear gate/note + history) when the screen is idle", () => {
    const port = fakePort();
    const w = wt({ note: "stale", stage: "IMPLEMENTING" });
    const s = fleet(w);
    handleEvent(s, ev({ seq: 4 }), { port });
    expect(port.sent).toEqual([{ text: "/simplify", workspaceId: "ws-1" }]);
    expect(w.stage).toBe("SIMPLIFY");
    expect(w.note).toBeUndefined();
    expect(readHistory(FLEET)[0]).toMatchObject({
      action: "/simplify",
      kind: "advance",
      to: "SIMPLIFY",
    });
  });

  // Session bug 5: verdict routing — the agent-written verdict file must gate
  // correctly through commit(): pass parks pr-ready, fail escalates, and a
  // missing or tampered verdict changes nothing.
  describe("verdict routing through commit", () => {
    const cleanup: string[] = [];

    afterEach(async () => {
      for (const path of cleanup.splice(0)) {
        await rm(path, { force: true, recursive: true });
      }
    });

    // Reuses the verdict.test.ts fs-fixture style: a real rubric + verdict on
    // disk in a tmp worktree.
    const worktreeOnDisk = (
      v?: Partial<Verdict>
    ): { cwd: string; hash: string } => {
      const cwd = mkdtempSync(join(tmpdir(), "captain-wt-"));
      cleanup.push(cwd);
      const { hash, text } = renderRubric(undefined, "TIG-430");
      mkdirSync(join(cwd, ".captain"));
      writeFileSync(join(cwd, ".captain", "rubric.md"), text);
      if (v) {
        writeFileSync(
          join(cwd, ".captain", "verdict.json"),
          JSON.stringify(verdict({ rubricHash: hash, ...v }))
        );
      }
      return { cwd, hash };
    };

    it("a passing verdict on Stop parks READY_TO_MERGE instead of advancing", () => {
      const { cwd } = worktreeOnDisk({
        prUrl: "https://github.com/x/y/pull/1",
      });
      const port = fakePort();
      const w = wt({ cwd, stage: "PR_OPEN" });
      const s = fleet(w);
      handleEvent(s, ev({ cwd, seq: 8 }), { port });
      expect(w.stage).toBe("READY_TO_MERGE");
      expect(w.gate).toBe("pr-ready");
      expect(w.verdict).toBe("pass");
      expect(w.prUrl).toBe("https://github.com/x/y/pull/1");
      // The verified pass WINS over the normal PR_OPEN → babysitter advance.
      expect(port.sent).toHaveLength(0);
      expect(port.toasts).toEqual([
        { body: "tig-1: all criteria pass", title: "Captain · ready to merge" },
      ]);
      expect(readHistory(FLEET)[0]).toMatchObject({
        kind: "verdict",
        note: "all criteria pass",
        seq: 8,
        to: "READY_TO_MERGE",
      });
    });

    it("a failing verdict escalates to BLOCKED with the summary as note", () => {
      const { cwd } = worktreeOnDisk({
        summary: "tests missing",
        verdict: "fail",
      });
      const port = fakePort();
      const w = wt({ cwd, stage: "BABYSITTING" });
      const s = fleet(w);
      sweepVerdicts(s, { port });
      expect(w.stage).toBe("BLOCKED");
      expect(w.gate).toBe("needs-input");
      expect(w.note).toBe("tests missing");
      expect(port.toasts[0].title).toMatch(/need(s)? you/u);
      expect(readHistory(FLEET)[0]).toMatchObject({
        kind: "verdict",
        note: "tests missing",
        to: "BLOCKED",
      });
    });

    it("a missing verdict file changes nothing", () => {
      const { cwd } = worktreeOnDisk();
      const port = fakePort();
      const w = wt({ cwd, stage: "BABYSITTING" });
      const s = fleet(w);
      sweepVerdicts(s, { port });
      expect(w.stage).toBe("BABYSITTING");
      expect(w.gate).toBeUndefined();
      expect(readHistory(FLEET)).toHaveLength(0);
    });

    it("a tampered rubric voids the verdict (hash mismatch → no change)", () => {
      const { cwd } = worktreeOnDisk({});
      // Edit the rubric AFTER the verdict was written: the cited hash no
      // longer matches the rubric as it exists now.
      writeFileSync(
        join(cwd, ".captain", "rubric.md"),
        "# Definition of done — TIG-430\n\nweakened criteria\n"
      );
      const port = fakePort();
      const w = wt({ cwd, stage: "BABYSITTING" });
      const s = fleet(w);
      sweepVerdicts(s, { port });
      expect(w.stage).toBe("BABYSITTING");
      expect(port.toasts).toHaveLength(0);
      expect(readHistory(FLEET)).toHaveLength(0);
    });
  });
});
