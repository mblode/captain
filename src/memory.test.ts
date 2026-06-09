import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureMemoryFile,
  memoryExcerptOf,
  memoryPath,
  readMemoryExcerpt,
} from "./memory";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const tmpEnv = (): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(join(tmpdir(), "captain-memory-"));
  cleanup.push(dir);
  return { CAPTAIN_MEMORY_DIR: dir };
};

describe("memoryPath", () => {
  it("scopes per repo by basename", () => {
    const env = { CAPTAIN_MEMORY_DIR: "/mem" };
    expect(memoryPath("/code/frontyard", env)).toBe(
      "/mem/frontyard/learnings.md"
    );
    expect(memoryPath("/elsewhere/frontyard", env)).toBe(
      "/mem/frontyard/learnings.md"
    );
    expect(memoryPath("/code/other-repo", env)).toBe(
      "/mem/other-repo/learnings.md"
    );
  });
});

describe("ensureMemoryFile", () => {
  it("creates the skeleton once and leaves an existing file alone", () => {
    const env = tmpEnv();
    const path = ensureMemoryFile("/code/repo", env);
    expect(existsSync(path)).toBe(true);
    const skeleton = readFileSync(path, "utf-8");
    expect(skeleton).toContain("## Rules");
    expect(skeleton).toContain("## Inbox");
    // Idempotent: a second fan-out must not clobber accumulated learnings.
    expect(ensureMemoryFile("/code/repo", env)).toBe(path);
    expect(readFileSync(path, "utf-8")).toBe(skeleton);
  });
});

describe("memoryExcerptOf", () => {
  it("is empty for the bare skeleton (nothing learned yet)", () => {
    const env = tmpEnv();
    ensureMemoryFile("/code/repo", env);
    expect(readMemoryExcerpt("/code/repo", env)).toBe("");
  });

  it("is empty when the file is missing", () => {
    expect(readMemoryExcerpt("/code/repo", tmpEnv())).toBe("");
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
});
