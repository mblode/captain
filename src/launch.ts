import { DEFAULT_MODEL, loadAgentEnv, loadEffort, loadModel } from "./config";
import { CliError } from "./errors";
import { commandExists, run } from "./shell";

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

// The inline (non-cmux) launch. Agent-aware: claude launches in plan mode;
// codex is best-effort with full autonomy (no plan mode). The argv mirrors the
// cmux command builders (claudeCommand / codexCommand) so the two launch paths
// can't drift.
const inlineArgs = (agent: string, prompt: string, env: NodeJS.ProcessEnv) => {
  if (agent === "codex") {
    const model = loadModel(env);
    return [
      ...(model === DEFAULT_MODEL ? [] : ["-m", model]),
      "-c",
      `model_reasoning_effort=${loadEffort(env)}`,
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ];
  }
  return [
    "--model",
    loadModel(env),
    "--effort",
    loadEffort(env),
    "--permission-mode",
    "plan",
    "--allow-dangerously-skip-permissions",
    prompt,
  ];
};

export const launchPlanMode = (
  worktreePath: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
  agent = "claude"
): number => {
  if (!commandExists(agent, env)) {
    throw new CliError(
      `${agent} is not on PATH (use --print to skip launching, or run \`captain install\`)`
    );
  }

  const previousCwd = process.cwd();
  process.chdir(worktreePath);
  const result = run(agent, inlineArgs(agent, prompt, env), {
    // Same resource caps as the cmux launch path (see claudeCommand) — the
    // inline fallback must not be the one door the fleet env misses.
    env: { ...env, ...loadAgentEnv(env) },
    stdio: "inherit",
  });
  process.chdir(previousCwd);

  return result.status ?? 1;
};
