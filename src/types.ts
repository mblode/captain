export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stdio?: "pipe" | "inherit";
}

export interface ParsedIssue {
  displayId: string;
  issueId: string;
  slug: string;
}

export interface ResolvedRepo {
  repoRoot: string;
}

export interface WorktreeResult {
  branch: string;
  worktreePath: string;
}

// The source-neutral issue contract the whole pipeline consumes (worktree
// naming, rubric, prompt). Linear issues and donebear tasks both map INTO this
// (see linear.ts / donebear.ts); nothing downstream knows which source it came
// from — only the brief's source label differs.
export interface Issue {
  identifier: string;
  title?: string | null;
  description?: string | null;
  // acceptance sub-items — one rubric criterion each, also listed in the brief.
  // A Linear sub-issue or a donebear checklist item.
  criteria?: IssueCriterion[] | null;
  // issues that must finish before this one can start. Absent ⇒ unblocked:
  // sources without a dependency concept (donebear) simply leave it unset.
  blockedBy?: IssueBlocker[] | null;
  // Linear-provided context, all optional — other sources leave these unset.
  labels?: { nodes?: { name?: string | null }[] | null } | null;
  team?: { name?: string | null } | null;
  project?: { name?: string | null } | null;
  parent?: IssueCriterion | null;
}

// One blocking issue. `done` is the only thing the frontier rule needs, so the
// source resolves the tracker's own state vocabulary into a boolean here.
export interface IssueBlocker {
  identifier: string;
  done: boolean;
}

// One referenced sub-item of an issue (an acceptance criterion, or the parent
// for context). `ref` is a display handle — a Linear identifier like "ENG-404",
// absent for a bare donebear checklist item.
export interface IssueCriterion {
  ref?: string;
  title: string;
  description?: string | null;
}

// Raw Linear GraphQL shapes (api.linear.app) — mapped into Issue by linear.ts.
export interface LinearApiRelated {
  identifier: string;
  title?: string | null;
  description?: string | null;
}

interface LinearApiRelationEnd {
  identifier: string;
  state?: { type?: string | null } | null;
}

// A relation record names both ends; which end is "this" issue depends on
// whether it was reached via relations or inverseRelations, so both are
// selected and the mapper picks the end that is not the issue itself.
export interface LinearApiRelation {
  type?: string | null;
  issue?: LinearApiRelationEnd | null;
  relatedIssue?: LinearApiRelationEnd | null;
}

export interface LinearApiIssue {
  identifier: string;
  title?: string | null;
  description?: string | null;
  team?: { name?: string | null } | null;
  labels?: { nodes?: { name?: string | null }[] | null } | null;
  project?: { name?: string | null } | null;
  parent?: LinearApiRelated | null;
  children?: { nodes?: LinearApiRelated[] | null } | null;
  inverseRelations?: { nodes?: LinearApiRelation[] | null } | null;
}

export interface LinearGraphqlResponse {
  data?: {
    issue?: LinearApiIssue | null;
  };
}

// Done Bear GraphQL shapes (api.donebear.com). Mapped INTO Issue by donebear.ts
// so the whole worktree/rubric/prompt pipeline stays source-agnostic.
export interface DonebearTask {
  id: string;
  key?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface DonebearChecklistItem {
  id: string;
  title?: string | null;
  sortOrder?: number | null;
  // null ⇒ the item is still unchecked (an open acceptance criterion)
  completedAt?: string | null;
}

export interface DonebearGraphqlResponse {
  data?: {
    task?: DonebearTask | null;
    taskChecklistItems?: { nodes?: DonebearChecklistItem[] | null } | null;
  };
}

export interface CliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  print?: boolean;
  repoOverride?: string;
  // branch new worktrees off this ref instead of origin's default branch
  base?: string;
  // launch even when an issue's blockers are still open (without it, fan-out
  // skips the blocked ticket and a single-issue start errors)
  force?: boolean;
  // machine output: emit a single {started:[...]} JSON value, suppress hints
  json?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  // which coding agent to launch: claude (default) or codex; overrides config
  agent?: string;
  tokens: string[];
}

// `captain dispatch` — a free-form task with no Linear issue and no worktree,
// run in the current checkout.
export interface DispatchOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  print?: boolean;
  repoOverride?: string;
  // machine output: emit a single {started:[...]} JSON value, suppress hints
  json?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  // the plain-text task the agent should drive to PR-ready
  task: string;
  // workspace label (slugified); defaults to a slug of the task
  name?: string;
  // which coding agent to launch: claude (default) or codex; overrides config
  agent?: string;
}
