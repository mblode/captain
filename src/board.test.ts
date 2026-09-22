import { describe, expect, it } from "vitest";

import {
  groupCounts,
  inProgress,
  openBlockers,
  rowOf,
  sortRows,
} from "./board";
import type { Evidence, PullRequest } from "./board";
import type { Task } from "./task";

const task = (over: Partial<Task> = {}): Task => ({
  blockedBy: [],
  body: "",
  branch: "t-1-x",
  created: "",
  effort: "",
  harness: "codex",
  id: "t-1",
  model: "",
  risk: "low",
  source: "",
  state: "active",
  title: "X",
  worktree: "/w/t-1",
  ...over,
});

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  checks: "pass",
  state: "open",
  url: "https://github.com/o/r/pull/1",
  ...over,
});

const pass = { summary: "ok", verdict: "pass" as const };
const fail = { summary: "tests missing", verdict: "fail" as const };
const running = { id: "ws-1", run: "running" as const };

const groupOf = (ev: Evidence, over: Partial<Task> = {}): string =>
  rowOf(task(over), ev, [task(over)]).group;

describe("the grouping rule", () => {
  it("is ready only with CI green, a passing verdict and a passing review", () => {
    const row = rowOf(
      task(),
      { pr: pr(), review: pass, verdict: pass, workspace: running },
      []
    );
    expect(row.group).toBe("ready");
    expect(row.next).toBe("gh pr merge https://github.com/o/r/pull/1 --squash");
  });

  it("never trusts a worker's word: no PR means still working", () => {
    expect(groupOf({ verdict: pass, workspace: running })).toBe("working");
  });

  it("asks you to approve a pending plan", () => {
    const row = rowOf(
      task(),
      { gate: { id: "f1", kind: "plan", replyId: "r1" }, workspace: running },
      []
    );
    expect(row.group).toBe("needs-you");
    expect(row.next).toContain("captain approve t-1");
  });

  it("surfaces a question and a stuck agent as needing you", () => {
    expect(
      groupOf({
        gate: { hint: "which table?", id: "f2", kind: "question" },
        workspace: running,
      })
    ).toBe("needs-you");
    expect(groupOf({ workspace: { id: "ws", run: "needs-input" } })).toBe(
      "needs-you"
    );
  });

  it("hands a verified PR to the chat for the cross-vendor review", () => {
    const row = rowOf(task(), { pr: pr(), verdict: pass }, []);
    expect(row.group).toBe("captain");
    expect(row.next).toBe("captain review t-1");
    expect(
      groupOf({ pr: pr(), reviewing: true, verdict: pass, workspace: running })
    ).toBe("working");
  });

  it("sends a failed review back to the worker via the chat", () => {
    const row = rowOf(task(), { pr: pr(), review: fail, verdict: pass }, []);
    expect(row.group).toBe("captain");
    expect(row.next).toContain("captain send t-1");
  });

  it("treats a failed verifier as a decision for you", () => {
    expect(groupOf({ pr: pr(), verdict: fail, workspace: running })).toBe(
      "needs-you"
    );
  });

  it("keeps red CI with a running worker as working, else the chat's move", () => {
    const red = pr({ checks: "fail" });
    expect(groupOf({ pr: red, verdict: pass, workspace: running })).toBe(
      "working"
    );
    expect(groupOf({ pr: red, verdict: pass })).toBe("captain");
  });

  it("flags a PR with no CI at all", () => {
    expect(groupOf({ pr: pr({ checks: "none" }), verdict: pass })).toBe(
      "needs-you"
    );
  });

  it("waits on pending CI or a missing verdict", () => {
    expect(groupOf({ pr: pr({ checks: "pending" }), verdict: pass })).toBe(
      "working"
    );
    expect(groupOf({ pr: pr(), workspace: running })).toBe("working");
  });

  it("marks a merged PR for closing", () => {
    const row = rowOf(task(), { pr: pr({ state: "merged" }) }, []);
    expect(row.group).toBe("merged");
    expect(row.next).toBe("captain done t-1");
  });

  it("asks the chat to restart an active task whose worker is gone", () => {
    expect(groupOf({})).toBe("captain");
  });

  it("queues, blocks and closes by the task file alone", () => {
    expect(groupOf({}, { state: "todo" })).toBe("queued");
    expect(groupOf({}, { state: "done" })).toBe("closed");
    const blocked = task({ blockedBy: ["t-9"], state: "todo" });
    expect(rowOf(blocked, {}, [blocked]).group).toBe("blocked");
  });
});

describe("openBlockers", () => {
  it("clears blockers that are done or dropped, keeps unknown ids open", () => {
    const t = task({ blockedBy: ["a", "b", "c", "ghost"] });
    const all = [
      t,
      task({ id: "a", state: "done" }),
      task({ id: "b", state: "dropped" }),
      task({ id: "c", state: "active" }),
    ];
    expect(openBlockers(t, all)).toEqual(["c", "ghost"]);
  });
});

describe("work in progress", () => {
  it("counts started tasks that are not merged yet", () => {
    const rows = [
      rowOf(task({ id: "a" }), { workspace: running }, []),
      rowOf(task({ id: "b" }), { pr: pr({ state: "merged" }) }, []),
      rowOf(task({ id: "c", state: "todo" }), {}, []),
      rowOf(task({ id: "d" }), { pr: pr(), review: pass, verdict: pass }, []),
    ];
    expect(inProgress(rows)).toBe(2);
    expect(groupCounts(rows)).toMatchObject({
      merged: 1,
      queued: 1,
      ready: 1,
      working: 1,
    });
  });

  it("sorts the most urgent group first", () => {
    const rows = sortRows([
      rowOf(task({ id: "q", state: "todo" }), {}, []),
      rowOf(
        task({ id: "n" }),
        { workspace: { id: "w", run: "needs-input" } },
        []
      ),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["n", "q"]);
  });
});
