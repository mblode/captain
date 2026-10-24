import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureMemoryFile, memoryExcerptOf, readMemoryExcerpt } from "./memory";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const tmpPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "captain-memory-"));
  cleanup.push(dir);
  return join(dir, "project", "learnings.md");
};

describe("ensureMemoryFile", () => {
  it("creates the skeleton once and leaves an existing file alone", () => {
    const path = ensureMemoryFile(tmpPath());
    expect(existsSync(path)).toBe(true);
    const skeleton = readFileSync(path, "utf-8");
    expect(skeleton).toContain("## Rules");
    expect(skeleton).toContain("## Inbox");
    // Idempotent: a second start must not clobber accumulated learnings.
    expect(ensureMemoryFile(path)).toBe(path);
    expect(readFileSync(path, "utf-8")).toBe(skeleton);
  });
});

describe("memoryExcerptOf", () => {
  it("is empty for the bare skeleton (nothing learned yet)", () => {
    const path = ensureMemoryFile(tmpPath());
    expect(readMemoryExcerpt(path)).toBe("");
  });

  it("is empty when the file is missing", () => {
    expect(readMemoryExcerpt(tmpPath())).toBe("");
  });

  it("includes all rules and the inbox entries", () => {
    const excerpt = memoryExcerptOf(
      [
        "# Fleet learnings",
        "",
        "## Rules",
        "- always run yarn install first",
        "",
        "## Inbox",
        "- [TIG-1 2026-06-01] the test runner needs FORCE_COLOR=0",
      ].join("\n")
    );
    expect(excerpt).toContain("- always run yarn install first");
    expect(excerpt).toContain("FORCE_COLOR=0");
  });

  // Regression: every case above hand-builds content with no preamble, which is
  // exactly how the curated section could be dropped in production unnoticed.
  // Drive the REAL skeleton so the file's own prose is part of the input.
  it("injects curated rules promoted into the real skeleton", () => {
    const path = ensureMemoryFile(tmpPath());
    const promoted = "- always run yarn install in a fresh worktree";
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(
        "## Rules\n",
        `## Rules\n${promoted}\n`
      )
    );
    expect(readMemoryExcerpt(path)).toContain(promoted);
  });

  it("ignores headings named in prose rather than at a line start", () => {
    // The legacy on-disk preamble mentions ## Inbox BEFORE ## Rules; locating
    // headings by substring ordered them backwards and emptied the rules slice.
    const excerpt = memoryExcerptOf(
      [
        "# Fleet learnings",
        "",
        "Agents: append to ## Inbox. Humans: distill ## Inbox into ## Rules.",
        "",
        "## Rules",
        "- curated: the build needs node 22",
        "",
        "## Inbox",
        "- [TIG-1 2026-06-01] a raw learning",
      ].join("\n")
    );
    expect(excerpt).toContain("- curated: the build needs node 22");
    expect(excerpt).toContain("a raw learning");
    // the preamble itself is never injected
    expect(excerpt).not.toContain("Humans: distill");
  });

  it("caps the inbox to its tail so uncurated slop ages out", () => {
    const entries = Array.from(
      { length: 50 },
      (_, i) => `- [TIG-${i} 2026-06-01] rule number ${i}`
    );
    const excerpt = memoryExcerptOf(
      `## Rules\n\n## Inbox\n${entries.join("\n")}\n`
    );
    expect(excerpt).not.toContain("rule number 0");
    expect(excerpt).not.toContain("rule number 29");
    expect(excerpt).toContain("rule number 30");
    expect(excerpt).toContain("rule number 49");
  });

  it("deduplicates exact learning text across rules and the inbox", () => {
    const excerpt = memoryExcerptOf(
      [
        "## Rules",
        "- run yarn install first",
        "- run yarn install first",
        "",
        "## Inbox",
        "- [TIG-1 2026-06-01] run yarn install first",
        "- [TIG-2 2026-06-02] set FORCE_COLOR=0",
        "- [TIG-3 2026-06-03] set FORCE_COLOR=0",
      ].join("\n")
    );
    expect(excerpt.match(/run yarn install first/gu)).toHaveLength(1);
    expect(excerpt.match(/set FORCE_COLOR=0/gu)).toHaveLength(1);
    expect(excerpt).toContain("TIG-3");
  });

  it("caps the entire injected excerpt including curated rules", () => {
    const oversizedRule = `- ${"x".repeat(5000)}`;
    const excerpt = memoryExcerptOf(
      `## Rules\n${oversizedRule}\n\n## Inbox\n- newest trap\n`
    );
    expect(excerpt.length).toBeLessThanOrEqual(2048);
    expect(excerpt).toContain("[… truncated]");
    expect(excerpt).not.toContain(oversizedRule.slice(0, 100));
  });
});
