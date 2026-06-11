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
