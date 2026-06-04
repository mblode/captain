import { CliError } from "./errors.js";
import { commandExists, run } from "./shell.js";

export const copyCommand = (command: string, env: NodeJS.ProcessEnv): void => {
  if (commandExists("pbcopy", env)) {
    run("pbcopy", [], { env, input: command });
    return;
  }
  if (commandExists("wl-copy", env)) {
    run("wl-copy", [], { env, input: command });
    return;
  }
  if (commandExists("xclip", env)) {
    run("xclip", ["-selection", "clipboard"], { env, input: command });
  }
};

export const launchPlanMode = (
  worktreePath: string,
  prompt: string,
  env: NodeJS.ProcessEnv
): number => {
  if (!commandExists("claude", env)) {
    throw new CliError("claude is not on PATH (use --print to skip launching)");
  }

  const previousCwd = process.cwd();
  process.chdir(worktreePath);
  const result = run(
    "claude",
    [
      "--permission-mode",
      "plan",
      "--allow-dangerously-skip-permissions",
      prompt,
    ],
    {
      env,
      stdio: "inherit",
    }
  );
  process.chdir(previousCwd);

  return result.status ?? 1;
};
