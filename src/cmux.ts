import { DEFAULT_MODEL, loadAgentEnv, loadEffort, loadModel } from "./config";
import { isIssueId } from "./issue";
import { commandExists, run, runRequired, shellQuote } from "./shell";

interface OpenWorkspaceOptions {
  agent: string;
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

// The agent env rides in front of every launch command via `env`, so every
// Bash tool the agent runs inherits the fleet's resource caps (keys are
// validated in config.ts; values are shell-quoted here).
const envPrefix = (agentEnv: Record<string, string>): string => {
  const pairs = Object.entries(agentEnv)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return pairs ? `env ${pairs} ` : "";
};

// The shell command cmux runs in the new workspace. Model/effort are pinned (see
// config.ts) so the agent never inherits the driver's ambient tier; both are
// shell-quoted because a full model id can carry glob metacharacters (e.g. the
// `[1m]` in `claude-opus-4-8[1m]`) that an unquoted arg would try to expand.
export const claudeCommand = (
  promptPath: string,
  model: string,
  effort: string,
  agentEnv: Record<string, string> = {}
): string =>
  `${envPrefix(agentEnv)}claude --model ${shellQuote(model)} --effort ${shellQuote(effort)} --permission-mode plan --allow-dangerously-skip-permissions "$(cat ${shellQuote(promptPath)})"`;

// The codex counterpart of claudeCommand — best-effort: codex has no plan mode,
// so it launches with full autonomy (--dangerously-bypass-approvals-and-sandbox,
// the analog of claude's --allow-dangerously-skip-permissions) and drives from
// the brief. `--model default` is a claude-only sentinel, so `-m` is omitted on
// it and codex uses its own configured model; effort maps to codex's TOML config
// override. Same env prefix + shell-quoting + `$(cat …)` prompt as claude.
export const codexCommand = (
  promptPath: string,
  model: string,
  effort: string,
  agentEnv: Record<string, string> = {}
): string => {
  const modelFlag = model === DEFAULT_MODEL ? "" : `-m ${shellQuote(model)} `;
  return `${envPrefix(agentEnv)}codex ${modelFlag}-c model_reasoning_effort=${shellQuote(effort)} --dangerously-bypass-approvals-and-sandbox "$(cat ${shellQuote(promptPath)})"`;
};

// Build the launch command for the selected agent. `claude` (the default) is the
// only one wired into the plan-gate flow; `codex` is best-effort.
export const agentCommand = (
  agent: string,
  promptPath: string,
  model: string,
  effort: string,
  agentEnv: Record<string, string> = {}
): string =>
  agent === "codex"
    ? codexCommand(promptPath, model, effort, agentEnv)
    : claudeCommand(promptPath, model, effort, agentEnv);

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
      agentCommand(
        options.agent,
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
