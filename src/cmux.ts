import { loadAgentEnv, loadEffort, loadModel } from "./config";
import { isIssueId } from "./issue";
import { commandExists, run, runRequired, shellQuote } from "./shell";

interface OpenWorkspaceOptions {
  branch: string;
  env: NodeJS.ProcessEnv;
  focus: boolean;
  promptPath: string;
  worktreePath: string;
}

export const isFanOutInput = (tokens: string[], print: boolean): boolean =>
  !print && tokens.length >= 2 && tokens.every(isIssueId);

export const cmuxReachable = (env: NodeJS.ProcessEnv): boolean =>
  commandExists("cmux", env) && run("cmux", ["ping"], { env }).status === 0;

// The shell command cmux runs in the new workspace. Model/effort are pinned (see
// config.ts) so the agent never inherits the driver's ambient tier; both are
// shell-quoted because a full model id can carry glob metacharacters (e.g. the
// `[1m]` in `claude-opus-4-8[1m]`) that an unquoted arg would try to expand.
// The agent env rides in front via `env` so every Bash tool the agent runs
// inherits the fleet's resource caps (keys are validated in config.ts; values
// are shell-quoted here).
export const claudeCommand = (
  promptPath: string,
  model: string,
  effort: string,
  agentEnv: Record<string, string> = {}
): string => {
  const pairs = Object.entries(agentEnv)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const prefix = pairs ? `env ${pairs} ` : "";
  return `${prefix}claude --model ${shellQuote(model)} --effort ${shellQuote(effort)} --permission-mode plan --allow-dangerously-skip-permissions "$(cat ${shellQuote(promptPath)})"`;
};

export const openIssueWorkspace = (options: OpenWorkspaceOptions): void => {
  runRequired(
    "cmux",
    [
      "new-workspace",
      "--name",
      options.branch,
      "--cwd",
      options.worktreePath,
      "--command",
      claudeCommand(
        options.promptPath,
        loadModel(options.env),
        loadEffort(options.env),
        loadAgentEnv(options.env)
      ),
      "--focus",
      options.focus ? "true" : "false",
    ],
    { env: options.env }
  );
};
