import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadState, now, saveState } from "./state";
import type { FleetState } from "./types";

// state.ts resolves its paths through homedir(), so the tests redirect HOME to
// a tmp dir — a `fleetDir` spy can't intercept state.ts's own internal calls.

const FLEET = "default";

const fleet = (over: Partial<FleetState> = {}): FleetState => ({
  fleetId: FLEET,
  updatedAt: 0,
  worktrees: {
    "ws-1": {
      agent: "claude",
      cwd: "/wt/tig-1",
      name: "tig-1",
      since: 100,
      stage: "IMPLEMENTING",
      workspaceId: "ws-1",
    },
  },
  ...over,
});

describe("state", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `captain-state-${process.pid}-${Math.random()}`);
    vi.stubEnv("HOME", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the default state when no file exists", () => {
    expect(loadState(FLEET)).toEqual({
      fleetId: FLEET,
      updatedAt: 0,
      worktrees: {},
    });
  });

  it("round-trips save → load and stamps updatedAt", () => {
    const before = now();
    saveState(fleet({ intentsOffset: 42, match: "/wt" }));
    const loaded = loadState(FLEET);
    expect(loaded.worktrees["ws-1"]).toMatchObject({
      name: "tig-1",
      stage: "IMPLEMENTING",
    });
    expect(loaded.intentsOffset).toBe(42);
    expect(loaded.match).toBe("/wt");
    expect(loaded.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("writes atomically: no temp file survives, repeated saves stay parseable", () => {
    const s = fleet();
    // Two quick successive saves (the watcher's hot path) — the temp+rename
    // dance must leave exactly one parseable state.json and no *.tmp litter.
    saveState(s);
    s.worktrees["ws-1"].stage = "SIMPLIFY";
    saveState(s);
    const dir = join(root, ".claude", "captain", FLEET);
    expect(readdirSync(dir)).toEqual(["state.json"]);
    const raw = readFileSync(join(dir, "state.json"), "utf-8");
    expect((JSON.parse(raw) as FleetState).worktrees["ws-1"].stage).toBe(
      "SIMPLIFY"
    );
    expect(loadState(FLEET).worktrees["ws-1"].stage).toBe("SIMPLIFY");
  });

  it("creates the fleet dir on first save", () => {
    expect(existsSync(join(root, ".claude"))).toBe(false);
    saveState(fleet());
    expect(
      existsSync(join(root, ".claude", "captain", FLEET, "state.json"))
    ).toBe(true);
  });
});
