import { describe, expect, it } from "vitest";

import {
  criteriaOf,
  nextMessageId,
  otherVendor,
  parseTask,
  renderTask,
  titleFromMessage,
} from "./task";
import type { Task } from "./task";

const task = (over: Partial<Task> = {}): Task => ({
  blockedBy: ["t-1", "tig-9"],
  body: "Rebuild billing settings.\n\n## Acceptance criteria\n\n- [ ] Plans list renders\n- [x] Old URL redirects",
  branch: "",
  created: "2026-09-22",
  effort: "",
  harness: "codex",
  id: "t-2",
  model: "",
  risk: "low",
  source: "",
  state: "todo",
  title: "Billing settings",
  worktree: "",
  ...over,
});

describe("task files", () => {
  it("round-trips through render and parse", () => {
    const t = task({ branch: "t-2-billing", state: "active" });
    expect(parseTask(renderTask(t), "ignored")).toEqual(t);
  });

  it("keeps frontmatter values on one line", () => {
    const text = renderTask(task({ title: "two\nlines" }));
    expect(text).toContain("title: two lines\n");
  });

  it("degrades a bad field instead of losing the task", () => {
    const t = parseTask(
      "---\nid: T-3\nstate: finished\nharness: gemini\nrisk: HIGH\n---\nbody",
      "x"
    );
    expect(t).toMatchObject({
      body: "body",
      harness: "claude",
      id: "t-3",
      risk: "low",
      state: "todo",
    });
  });

  it("falls back to the file name for the id, and the whole text for the body", () => {
    const t = parseTask("just a note the chat wrote", "t-7");
    expect(t.id).toBe("t-7");
    expect(t.body).toBe("just a note the chat wrote");
  });
});

describe("criteriaOf", () => {
  it("reads checked and unchecked checklist lines", () => {
    expect(criteriaOf(task().body)).toEqual([
      "Plans list renders",
      "Old URL redirects",
    ]);
  });

  it("is empty when the body has no checklist", () => {
    expect(criteriaOf("plain prose\n- a bullet")).toEqual([]);
  });
});

describe("ids and titles", () => {
  it("numbers message tasks after the highest existing one", () => {
    expect(nextMessageId([])).toBe("t-1");
    expect(nextMessageId(["t-2", "tig-40", "t-10"])).toBe("t-11");
  });

  it("titles a message by its first line, trimmed", () => {
    expect(titleFromMessage("  fix login\nmore detail")).toBe("fix login");
    expect(titleFromMessage("x".repeat(100))).toHaveLength(80);
  });

  it("reviews with the other vendor", () => {
    expect(otherVendor("claude")).toBe("codex");
    expect(otherVendor("cursor")).toBe("codex");
    expect(otherVendor("codex")).toBe("claude");
  });
});
