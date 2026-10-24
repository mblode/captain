import { commandExists, run, runRequired, shellQuote } from "./shell";
import type { Harness } from "./task";

// Driver-facing copy when ping fails. A missing binary, a refused socket (the
// app is down), and access denied (Socket Control Mode is cmux-only, which
// refuses the chat when it runs outside a cmux pane) each need a different fix.
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
    return "cmux socket is in cmux-only mode. Set cmux Settings → Automation → Socket Control Mode to Automation mode (not Full open access).";
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

// `default` means: pass no model flag and let the harness use its own default.
const DEFAULT_MODEL = "default";

export interface LaunchSpec {
  harness: Harness;
  // the binary to run (DEFAULT_HARNESS in config.ts: claude, codex, agent)
  bin: string;
  promptPath: string;
  model: string;
  effort: string;
  // start in plan mode and wait for a human to approve the plan (claude only)
  gated: boolean;
  // env every tool the agent runs inherits (test pool caps, CAPTAIN_SLOT)
  env: Record<string, string>;
  // the session name claude shows (the branch, or the task id when shared)
  name?: string;
  // claude's fixed session id: in a shared checkout every worker has the same
  // cwd, so this is how a feed gate is matched to its task
  sessionId?: string;
  // run first in the workspace, before the agent (the project's bootstrap)
  bootstrap?: string;
}

const envPrefix = (agentEnv: Record<string, string>): string => {
  const pairs = Object.entries(agentEnv)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return pairs ? `env ${pairs} ` : "";
};

const modelFlag = (flag: string, model: string): string =>
  model && model !== DEFAULT_MODEL ? `${flag} ${shellQuote(model)} ` : "";

// The shell command cmux runs in a new workspace. Model and effort are pinned
// per task so a worker never inherits the chat's own tier. Values are
// shell-quoted because a model id can carry glob characters (`[1m]`).
//
// claude: a gated task starts in plan mode, and `captain approve` releases it
// into bypassPermissions (--allow-dangerously-skip-permissions makes that mode
// reachable). An ungated task runs unattended from the start.
// codex: no plan mode, so it always runs unattended.
// cursor: the Cursor CLI (`agent`) with --force so it can run commands
// unattended.
// Flags checked against Claude Code 2.1.280 and Codex 0.156.0 `--help`, and
// the Cursor CLI parameter docs, on 22 Sep 2026.
export const harnessCommand = (spec: LaunchSpec): string => {
  const prompt = `"$(cat ${shellQuote(spec.promptPath)})"`;
  const prefix = envPrefix(spec.env);
  let agent: string;
  if (spec.harness === "codex") {
    const effort = spec.effort
      ? `-c model_reasoning_effort=${shellQuote(spec.effort)} `
      : "";
    agent = `${prefix}${spec.bin} ${modelFlag("-m", spec.model)}${effort}--dangerously-bypass-approvals-and-sandbox ${prompt}`;
  } else if (spec.harness === "cursor") {
    agent = `${prefix}${spec.bin} ${modelFlag("--model", spec.model)}--force ${prompt}`;
  } else {
    const name = spec.name ? `--name ${shellQuote(spec.name)} ` : "";
    const session = spec.sessionId
      ? `--session-id ${shellQuote(spec.sessionId)} `
      : "";
    const effort = spec.effort ? `--effort ${shellQuote(spec.effort)} ` : "";
    const mode = spec.gated
      ? "--permission-mode plan --allow-dangerously-skip-permissions"
      : "--dangerously-skip-permissions";
    agent = `${prefix}${spec.bin} ${name}${session}${modelFlag("--model", spec.model)}${effort}${mode} ${prompt}`;
  }
  return spec.bootstrap ? `(${spec.bootstrap}) && ${agent}` : agent;
};

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

export const openWorkspace = (options: {
  name: string;
  cwd: string;
  command: string;
  env: NodeJS.ProcessEnv;
}): void => {
  const group = driverGroup(options.env);
  runRequired(
    "cmux",
    [
      "new-workspace",
      "--name",
      options.name,
      "--cwd",
      options.cwd,
      "--command",
      options.command,
      "--focus",
      "false",
      ...(group ? ["--group", group] : []),
    ],
    { env: options.env }
  );
};
