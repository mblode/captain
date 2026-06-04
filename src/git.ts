import { existsSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { CliError } from "./errors";
import { run, runRequired } from "./shell";
import type { WorktreeResult } from "./types";

interface EnsureWorktreeOptions {
  env: NodeJS.ProcessEnv;
  issueId: string;
  repoRoot: string;
  slug: string;
  skipFetch?: boolean;
}

export const fetchOrigin = (repoRoot: string, env: NodeJS.ProcessEnv): void => {
  run("git", ["-C", repoRoot, "fetch", "origin", "--quiet"], { env });
};

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

const addWorktree = (
  repoRoot: string,
  worktreePath: string,
  branch: string,
  env: NodeJS.ProcessEnv
): void => {
  if (
    run(
      "git",
      [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ],
      { env }
    ).status === 0
  ) {
    runRequired(
      "git",
      ["-C", repoRoot, "worktree", "add", worktreePath, branch],
      { env }
    );
    return;
  }

  if (
    run(
      "git",
      [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ],
      { env }
    ).status === 0
  ) {
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
  const worktreePath = join(
    dirname(options.repoRoot),
    `${basename(options.repoRoot)}-${options.issueId}`
  );

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

  const commonDirRaw = run(
    "git",
    ["-C", options.repoRoot, "rev-parse", "--git-common-dir"],
    {
      env: options.env,
    }
  );
  const commonDir =
    commonDirRaw.status === 0
      ? commonDirRaw.stdout.trim()
      : join(options.repoRoot, ".git");
  const absoluteCommonDir = isAbsolute(commonDir)
    ? commonDir
    : join(options.repoRoot, commonDir);
  const lockDir = join(absoluteCommonDir, ".linear-worktree.lock");

  await acquireLock(lockDir);
  try {
    // Clear stale registrations whose directories were deleted out from under git.
    run("git", ["-C", options.repoRoot, "worktree", "prune"], {
      env: options.env,
    });
    addWorktree(options.repoRoot, worktreePath, branch, options.env);
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
