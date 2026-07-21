import { existsSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

import { CliError, EXIT } from "./errors";
import { run, runRequired } from "./shell";
import type { WorktreeResult } from "./types";

// The absolute path to a repo's common git dir: `.git` for a normal checkout,
// or the MAIN checkout's `.git` for a linked worktree (where the worktree's own
// `.git` is a FILE, so appending `info/exclude` under it would ENOTDIR). Relative
// `rev-parse` output is resolved against repoRoot; a git failure falls back to
// `<repoRoot>/.git`.
export const gitCommonDir = (
  repoRoot: string,
  env: NodeJS.ProcessEnv
): string => {
  const raw = run("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], {
    env,
  });
  const commonDir =
    raw.status === 0 ? raw.stdout.trim() : join(repoRoot, ".git");
  return isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir);
};

// Short repo label for a worktree path: a linked worktree's --git-common-dir
// resolves to the main checkout's .git, whose parent dir name is the repo
// ("linkiq"). Fail-soft: any git failure (not a repo, fake test path) →
// undefined, so the view never breaks on it.
export const repoLabel = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const raw = run("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { env });
  const common = raw.stdout.trim();
  if (raw.status !== 0 || !common) {
    return undefined;
  }
  const gitDir = isAbsolute(common) ? common : resolve(cwd, common);
  return basename(dirname(gitDir)) || undefined;
};

interface EnsureWorktreeOptions {
  env: NodeJS.ProcessEnv;
  issueId: string;
  repoRoot: string;
  slug: string;
  skipFetch?: boolean;
  // branch the new worktree off this ref (another worktree's branch, a tag, a
  // sha) instead of origin's default branch — lets a dependent ticket start
  // from its prerequisite's code before that lands on main
  base?: string;
}

// Resolve a user-supplied --base to something `worktree add` accepts: a local
// branch, its origin counterpart, or any committish — in that order.
const resolveBaseRef = (
  repoRoot: string,
  base: string,
  env: NodeJS.ProcessEnv
): string => {
  for (const candidate of [
    `refs/heads/${base}`,
    `refs/remotes/origin/${base}`,
  ]) {
    if (
      run(
        "git",
        ["-C", repoRoot, "show-ref", "--verify", "--quiet", candidate],
        {
          env,
        }
      ).status === 0
    ) {
      return candidate;
    }
  }
  if (
    run("git", ["-C", repoRoot, "rev-parse", "--verify", `${base}^{commit}`], {
      env,
    }).status === 0
  ) {
    return base;
  }
  throw new CliError(
    `cannot resolve --base ${base} (no local branch, origin branch, or commit)`
  );
};

export const fetchOrigin = (repoRoot: string, env: NodeJS.ProcessEnv): void => {
  const result = run("git", ["-C", repoRoot, "fetch", "origin", "--quiet"], {
    env,
  });
  if (result.status !== 0) {
    throw new CliError(
      `git fetch origin failed in ${repoRoot} — run \`git fetch origin\` there to diagnose; verify the origin remote and network, then retry`,
      EXIT.GENERIC,
      "GIT_FETCH_FAILED"
    );
  }
};

// Captain's issue worktree location is derivable from the repo and parsed issue
// id alone. Keeping this formula in one place lets the runner identify a live
// retry before fetching the issue or touching the worktree.
export const worktreePathFor = (repoRoot: string, issueId: string): string =>
  join(dirname(repoRoot), `${basename(repoRoot)}-${issueId}`);

const reuseExistingWorktree = (
  worktreePath: string,
  branch: string,
  env: NodeJS.ProcessEnv
): WorktreeResult | undefined => {
  if (!existsSync(worktreePath)) {
    return undefined;
  }

  const toplevel = run(
    "git",
    ["-C", worktreePath, "rev-parse", "--show-toplevel"],
    { env }
  );
  if (toplevel.status !== 0 || toplevel.stdout.trim() !== worktreePath) {
    throw new CliError(
      `${worktreePath} already exists and is not a git worktree`
    );
  }

  const headBranch = run(
    "git",
    ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      env,
    }
  );
  return {
    branch: headBranch.status === 0 ? headBranch.stdout.trim() : branch,
    worktreePath,
  };
};

// Read an already-materialized issue worktree without fetching, pruning, or
// creating anything. Used by the runner's early retry path after cmux proves an
// agent is actively attached to the exact derived cwd.
export const existingIssueWorktree = (
  repoRoot: string,
  issueId: string,
  env: NodeJS.ProcessEnv
): WorktreeResult | undefined =>
  reuseExistingWorktree(worktreePathFor(repoRoot, issueId), issueId, env);

const refExists = (
  repoRoot: string,
  ref: string,
  env: NodeJS.ProcessEnv
): boolean =>
  run("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", ref], { env })
    .status === 0;

const addWorktree = (
  repoRoot: string,
  worktreePath: string,
  branch: string,
  env: NodeJS.ProcessEnv,
  base?: string
): void => {
  if (refExists(repoRoot, `refs/heads/${branch}`, env)) {
    runRequired(
      "git",
      ["-C", repoRoot, "worktree", "add", worktreePath, branch],
      { env }
    );
    return;
  }

  if (refExists(repoRoot, `refs/remotes/origin/${branch}`, env)) {
    runRequired(
      "git",
      [
        "-C",
        repoRoot,
        "worktree",
        "add",
        "--track",
        "-b",
        branch,
        worktreePath,
        `origin/${branch}`,
      ],
      { env }
    );
    return;
  }

  // An explicit base wins over origin's default branch for a NEW branch (an
  // existing branch keeps its history — the reuse paths above are unchanged).
  if (base) {
    runRequired(
      "git",
      [
        "-C",
        repoRoot,
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        resolveBaseRef(repoRoot, base, env),
      ],
      { env }
    );
    return;
  }

  const defaultBranchOutput = run(
    "git",
    ["-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { env }
  );
  const defaultBranch =
    defaultBranchOutput.status === 0
      ? defaultBranchOutput.stdout.trim().replace(/^origin\//u, "")
      : "";
  if (!defaultBranch) {
    throw new CliError(
      "cannot resolve origin's default branch (try: git remote set-head origin --auto)"
    );
  }

  const baseRef = `refs/remotes/origin/${defaultBranch}`;
  if (
    run(
      "git",
      ["-C", repoRoot, "rev-parse", "--verify", `${baseRef}^{commit}`],
      { env }
    ).status !== 0
  ) {
    throw new CliError(`missing ${baseRef}`);
  }

  runRequired(
    "git",
    ["-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, baseRef],
    {
      env,
    }
  );
};

const acquireLock = async (lockDir: string): Promise<void> => {
  for (let tries = 0; tries < 300; tries += 1) {
    try {
      await mkdir(lockDir);
      return;
    } catch {
      await setTimeout(300);
    }
  }

  throw new CliError(`timed out waiting for worktree lock: ${lockDir}`);
};

const releaseLock = async (lockDir: string): Promise<void> => {
  await rmdir(lockDir).catch(() => {
    // ignore: lock dir may already be gone
  });
};

export const ensureWorktree = async (
  options: EnsureWorktreeOptions
): Promise<WorktreeResult> => {
  const branch = `${options.issueId}${options.slug ? `-${options.slug}` : ""}`;
  const worktreePath = worktreePathFor(options.repoRoot, options.issueId);

  // Re-running for an issue is a no-op: reuse the existing worktree as-is.
  const existing = reuseExistingWorktree(worktreePath, branch, options.env);
  if (existing) {
    return existing;
  }

  if (
    run(
      "git",
      ["-C", options.repoRoot, "check-ref-format", "--branch", branch],
      {
        env: options.env,
      }
    ).status !== 0
  ) {
    throw new CliError(`invalid branch name: ${branch}`);
  }

  if (!options.skipFetch) {
    fetchOrigin(options.repoRoot, options.env);
  }

  const lockDir = join(
    gitCommonDir(options.repoRoot, options.env),
    ".linear-worktree.lock"
  );

  await acquireLock(lockDir);
  try {
    // Another captain invocation may have created this exact worktree while we
    // waited for the shared lock. Recheck under the lock before prune/add.
    const concurrentlyCreated = reuseExistingWorktree(
      worktreePath,
      branch,
      options.env
    );
    if (concurrentlyCreated) {
      return concurrentlyCreated;
    }
    // Clear stale registrations whose directories were deleted out from under git.
    run("git", ["-C", options.repoRoot, "worktree", "prune"], {
      env: options.env,
    });
    addWorktree(
      options.repoRoot,
      worktreePath,
      branch,
      options.env,
      options.base
    );
  } finally {
    await releaseLock(lockDir);
  }

  const toplevel = runRequired(
    "git",
    ["-C", worktreePath, "rev-parse", "--show-toplevel"],
    {
      env: options.env,
    }
  );
  const headBranch = runRequired(
    "git",
    ["-C", worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { env: options.env }
  );

  if (toplevel !== worktreePath) {
    throw new CliError("worktree path mismatch");
  }

  if (headBranch !== branch) {
    throw new CliError("worktree HEAD mismatch");
  }

  return { branch, worktreePath };
};
