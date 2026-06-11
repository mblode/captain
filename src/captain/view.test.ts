import { describe, expect, it } from "vitest";

import type { CmuxFeedItem, CmuxWorkspace } from "./control";
import type { Verdict } from "./verdict";
import {
  identityOf,
  mergeOrderHints,
  nextCommand,
  pendingGate,
  pickAgentWorkspaces,
  rowOf,
  stateHash,
  ticketFrom,
} from "./view";
import type { RowInput } from "./view";

const feedItem = (over: Partial<CmuxFeedItem> = {}): CmuxFeedItem => ({
  cwd: "/wt/tig-1",
  id: "feed-1",
  kind: "exitPlan",
  status: "pending",
  ...over,
});

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  criteria: [{ evidence: "src/x.ts:10", name: "implements", pass: true }],
  issue: "TIG-430",
  rubricHash: "abc123",
  summary: "all criteria pass",
  ts: 1_700_000_000,
  verdict: "pass",
  ...over,
});

const input = (over: Partial<RowInput> = {}): RowInput => ({
  cwd: "/wt/tig-1",
  fallbackName: "tig-1",
  feed: [],
  run: "running",
  workspaceId: "ws-1",
  ...over,
});

describe("ticketFrom / identityOf", () => {
  it("extracts the canonical ticket id, lowercased", () => {
    expect(ticketFrom("chat-tig-487")).toBe("tig-487");
    expect(ticketFrom("TIG-488-c3-general-tool")).toBe("tig-488");
    expect(ticketFrom("chat")).toBeUndefined();
  });

  it("builds repo-ticket names, falling back to the workspace name", () => {
    expect(identityOf("/wt/tig-494", "tig-494", "linkiq")).toEqual({
      name: "linkiq-tig-494",
      repo: "linkiq",
      ticket: "tig-494",
    });
    // No repo → the fallback name stands.
    expect(identityOf("/wt/tig-494", "my-window").name).toBe("my-window");
    // Ticket can come from the fallback when the dir has none.
    expect(identityOf("/wt/scratch", "tig-9 work", "chat").name).toBe(
      "chat-tig-9"
    );
  });
});

describe("pendingGate", () => {
  it("picks the NEWEST unresolved gating item for the cwd", () => {
    const gate = pendingGate(
      [
        feedItem({ id: "old", resolved_at: "2026-06-10T00:00:00Z" }),
        feedItem({ cwd: "/wt/other", id: "foreign" }),
        feedItem({ id: "older-live", kind: "question" }),
        feedItem({ id: "newest-live", kind: "question" }),
      ],
      "/wt/tig-1"
    );
    expect(gate?.id).toBe("newest-live");
  });

  it("a resolved item never reads as a gate", () => {
    expect(
      pendingGate(
        [feedItem({ resolved_at: "2026-06-10T00:00:00Z" })],
        "/wt/tig-1"
      )
    ).toBeUndefined();
  });

  it("maps exitPlan to the plan gate and questions to question", () => {
    expect(pendingGate([feedItem()], "/wt/tig-1")?.kind).toBe("plan");
    expect(
      pendingGate(
        [feedItem({ kind: "question", question_prompt: "Which db?" })],
        "/wt/tig-1"
      )
    ).toMatchObject({ hint: "Which db?", kind: "question" });
  });

  it("ignores non-gating kinds", () => {
    expect(
      pendingGate([feedItem({ kind: "userPrompt" })], "/wt/tig-1")
    ).toBeUndefined();
  });
});

describe("rowOf grouping", () => {
  it("a pending gate is needs-you", () => {
    expect(rowOf(input({ feed: [feedItem()] })).group).toBe("needs-you");
  });

  it("a valid passing verdict is ready, carrying summary and prUrl", () => {
    const row = rowOf(
      input({
        expectedHash: "abc123",
        verdict: verdict({ prUrl: "https://x/pr/1" }),
      })
    );
    expect(row.group).toBe("ready");
    expect(row.verdict).toBe("pass");
    expect(row.prUrl).toBe("https://x/pr/1");
    expect(row.summary).toBe("all criteria pass");
  });

  it("a failing verdict is needs-you", () => {
    expect(
      rowOf(
        input({
          expectedHash: "abc123",
          verdict: verdict({ summary: "tests missing", verdict: "fail" }),
        })
      ).group
    ).toBe("needs-you");
  });

  it("a verdict citing the wrong rubric hash is voided (tampered rubric)", () => {
    const row = rowOf(input({ expectedHash: "other", verdict: verdict() }));
    expect(row.group).toBe("in-flight");
    expect(row.verdict).toBeUndefined();
  });

  it("accepts the verdict's hash when no rubric exists to check against", () => {
    expect(rowOf(input({ verdict: verdict() })).group).toBe("ready");
  });

  it("a gate outranks a passing verdict (a late question still needs you)", () => {
    expect(
      rowOf(
        input({
          expectedHash: "abc123",
          feed: [feedItem({ kind: "question" })],
          verdict: verdict(),
        })
      ).group
    ).toBe("needs-you");
  });

  it("an agent stuck on input (no feed item) is needs-you", () => {
    expect(rowOf(input({ run: "needs-input" })).group).toBe("needs-you");
  });

  it("working and idle agents are in-flight", () => {
    expect(rowOf(input({ run: "running" })).group).toBe("in-flight");
    expect(rowOf(input({ run: "idle" })).group).toBe("in-flight");
    expect(rowOf(input({ run: "unknown" })).group).toBe("in-flight");
  });
});

describe("nextCommand", () => {
  it("a plan gate offers captain approve <ticket>", () => {
    const row = rowOf(input({ feed: [feedItem()] }));
    expect(row.nextCommand).toBe("captain approve tig-1");
    expect(nextCommand(row)).toBe("captain approve tig-1");
  });

  it("a blocked/question row inspects the screen first", () => {
    const row = rowOf(input({ feed: [feedItem({ kind: "question" })] }));
    expect(row.nextCommand).toBe("cmux read-screen --workspace ws-1");
  });

  it("a needs-input row (no feed) inspects the screen", () => {
    const row = rowOf(input({ run: "needs-input" }));
    expect(row.nextCommand).toBe("cmux read-screen --workspace ws-1");
  });

  it("a ready row with a PR offers the merge command", () => {
    const row = rowOf(input({ verdict: verdict({ prUrl: "https://x/pr/1" }) }));
    expect(row.nextCommand).toBe("gh pr merge https://x/pr/1 --squash");
  });

  it("a ready row without a PR falls back to status --ready", () => {
    const row = rowOf(input({ verdict: verdict() }));
    expect(row.nextCommand).toBe("captain status --ready");
  });

  it("an in-flight row offers a screen peek", () => {
    const row = rowOf(input({ run: "running" }));
    expect(row.nextCommand).toBe("cmux read-screen --workspace ws-1");
  });
});

describe("stateHash", () => {
  it("two rows with identical actionable state share a hash", () => {
    const a = rowOf(input({ feed: [feedItem({ id: "feed-1" })] }));
    const b = rowOf(
      input({
        cwd: "/wt/tig-2",
        fallbackName: "tig-2",
        feed: [feedItem({ cwd: "/wt/tig-2", id: "feed-1" })],
        workspaceId: "ws-2",
      })
    );
    // identity (name/cwd/ws) differs, actionable state does not
    expect(a.stateHash).toBe(b.stateHash);
  });

  it("a gate change flips the hash", () => {
    const before = rowOf(input({ run: "running" }));
    const after = rowOf(input({ feed: [feedItem()], run: "running" }));
    expect(after.stateHash).not.toBe(before.stateHash);
  });

  it("a verdict transition flips the hash", () => {
    const flowing = rowOf(input({ run: "idle" }));
    const ready = rowOf(input({ run: "idle", verdict: verdict() }));
    expect(ready.stateHash).not.toBe(flowing.stateHash);
    expect(stateHash(ready)).toBe(ready.stateHash);
  });
});

const ws = (id: string, cwd: string, name = id): CmuxWorkspace => ({
  cwd,
  id,
  name,
  ref: `workspace:${id}`,
});

describe("pickAgentWorkspaces", () => {
  it("drops a group-anchor shell sharing the agent's cwd, either order", () => {
    const anchor = ws("WS-ANCHOR", "/wt/tig-491", "Group 1");
    const agent = ws("WS-AGENT", "/wt/tig-491", "tig-491");
    const runs = { "ws-agent": "needs-input" as const };
    expect(pickAgentWorkspaces([anchor, agent], runs)).toEqual([agent]);
    expect(pickAgentWorkspaces([agent, anchor], runs)).toEqual([agent]);
  });

  it("keeps the first workspace when none has an agent run state", () => {
    const a = ws("WS-A", "/wt/tig-1");
    const b = ws("WS-B", "/wt/tig-1");
    expect(pickAgentWorkspaces([a, b], {})).toEqual([a]);
  });

  it("never collapses distinct cwds and preserves order", () => {
    const a = ws("WS-A", "/wt/tig-1");
    const b = ws("WS-B", "/wt/tig-2");
    expect(pickAgentWorkspaces([a, b], { "ws-a": "running" })).toEqual([a, b]);
  });
});

const entry = (
  workspaceId: string,
  name: string,
  repo: string,
  files: string[]
) => ({ files, name, repo, workspaceId });

describe("mergeOrderHints", () => {
  it("flags both sides of a same-repo changed-file overlap", () => {
    const hints = mergeOrderHints([
      entry("ws-a", "linkiq-tig-494", "linkiq", [
        "recommendations.schema.ts",
        "a.ts",
      ]),
      entry("ws-b", "linkiq-tig-496", "linkiq", [
        "recommendations.schema.ts",
        "b.ts",
      ]),
    ]);
    expect(hints["ws-a"]).toContain("overlaps linkiq-tig-496");
    expect(hints["ws-a"]).toContain("recommendations.schema.ts");
    expect(hints["ws-b"]).toContain("overlaps linkiq-tig-494");
  });

  it("ignores overlapping paths across different repos", () => {
    const hints = mergeOrderHints([
      entry("ws-a", "linkiq-tig-494", "linkiq", ["src/index.ts"]),
      entry("ws-b", "chat-tig-487", "chat", ["src/index.ts"]),
    ]);
    expect(hints).toEqual({});
  });

  it("stays silent when branches touch disjoint files", () => {
    const hints = mergeOrderHints([
      entry("ws-a", "linkiq-tig-494", "linkiq", ["a.ts"]),
      entry("ws-b", "linkiq-tig-496", "linkiq", ["b.ts"]),
    ]);
    expect(hints).toEqual({});
  });

  it("truncates a long shared-file list", () => {
    const shared = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const hints = mergeOrderHints([
      entry("ws-a", "x-tig-1", "x", shared),
      entry("ws-b", "x-tig-2", "x", shared),
    ]);
    expect(hints["ws-a"]).toContain("(+2 more)");
  });
});
