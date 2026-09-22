import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Cross-session fleet memory: one markdown file per project that every brief
// consults and agents append verified learnings to. `## Rules` is the curated,
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

// Create the file with its skeleton when it is absent. It lives in the project
// folder, outside every worktree, so it survives `git worktree remove`.
export const ensureMemoryFile = (path: string): string => {
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

// The injectable excerpt; empty string when the file is missing or has nothing
// beyond the skeleton (so the prompt section is simply omitted).
export const readMemoryExcerpt = (path: string): string => {
  if (!existsSync(path)) {
    return "";
  }
  return memoryExcerptOf(readFileSync(path, "utf-8"));
};
