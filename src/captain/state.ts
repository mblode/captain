import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { FleetState } from "./types";

// Captain drives a single fleet; the id only namespaces state on disk.
export const DEFAULT_FLEET = "default";

// Epoch seconds — the fleet's time unit (worktree `since`, state `updatedAt`).
export const now = (): number => Math.floor(Date.now() / 1000);

export const fleetDir = (fleetId: string): string =>
  join(homedir(), ".claude", "captain", fleetId);

const statePath = (fleetId: string): string =>
  join(fleetDir(fleetId), "state.json");

export const cursorPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "cursor");

// Every scope dir the fleet tracks: the boot-time match plus any extensions a
// later fanout appended via a `scope` intent. Empty = unscoped (track all).
export const scopesOf = (state: FleetState): string[] => [
  ...new Set(
    [state.match, ...(state.matches ?? [])].filter(Boolean) as string[]
  ),
];

// Scope test for one worktree path: no scopes tracks everything, otherwise the
// cwd must fall under (substring-match) at least one scope dir.
export const inScope = (cwd: string, scopes: string[]): boolean =>
  scopes.length === 0 || scopes.some((dir) => cwd.includes(dir));

export const loadState = (fleetId: string): FleetState => {
  const path = statePath(fleetId);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8")) as FleetState;
  }
  return { fleetId, updatedAt: 0, worktrees: {} };
};

// Atomic write: temp file + rename, so a crashed write never corrupts state.json.
export const saveState = (state: FleetState): void => {
  const dir = fleetDir(state.fleetId);
  mkdirSync(dir, { recursive: true });
  state.updatedAt = now();
  const path = statePath(state.fleetId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
};
