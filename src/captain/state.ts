import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { FleetState } from "./types.js";

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
  state.updatedAt = Math.floor(Date.now() / 1000);
  const path = statePath(state.fleetId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
};
