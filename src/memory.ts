import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { captainHome } from "./home";

// Cross-session fleet memory: one markdown file per repo that fan-out prompts
// consult and agents append verified learnings to. `## Rules` is the curated,
// always-injected section (promoted by the captain skill's distill workflow);
// `## Inbox` is where agents append raw learnings, and only its tail is injected
// — uncurated entries age out of the window automatically, so unreviewed slop
// degrades to "less help", never "active harm".
const RULES_HEADING = "## Rules";
const INBOX_HEADING = "## Inbox";

// Headings are located at LINE START, never by substring. The file's own prose
// can name a heading inline (the old skeleton's preamble did), and with `## Inbox`
// mentioned before `## Rules`, indexOf ordered the two matches backwards — the
// rules slice came out EMPTY and the curated section was silently dropped from
// every brief. Anchoring to a line makes prose unmatchable.
const headingAt = (content: string, heading: string): number =>
  new RegExp(`^${heading}[ \\t]*$`, "mu").exec(content)?.index ?? -1;

// Injection caps: keep the excerpt a small, fixed prompt cost.
const INBOX_MAX_ENTRIES = 20;
const EXCERPT_MAX_CHARS = 2048;
const TRUNCATION_MARKER = "[… truncated]";

// Deliberately states no append policy: the brief is the single owner of what an
// agent may append (prompt.ts). The old skeleton restated it as "1-3 bullets",
// which then contradicted the brief's "zero or one" forever — ensureMemoryFile
// only writes this when the file is ABSENT, so a stale policy never refreshes,
// and agents followed the file. It also names no heading inline, so the prose can
// never shadow the real headings.
const SKELETON = `# Fleet learnings

Shared memory for every worktree of this repo. Curated rules come first and are
always injected; the inbox is where agents append. Humans (the captain skill):
periodically distill the inbox into the rules and delete what didn't hold up.

${RULES_HEADING}

${INBOX_HEADING}
`;

// Scoped per repo (worktrees of one repo share it; repos never cross-contaminate)
// and kept OUTSIDE the worktrees so it survives `git worktree remove`.
// CAPTAIN_MEMORY_DIR overrides the root — tests use it to stay out of real $HOME.
//
// Multi-repo disambiguation: keying on `basename(repoRoot)` alone collides when
// two repos share a basename under different parents. We disambiguate with a
// short hash of the full repoRoot, but keep returning the LEGACY bare-basename
// path when it already exists, so existing users' memory keeps working untouched.
export const memoryPath = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const base = env.CAPTAIN_MEMORY_DIR ?? join(captainHome(env), "memory");
  const legacy = join(base, basename(repoRoot), "learnings.md");
  if (existsSync(legacy)) {
    return legacy;
  }
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
  return join(base, `${basename(repoRoot)}-${hash}`, "learnings.md");
};

export const ensureMemoryFile = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const path = memoryPath(repoRoot, env);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SKELETON);
  }
  return path;
};

const learningKey = (line: string): string =>
  line
    .trim()
    .replace(/^-\s+(?:\[[^\]]+\]\s*)?/u, "")
    .trim();

// Keep the prompt budget fail-safe without emitting half an instruction. Long
// content is clipped only between lines and carries an explicit marker. If the
// first line alone is over budget, the marker is safer than a misleading
// fragment of it.
const clipWholeLines = (content: string): string => {
  if (content.length <= EXCERPT_MAX_CHARS) {
    return content;
  }
  const budget = EXCERPT_MAX_CHARS - TRUNCATION_MARKER.length - 1;
  const kept: string[] = [];
  let length = 0;
  for (const line of content.split("\n")) {
    const nextLength = length + (kept.length > 0 ? 1 : 0) + line.length;
    if (nextLength > budget) {
      break;
    }
    kept.push(line);
    length = nextLength;
  }
  return kept.length > 0
    ? `${kept.join("\n")}\n${TRUNCATION_MARKER}`
    : TRUNCATION_MARKER;
};

// Pure: slice the excerpt out of the file content — curated rules first, then
// the newest unique inbox entries. The single total cap includes both sections
// (String.length counts UTF-16 code units, not bytes).
export const memoryExcerptOf = (content: string): string => {
  const inboxAt = headingAt(content, INBOX_HEADING);
  const rulesAt = headingAt(content, RULES_HEADING);
  if (rulesAt === -1 && inboxAt === -1) {
    return clipWholeLines(content.trim());
  }

  // A heading with nothing under it (the skeleton) contributes nothing.
  let rules = "";
  const seen = new Set<string>();
  if (rulesAt !== -1) {
    const lines = content
      .slice(rulesAt, inboxAt === -1 ? content.length : inboxAt)
      .trim()
      .split("\n");
    const unique = lines.filter((line) => {
      if (!line.trim().startsWith("- ")) {
        return true;
      }
      const key = learningKey(line);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    if (unique.join("\n") !== RULES_HEADING) {
      rules = unique.join("\n");
    }
  }

  let inbox = "";
  if (inboxAt !== -1) {
    const entries = content
      .slice(inboxAt + INBOX_HEADING.length)
      .split("\n")
      .filter((l) => l.trim().startsWith("- "));
    const tail = entries
      .toReversed()
      .filter((entry) => {
        const key = learningKey(entry);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .slice(0, INBOX_MAX_ENTRIES);
    const chronologicalTail = tail.toReversed();
    if (chronologicalTail.length > 0) {
      inbox = `${INBOX_HEADING}\n${chronologicalTail.join("\n")}`;
    }
  }

  const excerpt = [rules, inbox].filter(Boolean).join("\n\n").trim();
  if (excerpt.length <= EXCERPT_MAX_CHARS) {
    return excerpt;
  }

  // Rules are curated and therefore win the fixed prompt budget. Inbox lines
  // are removed oldest-first before the rules themselves are clipped.
  const inboxLines = inbox ? inbox.split("\n").slice(1) : [];
  let bounded = excerpt;
  while (inboxLines.length > 0 && bounded.length > EXCERPT_MAX_CHARS) {
    inboxLines.shift();
    const keptInbox =
      inboxLines.length > 0 ? `${INBOX_HEADING}\n${inboxLines.join("\n")}` : "";
    bounded = [rules, keptInbox].filter(Boolean).join("\n\n").trim();
  }
  return clipWholeLines(bounded);
};

// What `captain gain` reports per repo about its memory file — the curation
// nudge. Pure over the file's content; the fs read is listMemoryFiles below.
export interface MemoryStats {
  // the memory dir's name for this repo (basename, or basename-hash)
  repo: string;
  rules: number;
  inbox: number;
  // inbox bullets past INBOX_MAX_ENTRIES — written by agents, injected into no
  // brief, read by nobody until a human distills
  beyondTail: number;
  // age in days of the oldest inbox bullet carrying a `[TICKET YYYY-MM-DD]`
  // tag; absent when none is tagged
  oldestInboxDays?: number;
  // backticked tokens (commands, env names, flags) named by 2+ distinct inbox
  // bullets, most-named first — the "same trap twice" signal, capped
  recurring: { token: string; count: number }[];
}

const RECURRING_MAX = 5;
const DAY_SECONDS = 86_400;

const bulletsUnder = (content: string, from: number, to: number): string[] =>
  content
    .slice(from, to)
    .split("\n")
    .filter((line) => line.trim().startsWith("- "));

// PURE: stats over one learnings.md. `now` is epoch seconds (injected, like
// gain's). A file with neither heading reads as all-inbox: uncurated by
// definition.
export const memoryStatsOf = (
  repo: string,
  content: string,
  now: number
): MemoryStats => {
  const rulesAt = headingAt(content, RULES_HEADING);
  const inboxAt = headingAt(content, INBOX_HEADING);
  const rules =
    rulesAt === -1
      ? []
      : bulletsUnder(
          content,
          rulesAt,
          inboxAt > rulesAt ? inboxAt : content.length
        );
  let inbox: string[] = [];
  if (inboxAt !== -1) {
    inbox = bulletsUnder(
      content,
      inboxAt,
      rulesAt > inboxAt ? rulesAt : content.length
    );
  } else if (rulesAt === -1) {
    // no headings at all: every bullet is uncurated by definition
    inbox = bulletsUnder(content, 0, content.length);
  }

  let oldest: number | undefined;
  for (const line of inbox) {
    const tag = /^\s*-\s+\[[^\]\s]+\s+(\d{4}-\d{2}-\d{2})\]/u.exec(line);
    if (!tag) {
      continue;
    }
    const ms = Date.parse(`${tag[1]}T00:00:00Z`);
    if (!Number.isNaN(ms)) {
      const ts = Math.floor(ms / 1000);
      oldest = oldest === undefined ? ts : Math.min(oldest, ts);
    }
  }

  // One count per bullet per token (a bullet naming `yarn test` twice is one
  // sighting), so `count` is "how many bullets hit this trap".
  const mentions = new Map<string, number>();
  for (const line of inbox) {
    const tokens = new Set(
      [...line.matchAll(/`([^`\n]{2,60})`/gu)].map((m) => m[1].trim())
    );
    for (const token of tokens) {
      mentions.set(token, (mentions.get(token) ?? 0) + 1);
    }
  }
  const recurring = [...mentions.entries()]
    .filter(([, count]) => count >= 2)
    .map(([token, count]) => ({ count, token }))
    .toSorted((a, b) => b.count - a.count || a.token.localeCompare(b.token))
    .slice(0, RECURRING_MAX);

  return {
    beyondTail: Math.max(0, inbox.length - INBOX_MAX_ENTRIES),
    inbox: inbox.length,
    ...(oldest === undefined
      ? {}
      : {
          oldestInboxDays: Math.max(
            0,
            Math.floor((now - oldest) / DAY_SECONDS)
          ),
        }),
    recurring,
    repo,
    rules: rules.length,
  };
};

// Every repo's memory file under the memory root, for `captain gain`: a
// stateless directory listing, fail-soft to []. The dir name is the repo key
// (basename, or basename-hash for a disambiguated repo).
export const listMemoryFiles = (
  env: NodeJS.ProcessEnv = process.env
): { repo: string; path: string }[] => {
  const base = env.CAPTAIN_MEMORY_DIR ?? join(captainHome(env), "memory");
  let dirs: string[];
  try {
    dirs = readdirSync(base);
  } catch {
    return [];
  }
  return dirs
    .toSorted((a, b) => a.localeCompare(b))
    .flatMap((dir) => {
      const path = join(base, dir, "learnings.md");
      return existsSync(path) ? [{ path, repo: dir }] : [];
    });
};

// The injectable excerpt; empty string when the file is missing or has nothing
// beyond the skeleton (so the prompt section is simply omitted).
export const readMemoryExcerpt = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const path = memoryPath(repoRoot, env);
  if (!existsSync(path)) {
    return "";
  }
  return memoryExcerptOf(readFileSync(path, "utf-8"));
};
