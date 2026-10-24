import {
  DEFAULT_MODEL,
  loadAgentEnv,
  loadEffort,
  loadModel,
  planGated,
} from "./config";
import { commandExists, run, runRequired, shellQuote } from "./shell";
import { isIssueToken } from "./source";

interface OpenWorkspaceOptions {
  agent: string;
  branch: string;
  env: NodeJS.ProcessEnv;
  focus: boolean;
  promptPath: string;
  worktreePath: string;
  // OpenSpec runs: the change id as the workspace description (status's
  // membership marker) and a fixed claude session id (the gate join key)
  description?: string;
  sessionId?: string;
}

// A fan-out is ≥2 issue tokens on one line — any source's tokens, mixable,
// since prepareIssue routes each token to its own source via the registry.
export const isFanOutInput = (tokens: string[], print: boolean): boolean =>
  !print && tokens.length >= 2 && tokens.every(isIssueToken);

// Driver-facing copy when ping fails. `captain install` only helps a missing
// binary. A refused socket means the app is down. Access denied means the app
// is up but Socket Control Mode is `cmuxOnly` — the /captain driver never
// runs inside a cmux pane (it sits in linear-god / Claude Code).
export const formatCmuxUnreachable = (options: {
  onPath: boolean;
  pingStderr: string;
  pingStdout: string;
}): string => {
  if (!options.onPath) {
    return "cmux is not on PATH — run `captain install`";
  }
  const err = (
    options.pingStderr.trim() || options.pingStdout.trim()
  ).replaceAll(/\s+/gu, " ");
  if (/access denied|only processes started inside cmux/iu.test(err)) {
    return "cmux socket is in cmux-only mode — captain's driver is linear-god, not a cmux pane. Set cmux Settings → Automation → Socket Control Mode to Automation mode (not Full open access).";
  }
  return err
    ? `cmux is not reachable — ${err}`
    : "cmux is not reachable — is the app running?";
};

export const explainCmuxUnreachable = (
  env: NodeJS.ProcessEnv
): string | undefined => {
  if (!commandExists("cmux", env)) {
    return formatCmuxUnreachable({
      onPath: false,
      pingStderr: "",
      pingStdout: "",
    });
  }
  const ping = run("cmux", ["ping"], { env });
  if (ping.status === 0) {
    return undefined;
  }
  return formatCmuxUnreachable({
    onPath: true,
    pingStderr: ping.stderr,
    pingStdout: ping.stdout,
  });
};

export const cmuxReachable = (env: NodeJS.ProcessEnv): boolean =>
  explainCmuxUnreachable(env) === undefined;

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
// `name` pins Claude Code's session name (`claude --name`) to the ticket slug
// so multi-session Claude UX matches the fleet — distinct from cmux's own
// `--name` on new-workspace. Omitted when unset (tests / callers without a
// slug); production always passes the branch. `gated` starts it in plan mode
// (--allow-dangerously-skip-permissions keeps bypassPermissions reachable for
// `captain approve`); otherwise it runs unattended from the first turn.
export const claudeCommand = (
  promptPath: string,
  model: string,
  effort: string,
  agentEnv: Record<string, string> = {},
  name?: string,
  sessionId?: string,
  gated = false
): string => {
  const nameFlag = name ? `--name ${shellQuote(name)} ` : "";
  const sessionFlag = sessionId ? `--session-id ${shellQuote(sessionId)} ` : "";
  const mode = gated
    ? "--permission-mode plan --allow-dangerously-skip-permissions"
    : "--dangerously-skip-permissions";
  return `${envPrefix(agentEnv)}claude ${nameFlag}${sessionFlag}--model ${shellQuote(model)} --effort ${shellQuote(effort)} ${mode} "$(cat ${shellQuote(promptPath)})"`;
};

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
// only one that can be gated; `codex` is best-effort. `name` is the
// ticket/branch slug pinned as Claude's session name (claude only — codex has
// no `--name` equivalent here).
export const agentCommand = (
  agent: string,
  promptPath: string,
  model: string,
  effort: string,
  agentEnv: Record<string, string> = {},
  name?: string,
  sessionId?: string,
  gated = false
): string =>
  agent === "codex"
    ? codexCommand(promptPath, model, effort, agentEnv)
    : claudeCommand(
        promptPath,
        model,
        effort,
        agentEnv,
        name,
        sessionId,
        gated
      );

// The id of the sidebar group holding `workspaceId`, from
// `workspace-group list --json --id-format both`. Garbage reads as "no group"
// so launch never fails on cosmetics.
export const groupContaining = (
  listJson: string,
  workspaceId: string
): string | undefined => {
  try {
    const parsed = JSON.parse(listJson) as {
      groups?: { id?: string; member_workspace_ids?: string[] }[];
    };
    const target = workspaceId.toUpperCase();
    return parsed.groups?.find((group) =>
      group.member_workspace_ids?.some((id) => id.toUpperCase() === target)
    )?.id;
  } catch {
    return undefined;
  }
};

const workspaceTitle = (
  workspaceId: string,
  env: NodeJS.ProcessEnv
): string | undefined => {
  const raw = run("cmux", ["rpc", "workspace.list"], { env });
  try {
    const parsed = JSON.parse(raw.stdout) as {
      workspaces?: { id?: string; title?: string }[];
    };
    return parsed.workspaces?.find(
      (w) => w.id?.toUpperCase() === workspaceId.toUpperCase()
    )?.title;
  } catch {
    return undefined;
  }
};

// Launched agents join the driver's sidebar group, so a fleet collapses under
// the session that started it. An ungrouped driver becomes the anchor of a new
// group named after it. Outside cmux (no CMUX_WORKSPACE_ID) nothing is grouped.
// Best-effort: any failure still launches the workspace, just ungrouped.
const driverGroup = (env: NodeJS.ProcessEnv): string | undefined => {
  const driver = env.CMUX_WORKSPACE_ID;
  if (!driver) {
    return undefined;
  }
  const list = run(
    "cmux",
    ["workspace-group", "list", "--json", "--id-format", "both"],
    { env }
  );
  const existing =
    list.status === 0 ? groupContaining(list.stdout, driver) : undefined;
  if (existing) {
    return existing;
  }
  const title = workspaceTitle(driver, env);
  const created = run(
    "cmux",
    [
      "workspace-group",
      "create",
      "--from",
      driver,
      ...(title ? ["--name", title] : []),
      "--json",
      "--id-format",
      "both",
    ],
    { env }
  );
  try {
    return (JSON.parse(created.stdout) as { group?: { id?: string } }).group
      ?.id;
  } catch {
    return undefined;
  }
};

export const openIssueWorkspace = (options: OpenWorkspaceOptions): void => {
  const group = driverGroup(options.env);
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
        loadAgentEnv(options.env),
        options.branch,
        options.sessionId,
        planGated(options.agent, options.env)
      ),
      "--focus",
      options.focus ? "true" : "false",
      ...(options.description ? ["--description", options.description] : []),
      ...(group ? ["--group", group] : []),
    ],
    { env: options.env }
  );
};
