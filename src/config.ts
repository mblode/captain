import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The post-implementation skills the self-drive brief runs between *implement*
// and the *verifier/verdict finish*. Configurable so a setup can run its own
// review/ship skills; this is the fallback when no config is present.
export const DEFAULT_SKILLS = [
  "/simplify",
  "/pr-reviewer",
  "/pr-creator",
  "/pr-babysitter",
];

// The data-scope guardrail injected into every brief by default — the agent may
// touch the repo's own source/config/tests/docs, but not customer data, secrets,
// or PII. On by default; a setup can override it (or widen it) via config.
export const DEFAULT_DATA_SCOPE =
  "Operate on source code, configuration, tests, and documentation in this repository only. Do not access, read, log, exfiltrate, or commit customer data, production secrets, credentials, payment information, or PII. If a task appears to require any of these, stop and surface the blocker via AskUserQuestion instead of proceeding.";

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

// Resolve the configured skills, fail-safe like the rest of captain: env override
// (CAPTAIN_SKILLS, comma-separated) > config file `.skills` > DEFAULT_SKILLS. Any
// read/parse error degrades to the default — never throws.
export const loadSkills = (env: NodeJS.ProcessEnv = process.env): string[] => {
  const fromEnv = env.CAPTAIN_SKILLS
    ? cleanList(env.CAPTAIN_SKILLS.split(","))
    : [];
  if (fromEnv.length > 0) {
    return fromEnv;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(configPath(env), "utf-8")
    ) as unknown;
    return parseSkills(parsed) ?? DEFAULT_SKILLS;
  } catch {
    return DEFAULT_SKILLS;
  }
};

// Pure: pull a trimmed non-empty `.dataScope` string out of a parsed config
// value, else null (so callers fall back to the default).
export const parseDataScope = (raw: unknown): string | null => {
  const scope = (raw as { dataScope?: unknown } | null)?.dataScope;
  if (typeof scope !== "string") {
    return null;
  }
  const trimmed = scope.trim();
  return trimmed.length > 0 ? trimmed : null;
};

// Resolve the data-scope guardrail, fail-safe: env override (CAPTAIN_DATA_SCOPE,
// trimmed) > config file `.dataScope` > DEFAULT_DATA_SCOPE. Any read/parse error
// degrades to the default — never throws. The guardrail is on by default.
export const loadDataScope = (env: NodeJS.ProcessEnv = process.env): string => {
  const fromEnv = env.CAPTAIN_DATA_SCOPE?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(configPath(env), "utf-8")
    ) as unknown;
    return parseDataScope(parsed) ?? DEFAULT_DATA_SCOPE;
  } catch {
    return DEFAULT_DATA_SCOPE;
  }
};

// Pure: pull a string→string map out of the config's `.repoMap` field, keeping
// only string-keyed string-valued entries (non-strings are ignored, never
// throw). Returns null when there is no usable map so callers fall back to {}.
export const parseRepoMap = (raw: unknown): Record<string, string> | null => {
  const map = (raw as { repoMap?: unknown } | null)?.repoMap;
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim().length > 0) {
      out[key] = value.trim();
    }
  }
  return out;
};

// Resolve the per-team repo map (UPPERCASE issue-team-prefix → absolute repo
// path), fail-safe: config file `.repoMap` only — any read/parse error or
// missing/garbage map degrades to `{}` (no map = today's single-repo behaviour).
// Never throws.
export const loadRepoMap = (
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> => {
  try {
    const parsed = JSON.parse(
      readFileSync(configPath(env), "utf-8")
    ) as unknown;
    return parseRepoMap(parsed) ?? {};
  } catch {
    return {};
  }
};
