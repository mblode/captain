import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cmuxReachable } from "../cmux";
import { commandExists } from "../shell";
import { msg, style, useColor } from "./format";
import type { Style } from "./format";

// One preflight line: a label, whether it's a hard requirement, the live state,
// a short detail, and the fix to run when it's missing.
export interface Check {
  detail: string;
  hint?: string;
  label: string;
  level: "recommended" | "required";
  ok: boolean;
}

// Everything `buildChecks` needs to read the world, injected so the check list
// stays pure (and testable) — mirrors the surface.ts/CmuxPort seam.
export interface DoctorDeps {
  cmuxReachable: () => boolean;
  env: NodeJS.ProcessEnv;
  hasCommand: (command: string) => boolean;
  nodeMajor: number;
  nodeVersion: string;
  skillInstalled: (skill: string) => boolean;
}

// The pipeline skills the agent brief invokes (src/prompt.ts) that ship from
// mblode/agent-skills — without them the self-drive pipeline silently no-ops.
// (/simplify ships with Claude Code itself, so it isn't listed here.)
const PIPELINE_SKILLS = ["pr-reviewer", "pr-creator", "pr-babysitter"];

const ADD_PIPELINE = "npx skills add mblode/agent-skills -g";
const ADD_CAPTAIN = "npx skills add mblode/captain -g";

// Pure over its deps: the whole environment verdict as plain data, so the
// renderer and the tests both work off the same list.
export const buildChecks = (deps: DoctorDeps): Check[] => {
  const checks: Check[] = [
    {
      detail: deps.nodeVersion,
      hint: "install Node >= 22 (e.g. via nvm or fnm)",
      label: "Node >= 22",
      level: "required",
      ok: deps.nodeMajor >= 22,
    },
  ];

  for (const command of ["git", "claude"]) {
    const found = deps.hasCommand(command);
    checks.push({
      detail: found ? "on PATH" : "not found",
      hint: `install ${command} and ensure it's on your PATH`,
      label: command,
      level: "required",
      ok: found,
    });
  }

  const cmuxOk = deps.cmuxReachable();
  checks.push({
    detail: cmuxOk ? "reachable" : "not reachable",
    hint: "install cmux (https://cmux.com) and make sure it's running",
    label: "cmux",
    level: "required",
    ok: cmuxOk,
  });

  const hasKey = Boolean(deps.env.LINEAR_API_KEY);
  checks.push({
    detail: hasKey ? "set" : "unset",
    hint: "export LINEAR_API_KEY to pull ticket details into each brief",
    label: "LINEAR_API_KEY",
    level: "recommended",
    ok: hasKey,
  });

  const missingPipeline = PIPELINE_SKILLS.filter(
    (skill) => !deps.skillInstalled(skill)
  );
  checks.push({
    detail: missingPipeline.length
      ? `missing: ${missingPipeline.join(", ")}`
      : "installed",
    hint: `the brief runs ${PIPELINE_SKILLS.map((s) => `/${s}`).join(", ")} — ${ADD_PIPELINE}`,
    label: "pipeline skills",
    level: "recommended",
    ok: missingPipeline.length === 0,
  });

  const captainOk = deps.skillInstalled("captain");
  checks.push({
    detail: captainOk ? "installed" : "not found",
    hint: `teach your agent to drive captain — ${ADD_CAPTAIN}`,
    label: "captain skill",
    level: "recommended",
    ok: captainOk,
  });

  return checks;
};

// Best-effort skill detection across the dirs `skills add` writes to.
const skillProbe = (env: NodeJS.ProcessEnv): ((skill: string) => boolean) => {
  const home = env.HOME ?? homedir();
  const dirs = [
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(process.cwd(), ".claude", "skills"),
  ];
  return (skill) => dirs.some((dir) => existsSync(join(dir, skill)));
};

export const realDeps = (env: NodeJS.ProcessEnv): DoctorDeps => ({
  cmuxReachable: () => cmuxReachable(env),
  env,
  hasCommand: (command) => commandExists(command, env),
  nodeMajor: Number.parseInt(process.versions.node.split(".")[0], 10),
  nodeVersion: `v${process.versions.node}`,
  skillInstalled: skillProbe(env),
});

const line = (s: Style, check: Check): string => {
  const head = check.ok
    ? msg.ok(s, check.label)
    : msg.err(s, `${check.label} (${check.level})`);
  const body = `${head} ${s.dim(`— ${check.detail}`)}`;
  if (check.ok || !check.hint) {
    return body;
  }
  return `${body}\n  ${msg.hint(s, check.hint)}`;
};

export const renderDoctor = (
  checks: Check[],
  s: Style
): { exitCode: number; text: string } => {
  const requiredMissing = checks.filter(
    (c) => c.level === "required" && !c.ok
  ).length;
  const lines = [s.bold("Captain doctor"), ""];
  for (const check of checks) {
    lines.push(line(s, check));
  }
  lines.push("");
  if (requiredMissing > 0) {
    lines.push(
      msg.err(s, `${requiredMissing} required check(s) failed — fix the above.`)
    );
  } else if (checks.some((c) => !c.ok)) {
    lines.push(
      msg.warn(s, "ready, with optional gaps — captain fanout will still run.")
    );
  } else {
    lines.push(msg.ok(s, "all set — captain fanout TIG-430 to begin."));
  }
  return {
    exitCode: requiredMissing > 0 ? 1 : 0,
    text: `${lines.join("\n")}\n`,
  };
};

// The CLI entry; tests pass fake deps, the CLI lets `realDeps` read the world.
export const doctor = (
  stdout: NodeJS.WritableStream,
  deps: DoctorDeps = realDeps(process.env)
): number => {
  const s = style(useColor(stdout));
  const { exitCode, text } = renderDoctor(buildChecks(deps), s);
  stdout.write(text);
  return exitCode;
};
