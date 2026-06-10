import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fleetDir } from "./state";

const pidPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "watch.pid");
// Exported so `restart` can point at the log when a spawn dies instantly.
export const watchLogPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "watch.log");

// How long a freshly-spawned watcher gets to crash before we vouch for it.
const SETTLE_MS = 300;

// Temp+rename like state.ts, so a crash mid-write never corrupts the pidfile.
const writePidfile = (fleetId: string, pid: number): void => {
  const path = pidPath(fleetId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${pid}\n`);
  renameSync(tmp, path);
};

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
// `started: true` means verified-alive after a brief settle, not merely spawned;
// `pid: 0, started: false` means the spawn failed or died instantly.
export const ensureDaemon = async (
  fleetId: string,
  env: NodeJS.ProcessEnv,
  match?: string,
  // Test seam: what to spawn. The default — process.argv[1] is this CLI's
  // entry (dist/cli.js) regardless of bundling — would launch a real watcher,
  // so tests inject `sleep`/`true` stubs instead.
  argv: readonly string[] = [process.execPath, process.argv[1], "watch"]
): Promise<{ pid: number; started: boolean }> => {
  const existing = runningPid(fleetId);
  if (existing) {
    return { pid: existing, started: false };
  }
  mkdirSync(fleetDir(fleetId), { recursive: true });
  // Stale-pidfile hygiene: runningPid said "nothing alive", so any pidfile
  // here points at a dead process — drop it now rather than leaving it behind
  // if the spawn below fails.
  rmSync(pidPath(fleetId), { force: true });
  const log = openSync(watchLogPath(fleetId), "a");
  const [cmd, ...args] = argv;
  const child = spawn(cmd, args, {
    detached: true,
    env: match ? { ...env, CAPTAIN_MATCH: match } : env,
    stdio: ["ignore", log, log],
  });
  // Watch for an instant death during the settle window. A failed exec emits
  // "error" (ENOENT); a boot crash emits "exit". Either flips the flag — and
  // letting these events fire is also what reaps the child, so a just-exited
  // process never lingers as a zombie that a bare signal-0 would misread as
  // alive (session bug #1: the detached watcher died moments after boot while
  // fanout reported "started").
  let exited = false;
  child.once("error", () => {
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  child.unref();
  // The child holds its own dup of the log fd — don't leak the parent's copy.
  closeSync(log);
  if (!child.pid) {
    return { pid: 0, started: false };
  }
  writePidfile(fleetId, child.pid);
  // Spawn verification: yield to the event loop just long enough for an instant
  // death to surface, then vouch only if the child is still alive. No polling
  // loop; instant deaths are all we're catching.
  await delay(SETTLE_MS);
  if (exited || !isAlive(child.pid)) {
    rmSync(pidPath(fleetId), { force: true });
    return { pid: 0, started: false };
  }
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
