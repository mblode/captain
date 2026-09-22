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
export const DEFAULT_MODEL = "default";

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
  // the session name claude shows (the branch)
  name?: string;
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
    const effort = spec.effort ? `--effort ${shellQuote(spec.effort)} ` : "";
    const mode = spec.gated
      ? "--permission-mode plan --allow-dangerously-skip-permissions"
      : "--dangerously-skip-permissions";
    agent = `${prefix}${spec.bin} ${name}${modelFlag("--model", spec.model)}${effort}${mode} ${prompt}`;
  }
  return spec.bootstrap ? `(${spec.bootstrap}) && ${agent}` : agent;
};

export const openWorkspace = (options: {
  name: string;
  cwd: string;
  command: string;
  env: NodeJS.ProcessEnv;
}): void => {
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
    ],
    { env: options.env }
  );
};
