// 100% PURE (lint-enforced: no fs/subprocess). One task file: frontmatter the
// chat and the CLI both read, then a free markdown body that is the contract.
// The file is the task list's only record: the chat edits it directly, `captain`
// commands write it through here, and nothing else holds task state.

const STATES = ["todo", "active", "done", "dropped"] as const;
export type TaskState = (typeof STATES)[number];

export const HARNESSES = ["claude", "codex", "cursor"] as const;
export type Harness = (typeof HARNESSES)[number];

// `escalate` routes the task to Claude Code in plan mode, so a human approves
// the plan before any code: auth, billing, data migrations, deletes, public
// contracts, build and release config.
export const RISKS = ["low", "escalate"] as const;
export type Risk = (typeof RISKS)[number];

export interface Task {
  id: string;
  title: string;
  state: TaskState;
  risk: Risk;
  harness: Harness;
  // empty means the configured default for the harness
  model: string;
  effort: string;
  // ids of tasks (or tickets) that must be done before this one starts
  blockedBy: string[];
  // where the task came from: a ticket URL/id, or empty for a chat message
  source: string;
  // set by `captain start`
  branch: string;
  worktree: string;
  created: string;
  // the contract, verbatim markdown
  body: string;
}

const FENCE = "---";

// The frontmatter order on disk. Stable so a diff of the task list reads well.
const KEYS: (keyof Task)[] = [
  "id",
  "title",
  "state",
  "risk",
  "harness",
  "model",
  "effort",
  "blockedBy",
  "source",
  "branch",
  "worktree",
  "created",
];

const pick = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T
): T => {
  const v = (value ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
};

export const parseList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

// Parse a task file. Fail-safe: unknown keys are ignored and bad enum values
// fall back to the defaults, because the chat writes these files by hand and a
// typo must degrade one field, never lose the task.
export const parseTask = (text: string, fallbackId: string): Task => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const fields: Record<string, string> = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === FENCE) {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === FENCE);
    if (end !== -1) {
      for (const line of lines.slice(1, end)) {
        const at = line.indexOf(":");
        if (at > 0) {
          fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
        }
      }
      bodyStart = end + 1;
    }
  }
  return {
    blockedBy: parseList(fields.blockedBy),
    body: lines.slice(bodyStart).join("\n").trim(),
    branch: fields.branch ?? "",
    created: fields.created ?? "",
    effort: fields.effort ?? "",
    harness: pick(fields.harness, HARNESSES, "claude"),
    id: (fields.id || fallbackId).toLowerCase(),
    model: fields.model ?? "",
    risk: pick(fields.risk, RISKS, "low"),
    source: fields.source ?? "",
    state: pick(fields.state, STATES, "todo"),
    title: fields.title ?? "",
    worktree: fields.worktree ?? "",
  };
};

// Frontmatter values are single-line by construction.
const oneLine = (value: string): string => value.replaceAll(/\s*\n\s*/gu, " ");

export const renderTask = (task: Task): string => {
  const head = KEYS.map((key) => {
    const value = task[key];
    const text = oneLine(Array.isArray(value) ? value.join(", ") : value);
    return text ? `${key}: ${text}` : `${key}:`;
  });
  return `${FENCE}\n${head.join("\n")}\n${FENCE}\n\n${task.body.trim()}\n`;
};

// The acceptance criteria are the body's checklist lines (`- [ ] ...`), one
// rubric criterion each. Everything else in the body is the contract prose.
const CHECKBOX = /^\s*[-*] \[[ xX]\] (.+)$/u;

export const criteriaOf = (body: string): string[] =>
  body
    .split("\n")
    .map((line) => CHECKBOX.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);

// Task ids are lowercase ticket ids (tig-430, db-35a2097c) or `t-<n>` for a
// task that came from a chat message.
export const nextMessageId = (existing: string[]): string => {
  let max = 0;
  for (const id of existing) {
    const n = /^t-(\d+)$/u.exec(id)?.[1];
    if (n !== undefined) {
      max = Math.max(max, Number(n));
    }
  }
  return `t-${max + 1}`;
};

// The title of a message task: its first line, trimmed to a readable length.
export const titleFromMessage = (message: string): string => {
  const first = message.trim().split("\n")[0]?.trim() ?? "";
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}...` : first;
};

// The review harness defaults to the other vendor, so a model never grades its
// own family's work.
export const otherVendor = (harness: Harness): Harness =>
  harness === "codex" ? "claude" : "codex";
