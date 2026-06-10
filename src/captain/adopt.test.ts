import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adoptFromEvent, reconcile } from "./adopt";
import * as state from "./state";
import type { FleetState, Worktree } from "./types";

const FLEET = "default";

const fleet = (...wts: Worktree[]): FleetState => ({
  fleetId: FLEET,
  updatedAt: 0,
  worktrees: Object.fromEntries(wts.map((w) => [w.workspaceId, w])),
});

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  agent: "claude",
  cwd: "/wt/chat-tig-487",
  lastSeen: 0,
  name: "chat-tig-487",
  since: 0,
  stage: "IMPLEMENTING",
  workspaceId: "ws-1",
  ...over,
});

describe("adoption identity", () => {
  let root: string;

  beforeEach(() => {
    // record() appends history — keep it off the real ~/.claude.
    root = mkdtempSync(join(tmpdir(), "captain-adopt-"));
    vi.spyOn(state, "fleetDir").mockReturnValue(root);
    vi.stubEnv("HOME", root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  });

  it("reconcile refreshes the cwd but never re-labels a tracked worktree", () => {
    const s = fleet(wt());
    reconcile(s, [
      { cwd: "/moved/chat-tig-487", id: "ws-1", name: "renamed", ref: "w:1" },
    ]);
    expect(s.worktrees["ws-1"].cwd).toBe("/moved/chat-tig-487");
    // The name is identity (--ref/audit/intents resolve by it) — set once.
    expect(s.worktrees["ws-1"].name).toBe("chat-tig-487");
  });

  it("derives the ticket at adoption even when the cwd isn't a git repo", () => {
    const s = fleet();
    const adopted = adoptFromEvent(
      s,
      {
        cwd: "/wt/chat-tig-488",
        hookEventName: "Stop",
        seq: 1,
        workspaceId: "ws-2",
      },
      {}
    );
    expect(adopted?.ticket).toBe("tig-488");
    // No git repo to label → fall back to the directory name, never crash.
    expect(adopted?.name).toBe("chat-tig-488");
  });

  it("reconcile-adopted entries fall back to the workspace name without a ticket", () => {
    const s = fleet();
    reconcile(s, [{ cwd: "/wt/chat", id: "ws-3", name: "chat", ref: "w:3" }]);
    expect(s.worktrees["ws-3"].name).toBe("chat");
    expect(s.worktrees["ws-3"].ticket).toBeUndefined();
  });
});
