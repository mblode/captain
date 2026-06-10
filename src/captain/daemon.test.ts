import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDaemon, runningPid, stopDaemon, watcherHealth } from "./daemon";
import * as state from "./state";

const FLEET = "default";
// Near-max pid: parses fine but no live process owns it, so it reads as stale.
const DEAD_PID = 2_147_483_646;
// Spawn stubs — ensureDaemon's default argv would launch a REAL `captain watch`
// (in vitest, the test runner's entry), so every test that reaches spawn must
// inject one of these instead. `sleep` outlives the test (stopDaemon reaps it);
// `true` exits within the settle window, exercising the died-instantly path.
const LONG_LIVED = ["sleep", "300"];
const DIES_INSTANTLY = ["true"];

describe("daemon", () => {
  let dir: string;
  let pidfile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "captain-daemon-"));
    pidfile = join(dir, "watch.pid");
    vi.spyOn(state, "fleetDir").mockReturnValue(dir);
  });

  afterEach(() => {
    // Reap any stub the test left running before dropping the tmp dir — but
    // never when the pidfile holds process.pid (the liveness tests write it;
    // stopDaemon would SIGTERM this very test worker).
    if (runningPid(FLEET) !== process.pid) {
      stopDaemon(FLEET);
    }
    vi.restoreAllMocks();
    rmSync(dir, { force: true, recursive: true });
  });

  const writePid = (pid: number): void => {
    writeFileSync(pidfile, `${pid}\n`);
  };

  describe("runningPid", () => {
    it("is undefined when no pidfile exists", () => {
      expect(runningPid(FLEET)).toBeUndefined();
    });

    it("returns the pid when the process is alive", () => {
      writePid(process.pid);
      expect(runningPid(FLEET)).toBe(process.pid);
    });

    it("is undefined for a stale pid whose process is gone", () => {
      writePid(DEAD_PID);
      expect(runningPid(FLEET)).toBeUndefined();
    });

    it("rejects a 0 pidfile (process.kill(0) would signal the whole group)", () => {
      writePid(0);
      expect(runningPid(FLEET)).toBeUndefined();
    });
  });

  describe("ensureDaemon", () => {
    it("does not spawn a second watcher when one is alive", async () => {
      writePid(process.pid);
      // A live pid means ensureDaemon returns early — never reaches spawn().
      expect(await ensureDaemon(FLEET, process.env)).toEqual({
        pid: process.pid,
        started: false,
      });
    });

    it("cleans a stale pidfile and spawns fresh", async () => {
      writePid(DEAD_PID);
      const res = await ensureDaemon(FLEET, process.env, undefined, LONG_LIVED);
      expect(res.started).toBe(true);
      expect(res.pid).toBeGreaterThan(0);
      expect(res.pid).not.toBe(DEAD_PID);
      expect(runningPid(FLEET)).toBe(res.pid);
    });

    it("reports not-started when the child dies within the settle window", async () => {
      const res = await ensureDaemon(
        FLEET,
        process.env,
        undefined,
        DIES_INSTANTLY
      );
      expect(res).toEqual({ pid: 0, started: false });
      // The dead child's pidfile is cleaned up, never left for status to read.
      expect(existsSync(pidfile)).toBe(false);
      expect(runningPid(FLEET)).toBeUndefined();
    });

    it("reports not-started for an unspawnable command without crashing", async () => {
      const res = await ensureDaemon(FLEET, process.env, undefined, [
        "captain-no-such-bin",
      ]);
      expect(res).toEqual({ pid: 0, started: false });
      expect(existsSync(pidfile)).toBe(false);
    });
  });

  describe("restart sequencing (stop + ensure)", () => {
    it("turns the pidfile over to the new watcher's pid", async () => {
      const first = await ensureDaemon(
        FLEET,
        process.env,
        undefined,
        LONG_LIVED
      );
      expect(first.started).toBe(true);
      expect(stopDaemon(FLEET)).toBe(first.pid);
      expect(runningPid(FLEET)).toBeUndefined();
      const second = await ensureDaemon(
        FLEET,
        process.env,
        undefined,
        LONG_LIVED
      );
      expect(second.started).toBe(true);
      expect(second.pid).not.toBe(first.pid);
      expect(runningPid(FLEET)).toBe(second.pid);
    });

    it("skips the stop when no watcher was running", async () => {
      expect(stopDaemon(FLEET)).toBeUndefined();
      const res = await ensureDaemon(FLEET, process.env, undefined, LONG_LIVED);
      expect(res.started).toBe(true);
      expect(runningPid(FLEET)).toBe(res.pid);
    });
  });

  describe("stopDaemon", () => {
    it("reports nothing and clears a stale pidfile", () => {
      writePid(DEAD_PID);
      expect(stopDaemon(FLEET)).toBeUndefined();
      expect(runningPid(FLEET)).toBeUndefined();
    });
  });

  describe("watcherHealth", () => {
    it("reports the live pid, or not running", () => {
      expect(watcherHealth(FLEET)).toBe("not running");
      writePid(process.pid);
      expect(watcherHealth(FLEET)).toBe(`running (pid ${process.pid})`);
    });
  });
});
