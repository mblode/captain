import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { fleetDir } from "./state";

const pidPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "watch.pid");
const logPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "watch.log");

const isAlive = (pid: number): boolean => {
  try {
    // Signal 0 doesn't kill — it just probes whether the process exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The pid of a live watcher for this fleet, or undefined if none is running
// (no pidfile, an unreadable pidfile, or a stale pid whose process is gone).
// Reads directly rather than existsSync-then-read — the pidfile can vanish
// between the two (a concurrent `stop`), and this runs on the status hot path.
export const runningPid = (fleetId: string): number | undefined => {
  let raw: string;
  try {
    raw = readFileSync(pidPath(fleetId), "utf-8");
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  // Guard pid > 0: process.kill(0, …) targets the whole process group, so a
  // stray "0" pidfile must never read as a live watcher (stop would SIGTERM us).
  return Number.isFinite(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
};

// One-line watcher health for the status header.
export const watcherHealth = (fleetId: string): string => {
  const pid = runningPid(fleetId);
  return pid ? `running (pid ${pid})` : "not running";
};

// Ensure exactly one detached watcher is driving this fleet. Idempotent across
// sequential runs: a call while one is alive is a no-op, so re-running `fanout`
// never double-spawns. The watcher is a plain background process (not a cmux
// workspace), so it never appears in `cmux workspace list` and can't drive itself.
// `match` is handed to the new watcher via env so the watcher stays the sole
// writer of state.json (no read-modify-write race against its live saves).
export const ensureDaemon = (
  fleetId: string,
  env: NodeJS.ProcessEnv,
  match?: string
): { pid: number; started: boolean } => {
  const existing = runningPid(fleetId);
  if (existing) {
    return { pid: existing, started: false };
  }
  mkdirSync(fleetDir(fleetId), { recursive: true });
  const log = openSync(logPath(fleetId), "a");
  // process.argv[1] is this CLI's entry (dist/cli.js) regardless of bundling.
  const child = spawn(process.execPath, [process.argv[1], "watch"], {
    detached: true,
    env: match ? { ...env, CAPTAIN_MATCH: match } : env,
    stdio: ["ignore", log, log],
  });
  child.unref();
  // The child holds its own dup of the log fd — don't leak the parent's copy.
  closeSync(log);
  if (!child.pid) {
    return { pid: 0, started: false };
  }
  writeFileSync(pidPath(fleetId), `${child.pid}\n`);
  return { pid: child.pid, started: true };
};

// Stop the watcher and remove its pidfile. Returns the pid it killed, if any.
export const stopDaemon = (fleetId: string): number | undefined => {
  const pid = runningPid(fleetId);
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      // already gone — fall through to clean up the pidfile
    }
  }
  rmSync(pidPath(fleetId), { force: true });
  return pid;
};
