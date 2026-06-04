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
