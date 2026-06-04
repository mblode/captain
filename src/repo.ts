import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "./errors.js";
import { run } from "./shell.js";
import type { ResolvedRepo } from "./types.js";

interface ResolveRepoOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  repoOverride?: string;
}

export const expandTilde = (value: string, home = homedir()): string => {
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return join(home, value.slice(2));
  }
  return value;
};

const gitTopLevel = (
  cwd: string,
  env: NodeJS.ProcessEnv
): string | undefined => {
  const result = run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    env,
  });
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout.trim();
};

export const resolveRepo = (options: ResolveRepoOptions): ResolvedRepo => {
  if (options.repoOverride) {
    const repo = gitTopLevel(expandTilde(options.repoOverride), options.env);
    if (repo) {
      return { repoRoot: repo };
    }
    throw new CliError(`--repo is not a git repo: ${options.repoOverride}`);
  }

  const cwdRepo = gitTopLevel(options.cwd, options.env);
  if (cwdRepo) {
    return { repoRoot: cwdRepo };
  }

  throw new CliError(
    "not in a git repo (run from inside the target repo or pass --repo <path>)"
  );
};
