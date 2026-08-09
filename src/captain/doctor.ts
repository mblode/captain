import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { cmuxReachable } from "../cmux";
import { loadSkills } from "../config";
import { commandExists, run } from "../shell";
import { msg, style, useColor } from "./format";
import type { Style } from "./format";

// One preflight line: a label, whether it's a hard requirement, the live state,
// a short detail, and the fix to run when it's missing. `skillBundle` names the
// `skills add` bundle `captain install` fetches to satisfy this check.
export interface Check {
  detail: string;
  hint?: string;
  label: string;
  level: "recommended" | "required";
  ok: boolean;
  skillBundle?: string;
}

// Everything `buildChecks` needs to read the world, injected so the check list
// stays pure (and testable) — mirrors the surface.ts/CmuxPort seam.
export interface DoctorDeps {
  cmuxReachable: () => boolean;
  // The pipeline skills the configured brief actually runs (loadSkills), stripped
  // of the leading `/`. Injected so buildChecks stays pure; realDeps resolves it.
  configuredSkills: string[];
  env: NodeJS.ProcessEnv;
  hasCommand: (command: string) => boolean;
  // Installs a `skills add` bundle globally; returns whether it succeeded.
  // Injected so `install` orchestration stays testable (no network in tests).
  installBundle: (bundle: string) => boolean;
  nodeMajor: number;
  nodeVersion: string;
  skillInstalled: (skill: string) => boolean;
}

// The skills `captain install` can fetch from mblode/agent-skills. The doctor
// only nags about the ones the configured brief actually runs, so a custom
// pipeline (CAPTAIN_SKILLS / config) isn't warned about skills it doesn't use.
// (/tidy runs first but isn't fetched through this bundle, so it's not here.)
const INSTALLABLE_SKILLS = ["pr-reviewer", "pr-creator", "pr-babysitter"];

const PIPELINE_BUNDLE = "mblode/agent-skills";
const CAPTAIN_BUNDLE = "mblode/captain";
const addCmd = (bundle: string): string => `npx skills add ${bundle} -g`;

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

  // Only the installable skills the configured pipeline actually runs — a custom
  // pipeline isn't nagged about skills it doesn't use, and one that runs none
  // (e.g. /tidy only) skips the check entirely.
  const pipelineSkills = INSTALLABLE_SKILLS.filter((skill) =>
    deps.configuredSkills.includes(skill)
  );
  if (pipelineSkills.length > 0) {
    const missingPipeline = pipelineSkills.filter(
      (skill) => !deps.skillInstalled(skill)
    );
    checks.push({
      detail: missingPipeline.length
        ? `missing: ${missingPipeline.join(", ")}`
        : "installed",
      hint: `the brief runs ${pipelineSkills.map((s) => `/${s}`).join(", ")} — ${addCmd(PIPELINE_BUNDLE)}`,
      label: "pipeline skills",
      level: "recommended",
      ok: missingPipeline.length === 0,
      skillBundle: PIPELINE_BUNDLE,
    });
  }

  const captainOk = deps.skillInstalled("captain");
  checks.push({
    detail: captainOk ? "installed" : "not found",
    hint: `teach your agent to drive captain — ${addCmd(CAPTAIN_BUNDLE)}`,
    label: "captain skill",
    level: "recommended",
    ok: captainOk,
    skillBundle: CAPTAIN_BUNDLE,
  });

  return checks;
};

// Pure: the distinct `skills add` bundles `captain install` should fetch to
// satisfy the failing checks (deduped — the three pipeline skills share one
// bundle). Required gaps (node/git/cmux) carry no bundle, so they're skipped.
export const missingBundles = (checks: Check[]): string[] => [
  ...new Set(
    checks.flatMap((c) => (c.ok || !c.skillBundle ? [] : [c.skillBundle]))
  ),
];

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
  configuredSkills: loadSkills(env).map((s) => s.replace(/^\//u, "")),
  env,
  hasCommand: (command) => commandExists(command, env),
  installBundle: (bundle) =>
    run("npx", ["skills", "add", bundle, "-g"], { env, stdio: "inherit" })
      .status === 0,
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
  const lines = [s.bold("Captain setup"), ""];
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

// Install the named skill bundles, narrating each. Returns whether any install
// ran — the caller re-probes only when it did, since installs are all that can
// change the checks (required gaps aren't ours to install).
const installSkills = (
  stdout: NodeJS.WritableStream,
  deps: DoctorDeps,
  s: Style,
  bundles: string[]
): boolean => {
  if (bundles.length === 0) {
    stdout.write(`${msg.ok(s, "skills already installed.")}\n\n`);
    return false;
  }
  stdout.write(`${s.bold("Installing fleet skills…")}\n`);
  for (const bundle of bundles) {
    stdout.write(`${s.dim(`  $ ${addCmd(bundle)}`)}\n`);
    if (!deps.installBundle(bundle)) {
      stdout.write(`${msg.err(s, `failed to install ${bundle}`)}\n`);
    }
  }
  stdout.write("\n");
  return true;
};

// The CLI entry: install whatever skills are missing (a no-op when they're all
// present), then print the check report. Idempotent — re-run it any time to
// re-check. Tests pass fake deps; the CLI lets `realDeps` read the world.
export const install = (
  stdout: NodeJS.WritableStream,
  deps: DoctorDeps = realDeps(process.env)
): number => {
  const s = style(useColor(stdout));
  const checks = buildChecks(deps);
  // Re-probe after a real install so the report reflects the new skills;
  // otherwise the first pass already describes the world.
  const installed = installSkills(stdout, deps, s, missingBundles(checks));
  const { exitCode, text } = renderDoctor(
    installed ? buildChecks(deps) : checks,
    s
  );
  stdout.write(text);
  return exitCode;
};
