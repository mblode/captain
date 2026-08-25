import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The post-implementation steps the self-drive brief runs between *implement*
// and the *verifier/verdict finish*. Configurable so a setup can run its own
// review/ship pipeline; this is the fallback when no config is present.
//
// ORDER IS LOAD-BEARING: /pr-reviewer runs BEFORE /tidy. Both skills document
// the handoff — pr-reviewer is read-only and writes a report whose `Fix:` lines
// are committable, and tidy's Phase 2 looks for a review that already ran and
// routes its confirmed findings straight into its own apply phase. Running the
// fixer first strands the report: nothing downstream applies it, and the PR
// /pr-creator opens carries the review's "Must fix before push" findings.
//
// An entry is either a `/skill` token (rendered as "Run /skill.") or a plain
// English instruction rendered verbatim as its own step. Prose is what makes a
// step conditional — the agent reads the sentence and can honestly answer "not
// applicable" — without a `when` schema or a condition evaluator. Ceremony that
// cannot be skipped teaches agents to argue exemptions instead (the same reason
// the rubric has an `na` state and /security-review was reverted).
export const DEFAULT_SKILLS = [
  "/pr-reviewer",
  "/tidy",
  "If the diff touches user-facing UI, run /product-design then /ui-design, and iterate between them until both the states and the visual are right.",
  "If the diff changes a rendered page or component, run /visual-qa before finishing.",
  "/pr-creator",
  "/pr-babysitter",
];

// The token a user's `.skills` (or CAPTAIN_SKILLS) includes to KEEP the built-in
// pipeline while adding steps of their own. Without it a non-empty list replaces
// the defaults wholesale — the trap this exists to remove. Modelled on Claude
// Code's own autoMode config, where "$defaults" keeps the built-in rules.
const DEFAULTS_TOKEN = "$defaults";

// The data-scope guardrail injected into every brief by default — the agent may
// touch the repo's own source/config/tests/docs, but not customer data, secrets,
// or PII. On by default; a setup can override it (or widen it) via config.
//
// States WHAT to do when blocked and names no tool: HOW to surface a blocker is
// owned by the brief's <workflow> section, which is agent-aware (claude has
// AskUserQuestion, codex does not and stops instead). Naming a tool here would
// re-break that for codex — and for any custom .dataScope text a user writes.
export const DEFAULT_DATA_SCOPE =
  "Operate on source code, configuration, tests, and documentation in this repository only. Do not access, read, log, exfiltrate, or commit customer data, production secrets, credentials, payment information, or PII. If a task appears to require any of these, stop and surface the blocker to a human as described above instead of proceeding.";

// Env injected into every fleet agent's claude process — and therefore every
// Bash tool it runs. Defaults cap what test runners respect via env (vitest's
// thread/fork pools): N agents each spawning an uncapped worker pool has
// exhausted a 48GB machine and gotten the whole fleet jetsam-killed. Jest
// ignores env for worker count, so the brief + a repo-level maxWorkers cap
// cover it (see uncappedJestNote). Extend or override via config `.agentEnv`
// (a string map — e.g. {"NODE_OPTIONS": "--max-old-space-size=3072"}); set a
// key to "" to drop a default.
export const DEFAULT_AGENT_ENV: Record<string, string> = {
  VITEST_MAX_FORKS: "2",
  VITEST_MAX_THREADS: "2",
};

// The model + effort every fleet agent launches on (claude `--model`/`--effort`).
// Pinned so an agent never inherits the driver's ambient model/effort (a driver on
// a cheap/fast model would silently spawn the whole fleet on it). `default` resolves
// to the machine's configured default model; `high` is the standard fleet effort.
// Override per setup via config (`.model`/`.effort`) or env (`CAPTAIN_MODEL`/
// `CAPTAIN_EFFORT`).
export const DEFAULT_MODEL = "default";
export const DEFAULT_EFFORT = "high";

// The coding agent every fleet launch runs. `claude` (Claude Code) is the
// default and the only one wired into the plan-gate/approve flow; `codex` is a
// best-effort alternative (no plan mode, so no approve step — the agent drives
// straight from the brief). Override via config (`.agent`) or env
// (`CAPTAIN_AGENT`), or per-invocation with `start --agent <name>`.
export const DEFAULT_AGENT = "claude";

// Where the global config file lives: an explicit CAPTAIN_CONFIG wins, else the
// XDG config dir ($XDG_CONFIG_HOME or ~/.config) under captain/. Deliberately
// NOT under ~/.claude.
const configPath = (env: NodeJS.ProcessEnv): string =>
  env.CAPTAIN_CONFIG ??
  join(
    env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "captain",
    "config.json"
  );

// Read and JSON-parse the config file, fail-safe to null on any error (missing
// file, bad JSON) — the one filesystem edge both loaders share so their fallback
// behaviour can never drift.
const readConfig = (env: NodeJS.ProcessEnv): unknown => {
  try {
    return JSON.parse(readFileSync(configPath(env), "utf-8")) as unknown;
  } catch {
    return null;
  }
};

// Trim, drop non-strings and empties — the one normalisation both the file's
// `.skills` array and the CAPTAIN_SKILLS env list go through.
const cleanList = (items: unknown[]): string[] =>
  items
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// Pure: pull a non-empty string array out of an arbitrary parsed value, else
// null (so callers can fall back). Used for both the file's `.skills` field and
// any future array config.
export const parseSkills = (raw: unknown): string[] | null => {
  const skills = (raw as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) {
    return null;
  }
  const cleaned = cleanList(skills);
  return cleaned.length > 0 ? cleaned : null;
};

// Expand `$defaults` IN PLACE, so position is preserved: a step listed before the
// token runs before the built-in pipeline, one after it runs after. Any OTHER
// `$token` is dropped — it is a typo or a future feature, and passing it through
// would land a literal "$whatever" in the agent's brief as an instruction to
// follow. Pure; DEFAULT_SKILLS contains no token, so this cannot recurse.
const expandDefaults = (items: string[]): string[] =>
  items.flatMap((item) => {
    if (item === DEFAULTS_TOKEN) {
      return DEFAULT_SKILLS;
    }
    return item.startsWith("$") ? [] : [item];
  });

// Resolve the configured pipeline, fail-safe like the rest of captain: env
// override (CAPTAIN_SKILLS, comma-separated) > config file `.skills` >
// DEFAULT_SKILLS. Any read/parse error degrades to the default — never throws,
// and a list that expands to nothing (only unknown `$tokens`) degrades too.
//
// CAPTAIN_SKILLS splits on commas, so a plain-English step containing a comma
// cannot be expressed there — put prose entries in the config file, whose
// `.skills` is a JSON array and needs no delimiter.
export const loadSkills = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const fromEnv = env.CAPTAIN_SKILLS
    ? cleanList(env.CAPTAIN_SKILLS.split(","))
    : [];
  const configured =
    fromEnv.length > 0 ? fromEnv : parseSkills(readConfig(env));
  if (!configured) {
    return DEFAULT_SKILLS;
  }
  const expanded = expandDefaults(configured);
  return expanded.length > 0 ? expanded : DEFAULT_SKILLS;
};

// Pure: pull a trimmed non-empty string field out of a parsed config value, else
// null (so callers fall back to a default). Shared by every single-string setting
// (dataScope, model, effort) so their normalisation can never drift.
const parseStringField = (raw: unknown, field: string): string | null => {
  const value = (raw as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Resolve a single string setting, fail-safe: env override (trimmed) > config file
// field > fallback. Any read/parse error degrades to the fallback — never throws.
const loadStringSetting = (
  env: NodeJS.ProcessEnv,
  envKey: string,
  field: string,
  fallback: string
): string =>
  env[envKey]?.trim() || (parseStringField(readConfig(env), field) ?? fallback);

// Pure: pull a trimmed non-empty `.dataScope` string out of a parsed config
// value, else null (so callers fall back to the default).
export const parseDataScope = (raw: unknown): string | null =>
  parseStringField(raw, "dataScope");

// Resolve the data-scope guardrail, fail-safe: env override (CAPTAIN_DATA_SCOPE,
// trimmed) > config file `.dataScope` > DEFAULT_DATA_SCOPE. Any read/parse error
// degrades to the default — never throws. The guardrail is on by default.
export const loadDataScope = (env: NodeJS.ProcessEnv = process.env): string =>
  loadStringSetting(env, "CAPTAIN_DATA_SCOPE", "dataScope", DEFAULT_DATA_SCOPE);

// A key must be a valid shell/env identifier — these land verbatim in the
// workspace launch command, so anything else is dropped rather than quoted.
const isEnvKey = (key: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key);

// Pure: pull a string→string map out of a parsed config's `.agentEnv`, else
// null (so callers fall back). Non-string values and invalid keys are dropped.
export const parseAgentEnv = (raw: unknown): Record<string, string> | null => {
  const agentEnv = (raw as { agentEnv?: unknown } | null)?.agentEnv;
  if (typeof agentEnv !== "object" || agentEnv === null) {
    return null;
  }
  const entries = Object.entries(agentEnv).filter(
    (pair): pair is [string, string] =>
      isEnvKey(pair[0]) && typeof pair[1] === "string"
  );
  return Object.fromEntries(entries);
};

// Resolve the agent env, fail-safe: defaults merged with the config file's
// `.agentEnv` (config wins per key; an empty value drops the key entirely).
// Any read/parse error degrades to the defaults — never throws.
export const loadAgentEnv = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  const merged = {
    ...DEFAULT_AGENT_ENV,
    ...parseAgentEnv(readConfig(env)),
  };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== "")
  );
};

// Resolve the fleet model, fail-safe: env override (CAPTAIN_MODEL, trimmed) >
// config file `.model` > DEFAULT_MODEL. Passed to claude as `--model`.
export const loadModel = (env: NodeJS.ProcessEnv = process.env): string =>
  loadStringSetting(env, "CAPTAIN_MODEL", "model", DEFAULT_MODEL);

// Resolve the fleet effort, fail-safe: env override (CAPTAIN_EFFORT, trimmed) >
// config file `.effort` > DEFAULT_EFFORT. Passed to claude as `--effort`.
export const loadEffort = (env: NodeJS.ProcessEnv = process.env): string =>
  loadStringSetting(env, "CAPTAIN_EFFORT", "effort", DEFAULT_EFFORT);

// Collapse any user-supplied agent name (flag, env, or config) to a launchable
// one: anything but `codex` degrades to the default `claude`, so a typo never
// silently launches an unknown binary. The ONE place the rule lives — the
// config loader below and the runner's --agent flag path both call it.
export const normalizeAgent = (value: string): string =>
  value.trim().toLowerCase() === "codex" ? "codex" : DEFAULT_AGENT;

// Resolve the fleet agent, fail-safe: env override (CAPTAIN_AGENT) > config file
// `.agent` > DEFAULT_AGENT, normalised via normalizeAgent.
export const loadAgent = (env: NodeJS.ProcessEnv = process.env): string =>
  normalizeAgent(
    loadStringSetting(env, "CAPTAIN_AGENT", "agent", DEFAULT_AGENT)
  );
