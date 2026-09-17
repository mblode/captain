import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureMemoryFile,
  listMemoryFiles,
  memoryExcerptOf,
  memoryPath,
  memoryStatsOf,
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
  it("reuses the legacy bare-basename path when it already exists", () => {
    const env = tmpEnv();
    const legacy = join(
      env.CAPTAIN_MEMORY_DIR as string,
      "frontyard",
      "learnings.md"
    );
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, "old learnings\n");
    expect(memoryPath("/code/frontyard", env)).toBe(legacy);
  });

  it("disambiguates with a repoRoot hash when no legacy path exists", () => {
    const env = tmpEnv();
    const path = memoryPath("/code/frontyard", env);
    expect(path.startsWith(env.CAPTAIN_MEMORY_DIR as string)).toBe(true);
    expect(path.endsWith("/learnings.md")).toBe(true);
    // basename(repoRoot) + an 8-char hex suffix
    expect(/\/frontyard-[0-9a-f]{8}\/learnings\.md$/u.test(path)).toBe(true);
  });

  it("gives two same-basename repos distinct memory paths", () => {
    const env = tmpEnv();
    const a = memoryPath("/code/frontyard", env);
    const b = memoryPath("/elsewhere/frontyard", env);
    expect(a).not.toBe(b);
    // both still live under a frontyard-* directory, just disambiguated
    expect(a).toContain("/frontyard-");
    expect(b).toContain("/frontyard-");
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

  // Regression: every case above hand-builds content with no preamble, which is
  // exactly how the curated section could be dropped in production unnoticed.
  // Drive the REAL skeleton so the file's own prose is part of the input.
  it("injects curated rules promoted into the real skeleton", () => {
    const env = tmpEnv();
    const path = ensureMemoryFile("/code/repo", env);
    const promoted = "- always run yarn install in a fresh worktree";
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace(
        "## Rules\n",
        `## Rules\n${promoted}\n`
      )
    );
    expect(readMemoryExcerpt("/code/repo", env)).toContain(promoted);
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

// `captain gain`'s MEMORY block: pure stats over a learnings.md, and the
// fail-soft directory listing that feeds it.
describe("memoryStatsOf", () => {
  const NOW = Math.floor(Date.parse("2026-09-17T12:00:00Z") / 1000);
  const file = [
    "# Fleet learnings",
    "",
    "Prose that mentions ## Inbox inline must not count as a heading.",
    "",
    "## Rules",
    "",
    "- Always run `yarn test --maxWorkers=2`.",
    "- Never touch `config/auth.ts` without the security skill.",
    "",
    "## Inbox",
    "",
    "- [TIG-1 2026-08-01] `yarn test` OOMs without `--maxWorkers=2`.",
    "- [TIG-2 2026-08-20] `yarn test` needs `--maxWorkers=2` on this repo too.",
    "- [TIG-3 2026-09-01] `pnpm lint` reorders imports; run it before commit.",
    "- untagged bullet with `yarn test` again",
    "",
  ].join("\n");

  it("counts rules and inbox bullets, ages the oldest tagged bullet, and finds recurring tokens", () => {
    const stats = memoryStatsOf("frontyard", file, NOW);
    expect(stats).toEqual({
      beyondTail: 0,
      inbox: 4,
      // 2026-08-01 → 2026-09-17 is 47 days
      oldestInboxDays: 47,
      recurring: [
        { count: 3, token: "yarn test" },
        { count: 2, token: "--maxWorkers=2" },
      ],
      repo: "frontyard",
      rules: 2,
    });
  });

  it("counts one sighting per bullet per token, and needs two bullets to recur", () => {
    const stats = memoryStatsOf(
      "r",
      "## Rules\n\n## Inbox\n\n- `a` and `a` and `a` again\n- `b`\n",
      NOW
    );
    expect(stats.recurring).toEqual([]);
    expect(stats.inbox).toBe(2);
  });

  it("reports how many inbox bullets fell beyond the injected tail", () => {
    const bullets = Array.from({ length: 25 }, (_, i) => `- bullet ${i}`).join(
      "\n"
    );
    const stats = memoryStatsOf(
      "r",
      `## Rules\n\n## Inbox\n\n${bullets}\n`,
      NOW
    );
    expect(stats.inbox).toBe(25);
    expect(stats.beyondTail).toBe(5);
    expect(stats.oldestInboxDays).toBeUndefined();
  });

  it("a file with no headings is all inbox — uncurated by definition", () => {
    const stats = memoryStatsOf("r", "- one\n- two\n", NOW);
    expect(stats).toMatchObject({ inbox: 2, rules: 0 });
  });

  it("drives the real SKELETON to zero everywhere", () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-memstats-"));
    cleanup.push(dir);
    const path = ensureMemoryFile("/repos/app", { CAPTAIN_MEMORY_DIR: dir });
    const stats = memoryStatsOf("app", readFileSync(path, "utf-8"), NOW);
    expect(stats).toMatchObject({
      beyondTail: 0,
      inbox: 0,
      recurring: [],
      rules: 0,
    });
  });
});

describe("listMemoryFiles", () => {
  it("lists every repo dir that holds a learnings.md, sorted, and is [] when the root is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "captain-memlist-"));
    cleanup.push(dir);
    const env = { CAPTAIN_MEMORY_DIR: dir };
    ensureMemoryFile("/repos/zeta", env);
    ensureMemoryFile("/repos/alpha", env);
    mkdirSync(join(dir, "empty-dir"));
    const listed = listMemoryFiles(env);
    expect(listed.map((m) => m.repo)).toEqual(
      listed.map((m) => m.repo).toSorted((a, b) => a.localeCompare(b))
    );
    expect(listed).toHaveLength(2);
    expect(listed.every((m) => existsSync(m.path))).toBe(true);
    expect(listMemoryFiles({ CAPTAIN_MEMORY_DIR: join(dir, "nope") })).toEqual(
      []
    );
  });
});
