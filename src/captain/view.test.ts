import { describe, expect, it } from "vitest";

import type { CmuxFeedItem } from "./control";
import type { Verdict } from "./verdict";
import {
  identityOf,
  mergeOrderHints,
  pendingGate,
  rowOf,
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
