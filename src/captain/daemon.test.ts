import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureDaemon, runningPid, stopDaemon, watcherHealth } from "./daemon";
import { fleetDir } from "./state";

const FLEET = "captain-test-daemon";
const dir = fleetDir(FLEET);
const pidfile = join(dir, "watch.pid");
// Near-max pid: parses fine but no live process owns it, so it reads as stale.
const DEAD_PID = 2_147_483_646;

const writePid = (pid: number): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(pidfile, `${pid}\n`);
};

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

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
  it("does not spawn a second watcher when one is alive", () => {
    writePid(process.pid);
    // A live pid means ensureDaemon returns early — never reaches spawn().
    expect(ensureDaemon(FLEET, process.env)).toEqual({
      pid: process.pid,
      started: false,
    });
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
