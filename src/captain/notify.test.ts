import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderRubric } from "../rubric";
import type {
  CmuxFeedItem,
  CmuxPort,
  CmuxWorkspace,
  RunState,
} from "./control";
import { createNotifier } from "./notify";

// The notifier driven through the REAL surface (fleetRows over temp worktrees)
// with an in-memory CmuxPort — toasts only on change, one quiet nudge max.

interface FakePort extends CmuxPort {
  toasts: { title: string; body: string }[];
  feed: CmuxFeedItem[];
  runs: Record<string, RunState>;
}

const fakePort = (workspaces: CmuxWorkspace[]): FakePort => {
  const toasts: FakePort["toasts"] = [];
  const port: FakePort = {
    feed: [],
    feedList: () => port.feed,
    listWorkspaces: () => workspaces,
    notify: (title, body) => {
      toasts.push({ body, title });
    },
    replyExitPlan: () => {
      // not exercised here
    },
    runStates: () => port.runs,
    runs: {},
    send: () => {
      // not exercised here
    },
    toasts,
  };
  return port;
};

describe("createNotifier", () => {
  let root: string;
  let cwd: string;
  let hash: string;
  let port: FakePort;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "captain-notify-"));
    vi.stubEnv("CAPTAIN_HOME", join(root, "home"));
    cwd = join(root, "tig-430");
    mkdirSync(join(cwd, ".captain"), { recursive: true });
    const rubric = renderRubric(undefined, "TIG-430");
    ({ hash } = rubric);
    writeFileSync(join(cwd, ".captain", "rubric.md"), rubric.text);
    port = fakePort([{ cwd, id: "ws-1", name: "tig-430", ref: "tig-430" }]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(root, { force: true, recursive: true });
  });

  it("toasts once when a gate appears, never on the unchanged next tick", () => {
    const notifier = createNotifier(port, process.env);
    notifier.tick();
    expect(port.toasts).toHaveLength(0);

    port.feed = [
      {
        cwd,
        id: "feed-1",
        kind: "question",
        question_prompt: "Which db?",
        status: "pending",
      },
    ];
    notifier.tick();
    notifier.tick();
    expect(port.toasts).toEqual([
      { body: "tig-430: Which db?", title: "Captain · needs you" },
    ]);
  });

  it("toasts ready-to-merge when a passing verdict lands", () => {
    const notifier = createNotifier(port, process.env);
    notifier.tick();
    writeFileSync(
      join(cwd, ".captain", "verdict.json"),
      JSON.stringify({
        criteria: [{ evidence: "x", name: "implements", pass: true }],
        issue: "TIG-430",
        rubricHash: hash,
        summary: "all criteria pass",
        ts: 1,
        verdict: "pass",
      })
    );
    notifier.tick();
    notifier.tick();
    expect(port.toasts).toEqual([
      {
        body: "tig-430: all criteria pass",
        title: "Captain · ready to merge",
      },
    ]);
  });

  it("toasts needs-you when the verifier fails", () => {
    const notifier = createNotifier(port, process.env);
    writeFileSync(
      join(cwd, ".captain", "verdict.json"),
      JSON.stringify({
        criteria: [{ evidence: "x", name: "implements", pass: false }],
        issue: "TIG-430",
        rubricHash: hash,
        summary: "tests missing",
        ts: 1,
        verdict: "fail",
      })
    );
    notifier.tick();
    expect(port.toasts[0]).toMatchObject({ title: "Captain · needs you" });
    expect(port.toasts[0].body).toContain("tests missing");
  });

  it("nudges ONCE about a quiet idle worktree, after the threshold", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));
    vi.stubEnv("CAPTAIN_QUIET_SECS", "60");
    port.runs = { "ws-1": "idle" };
    const notifier = createNotifier(port, process.env);
    notifier.tick();
    expect(port.toasts).toHaveLength(0);

    vi.setSystemTime(new Date("2026-06-10T00:02:00Z"));
    notifier.tick();
    notifier.tick();
    expect(port.toasts).toHaveLength(1);
    expect(port.toasts[0].title).toBe("Captain · needs a look");
    expect(port.toasts[0].body).toContain("quiet for 2m");
  });

  it("a working agent is never nudged as quiet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T00:00:00Z"));
    vi.stubEnv("CAPTAIN_QUIET_SECS", "60");
    port.runs = { "ws-1": "running" };
    const notifier = createNotifier(port, process.env);
    notifier.tick();
    vi.setSystemTime(new Date("2026-06-10T01:00:00Z"));
    notifier.tick();
    expect(port.toasts).toHaveLength(0);
  });
});
