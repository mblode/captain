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

export interface LinearIssue {
  identifier: string;
  title?: string | null;
  description?: string | null;
  team?: { name?: string | null } | null;
  labels?: { nodes?: { name?: string | null }[] | null } | null;
  project?: { name?: string | null } | null;
  parent?: LinearRelatedIssue | null;
  children?: { nodes?: LinearRelatedIssue[] | null } | null;
}

export interface LinearRelatedIssue {
  identifier: string;
  id?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface LinearGraphqlResponse {
  data?: {
    issue?: LinearIssue | null;
  };
}

export interface CliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  print?: boolean;
  repoOverride?: string;
  // branch new worktrees off this ref instead of origin's default branch
  base?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  tokens: string[];
}

// `captain dispatch` — a free-form task with no Linear issue and no worktree,
// run in the current checkout.
export interface DispatchOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  print?: boolean;
  repoOverride?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  // the plain-text task the agent should drive to PR-ready
  task: string;
  // workspace label (slugified); defaults to a slug of the task
  name?: string;
}
