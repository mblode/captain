import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Injection caps: keep the excerpt a small, fixed prompt cost.
const INBOX_MAX_ENTRIES = 20;
const INBOX_MAX_CHARS = 4096;

const SKELETON = `# Fleet learnings

Shared memory for every worktree of this repo. Agents: append 1-3 verified,
general bullets to ${INBOX_HEADING} at the end of a run. Humans (the captain
skill): periodically distill ${INBOX_HEADING} into ${RULES_HEADING} and delete
what didn't hold up.

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

// Pure: slice the excerpt out of the file content — all of `## Rules`, plus the
// tail of `## Inbox` capped by entry count and character length (String.length
// counts UTF-16 code units, not bytes).
export const memoryExcerptOf = (content: string): string => {
  const inboxAt = content.indexOf(INBOX_HEADING);
  const rulesAt = content.indexOf(RULES_HEADING);
  if (rulesAt === -1 && inboxAt === -1) {
    return content.trim();
  }

  // A heading with nothing under it (the skeleton) contributes nothing.
  let rules = "";
  if (rulesAt !== -1) {
    const section = content
      .slice(rulesAt, inboxAt === -1 ? content.length : inboxAt)
      .trim();
    if (section !== RULES_HEADING) {
      rules = section;
    }
  }

  let inbox = "";
  if (inboxAt !== -1) {
    const entries = content
      .slice(inboxAt + INBOX_HEADING.length)
      .split("\n")
      .filter((l) => l.trim().startsWith("- "));
    let tail = entries.slice(-INBOX_MAX_ENTRIES);
    while (tail.length > 1 && tail.join("\n").length > INBOX_MAX_CHARS) {
      tail = tail.slice(1);
    }
    if (tail.length > 0) {
      inbox = `${INBOX_HEADING}\n${tail.join("\n")}`;
    }
  }

  return [rules, inbox].filter(Boolean).join("\n\n").trim();
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
