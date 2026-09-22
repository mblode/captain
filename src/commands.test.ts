import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PullRequest } from "./board";
import type {
  CmuxFeedItem,
  CmuxPort,
  CmuxWorkspace,
  RunState,
} from "./captain/control";
import { readLog } from "./captain/log";
import {
  add,
  approve,
  close,
  gain,
  init,
  peek,
  reject,
  review,
  send,
  start,
  status,
} from "./commands";
import type { Deps } from "./commands";
import { parseReview, readVerdict } from "./evidence";
import { findTask, listTasks, resolveProject } from "./project";
import { renderRubric } from "./rubric";

// The commands run for real against a temp project, a temp git repo with an
// origin, a fake `cmux` binary (for new-workspace and ping) and an in-memory
// CmuxPort + GithubPort. No mocking library.

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const tmp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
};

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_AUTHOR_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
};

const git = (cwd: string, ...args: string[]): void => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...GIT_ENV },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
};

// A product repo with one commit and an origin whose HEAD is main.
const makeRepo = (): string => {
  const root = tmp("captain-repo-");
  const repo = join(root, "app");
  mkdirSync(repo);
  git(repo, "init", "--quiet", "-b", "main");
  writeFileSync(join(repo, "README.md"), "app\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  const origin = join(root, "origin.git");
  git(root, "clone", "--quiet", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "--quiet", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  return repo;
};

// A `cmux` on PATH that answers ping and records every call.
const fakeCmuxBin = (): { bin: string; calls: string } => {
  const bin = tmp("captain-bin-");
  const calls = join(bin, "calls.log");
  const script = join(bin, "cmux");
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 0\n`
  );
  chmodSync(script, 0o755);
  return { bin, calls };
};

interface FakeCmux extends CmuxPort {
  workspaces: CmuxWorkspace[];
  runs: Record<string, RunState>;
  feed: CmuxFeedItem[];
  sent: { id: string; text: string }[];
  replies: { requestId: string; approve: boolean }[];
}

const fakeCmux = (): FakeCmux => {
  const port: FakeCmux = {
    feed: [],
    feedList: () => port.feed,
    listWorkspaces: () => port.workspaces,
    notify: () => {
      // not used by commands
    },
    reachable: () => true,
    readScreen: (id) => `screen of ${id}\nlast line`,
    replies: [],
    replyExitPlan: (requestId, ok) => {
      port.replies.push({ approve: ok, requestId });
    },
    runStates: () => port.runs,
    runs: {},
    send: (id, text) => {
      port.sent.push({ id, text });
    },
    sent: [],
    workspaces: [],
  };
  return port;
};

interface World {
  deps: Deps;
  cmux: FakeCmux;
  prs: Map<string, PullRequest>;
  output: () => string;
  calls: () => string;
  repo: string;
  env: NodeJS.ProcessEnv;
}

let world: World;

beforeEach(() => {
  const repo = makeRepo();
  const { bin, calls } = fakeCmuxBin();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    CAPTAIN_CONFIG: "/no/such/captain/config.json",
    CAPTAIN_DIR: tmp("captain-projects-"),
    CAPTAIN_PROJECT: "",
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  let text = "";
  const stdout = new Writable({
    write(chunk, _enc, done) {
      text += String(chunk);
      done();
    },
  });
  const cmux = fakeCmux();
  const prs = new Map<string, PullRequest>();
  world = {
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf-8") : ""),
    cmux,
    deps: {
      color: false,
      env,
      ports: () => ({
        cmux,
        github: { pr: (_repo, branch) => prs.get(branch) },
      }),
      stdout,
    },
    env,
    output: () => text,
    prs,
    repo,
  };
  init({ name: "rebuild", repo, wip: 2 }, world.deps);
});

const project = () => resolveProject(world.env);

// Pretend cmux opened the worker's workspace, the way `new-workspace` would.
const attach = (id: string, run: RunState = "running"): string => {
  const t = findTask(project(), id);
  const wsId = `ws-${id}`;
  world.cmux.workspaces.push({
    cwd: t.worktree,
    id: wsId,
    name: t.branch,
    ref: wsId,
  });
  world.cmux.runs[wsId] = run;
  return wsId;
};

describe("init and add", () => {
  it("creates a project folder with its own git history", () => {
    const p = project();
    expect(p.name).toBe("rebuild");
    expect(p.repo).toBe(world.repo);
    expect(p.wip).toBe(2);
    expect(existsSync(join(p.dir, "learnings.md"))).toBe(true);
    expect(existsSync(join(p.dir, ".git"))).toBe(true);
  });

  it("adds message tasks with sequential ids, defaulting to codex", async () => {
    await add("rebuild billing settings\nsame as old app", {}, world.deps);
    await add("fix login", { blockedBy: "t-1", harness: "cursor" }, world.deps);
    const [a, b] = listTasks(project()).toSorted((x, y) =>
      x.id.localeCompare(y.id)
    );
    expect(a).toMatchObject({
      harness: "codex",
      id: "t-1",
      state: "todo",
      title: "rebuild billing settings",
    });
    expect(b).toMatchObject({
      blockedBy: ["t-1"],
      harness: "cursor",
      id: "t-2",
    });
    expect(readLog(project().dir).map((r) => r.kind)).toEqual(["add", "add"]);
  });

  it("routes an escalate task to claude whatever harness was asked for", async () => {
    const t = await add(
      "migrate the billing table",
      { harness: "codex", risk: "escalate" },
      world.deps
    );
    expect(t.harness).toBe("claude");
  });

  it("refuses a bad harness or risk", async () => {
    await expect(add("x", { harness: "gemini" }, world.deps)).rejects.toThrow(
      /unknown harness/u
    );
    await expect(add("x", { risk: "high" }, world.deps)).rejects.toThrow(
      /unknown risk/u
    );
  });
});

describe("start", () => {
  it("makes a worktree, rubric and brief, and launches the harness in cmux", async () => {
    await add("rebuild billing\n\n- [ ] plans render", {}, world.deps);
    await start(["t-1"], {}, world.deps);
    const t = findTask(project(), "t-1");
    expect(t.state).toBe("active");
    expect(t.branch).toBe("t-1-rebuild-billing");
    expect(t.worktree).toBe(join(world.repo, "..", "app-t-1"));
    expect(
      readFileSync(join(t.worktree, ".captain", "rubric.md"), "utf-8")
    ).toContain("plans render");
    const brief = readFileSync(
      join(t.worktree, ".captain", "brief.md"),
      "utf-8"
    );
    expect(brief).toContain("Work on task T-1: rebuild billing.");
    expect(brief).toContain("no plan-approval gate");
    const calls = world.calls();
    expect(calls).toContain("new-workspace --name t-1-rebuild-billing");
    expect(calls).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(calls).toContain("CAPTAIN_SLOT='0'");
    expect(
      readFileSync(join(world.repo, ".git", "info", "exclude"), "utf-8")
    ).toContain(".captain/");
  });

  it("starts an escalate task in claude plan mode", async () => {
    await add("drop the legacy users table", { risk: "escalate" }, world.deps);
    await start(["t-1"], {}, world.deps);
    expect(world.calls()).toContain("--permission-mode plan");
    const t = findTask(project(), "t-1");
    expect(
      readFileSync(join(t.worktree, ".captain", "brief.md"), "utf-8")
    ).toContain("you are launched in plan mode");
  });

  it("refuses past the WIP limit, and --force overrides it", async () => {
    await add("a", {}, world.deps);
    await add("b", {}, world.deps);
    await add("c", {}, world.deps);
    await start(["t-1", "t-2"], {}, world.deps);
    attach("t-1");
    attach("t-2");
    await expect(start(["t-3"], {}, world.deps)).rejects.toThrow(
      /WIP limit is 2/u
    );
    await start(["t-3"], { force: true }, world.deps);
    expect(findTask(project(), "t-3").state).toBe("active");
  });

  it("refuses a blocked task and a task that already has a worker", async () => {
    await add("a", {}, world.deps);
    await add("b", { blockedBy: "t-1" }, world.deps);
    await expect(start(["t-2"], {}, world.deps)).rejects.toThrow(
      /blocked by t-1/u
    );
    await start(["t-1"], {}, world.deps);
    attach("t-1");
    await expect(start(["t-1"], {}, world.deps)).rejects.toThrow(
      /already has a worker/u
    );
  });

  it("--print shows the brief and launches nothing", async () => {
    await add("a", {}, world.deps);
    await start(["t-1"], { print: true }, world.deps);
    expect(world.output()).toContain("Work on task T-1: a.");
    expect(world.calls()).not.toContain("new-workspace");
    expect(findTask(project(), "t-1").state).toBe("todo");
  });
});

describe("the loop after start", () => {
  const started = async (): Promise<string> => {
    await add("rebuild billing", {}, world.deps);
    await start(["t-1"], {}, world.deps);
    return attach("t-1");
  };

  it("reports status from evidence, as JSON the chat can act on", async () => {
    await started();
    await add("queued one", {}, world.deps);
    const rows = status([], { json: true }, world.deps);
    expect(rows.map((r) => [r.id, r.group])).toEqual([
      ["t-1", "working"],
      ["t-2", "queued"],
    ]);
    expect(
      JSON.parse(world.output().slice(world.output().indexOf("{")))
    ).toMatchObject({ inProgress: 1, project: "rebuild", wip: 2 });
  });

  it("approves a plan through the feed's request_id and logs the note", async () => {
    await started();
    const t = findTask(project(), "t-1");
    world.cmux.feed.push({
      cwd: t.worktree,
      id: "feed-1",
      kind: "exitPlan",
      request_id: "req-1",
      status: "pending",
    });
    approve("t-1", { note: "scoped to one table" }, world.deps);
    expect(world.cmux.replies).toEqual([{ approve: true, requestId: "req-1" }]);
    expect(readLog(project().dir).at(-1)).toMatchObject({
      kind: "approve",
      note: "scoped to one table",
    });
  });

  it("rejects a plan and sends the note to the worker", async () => {
    const ws = await started();
    const t = findTask(project(), "t-1");
    world.cmux.feed.push({
      cwd: t.worktree,
      id: "feed-1",
      kind: "exitPlan",
      request_id: "req-1",
      status: "pending",
    });
    reject("t-1", { note: "reuse the invoices module" }, world.deps);
    expect(world.cmux.replies).toEqual([
      { approve: false, requestId: "req-1" },
    ]);
    expect(world.cmux.sent).toEqual([
      { id: ws, text: "reuse the invoices module" },
    ]);
  });

  it("fails loudly when cmux is down instead of reporting dead workers", async () => {
    await started();
    world.cmux.reachable = () => false;
    expect(() => status([], {}, world.deps)).toThrow(/cmux is not reachable/u);
  });

  it("refuses approve without a pending plan", async () => {
    await started();
    expect(() => approve("t-1", {}, world.deps)).toThrow(/no plan waiting/u);
  });

  it("sends and peeks at the worker", async () => {
    const ws = await started();
    send("t-1", "use the existing helper", {}, world.deps);
    expect(world.cmux.sent).toEqual([
      { id: ws, text: "use the existing helper" },
    ]);
    peek("t-1", { lines: 1 }, world.deps);
    expect(world.output()).toContain("last line");
    expect(world.output()).not.toContain(`screen of ${ws}`);
  });

  it("reviews an open PR with the other vendor in a second workspace", async () => {
    await started();
    const t = findTask(project(), "t-1");
    world.prs.set(t.branch, {
      checks: "pass",
      state: "open",
      url: "https://github.com/o/r/pull/9",
    });
    await review("t-1", {}, world.deps);
    const calls = world.calls();
    expect(calls).toContain(`new-workspace --name ${t.branch}:review`);
    expect(calls).toContain("claude ");
    expect(
      readFileSync(join(t.worktree, ".captain", "review-brief.md"), "utf-8")
    ).toContain("https://github.com/o/r/pull/9");
  });

  it("goes ready only once CI, a hash-checked verdict and a review all pass", async () => {
    await started();
    const t = findTask(project(), "t-1");
    world.prs.set(t.branch, {
      checks: "pass",
      state: "open",
      url: "https://github.com/o/r/pull/9",
    });
    const rubric = readFileSync(
      join(t.worktree, ".captain", "rubric.md"),
      "utf-8"
    );
    const hash = /`([0-9a-f]{16})`/u.exec(rubric)?.[1] ?? "";
    writeFileSync(
      join(t.worktree, ".captain", "verdict.json"),
      JSON.stringify({
        criteria: [],
        rubricHash: hash,
        summary: "all pass",
        ts: 1,
        verdict: "pass",
      })
    );
    expect(status(["t-1"], {}, world.deps)[0].group).toBe("captain");
    writeFileSync(
      join(t.worktree, ".captain", "review.json"),
      JSON.stringify({ summary: "clean", verdict: "pass" })
    );
    const [row] = status(["t-1"], {}, world.deps);
    expect(row.group).toBe("ready");
    expect(row.next).toContain("gh pr merge");
  });

  it("closes a task and records it", async () => {
    await started();
    close("t-1", "done", { note: "merged" }, world.deps);
    expect(findTask(project(), "t-1").state).toBe("done");
    expect(status([], {}, world.deps)).toEqual([]);
    expect(status([], { all: true }, world.deps)[0].group).toBe("closed");
    gain({ json: true }, world.deps);
    expect(world.output()).toContain('"done": 1');
  });
});

describe("evidence readers", () => {
  it("voids a verdict once the rubric is edited", () => {
    const dir = tmp("captain-wt-");
    mkdirSync(join(dir, ".captain"));
    const { hash, text } = renderRubric(undefined, "T-1");
    writeFileSync(join(dir, ".captain", "rubric.md"), text);
    writeFileSync(
      join(dir, ".captain", "verdict.json"),
      JSON.stringify({
        criteria: [],
        rubricHash: hash,
        summary: "ok",
        ts: 1,
        verdict: "pass",
      })
    );
    expect(readVerdict(dir)?.verdict).toBe("pass");
    writeFileSync(join(dir, ".captain", "rubric.md"), "weakened criteria\n");
    expect(readVerdict(dir)).toBeUndefined();
  });

  it("reads a review file and rejects anything malformed", () => {
    expect(parseReview('{"verdict":"fail","summary":"bug"}')).toEqual({
      summary: "bug",
      verdict: "fail",
    });
    expect(parseReview('{"verdict":"maybe"}')).toBeUndefined();
    expect(parseReview("")).toBeUndefined();
  });
});
