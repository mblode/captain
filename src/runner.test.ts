import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readLog } from "./captain/log";
import { launchPlanMode } from "./launch";
import { memoryPath } from "./memory";
import {
  collapsedWorktreeNotes,
  runDispatch,
  runLinearWorktree,
  runStart,
  uncappedJestNote,
} from "./runner";
import { runRequired } from "./shell";

const cleanup: string[] = [];

// Fleet-memory writes land here instead of the real ~/.claude/captain/memory.
const memoryDir = join(tmpdir(), `lw-test-memory-${process.pid}`);
// Ledger appends (launch records) land here instead of the real
// ~/.claude/captain/log.jsonl.
const homeDir = join(tmpdir(), `lw-test-home-${process.pid}`);

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const variables = JSON.parse(String(init?.body ?? "{}")) as {
        variables?: { id?: string };
      };
      const id = variables.variables?.id ?? "TST-123";
      if (String(input).includes("donebear")) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                task: { description: null, id, title: null },
                taskChecklistItems: { nodes: [] },
              },
            }),
          ok: true,
        } as Response);
      }
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            data: {
              issue: {
                description: null,
                identifier: id,
                title: null,
              },
            },
          }),
        ok: true,
      } as Response);
    })
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  cleanup.push(memoryDir, homeDir);
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const safeEnv = (): NodeJS.ProcessEnv => ({
  CAPTAIN_HOME: homeDir,
  CAPTAIN_MEMORY_DIR: memoryDir,
  DONEBEAR_TOKEN: "test-donebear-token",
  HOME: process.env.HOME,
  LINEAR_API_KEY: "test-linear-key",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
});

const captureWritable = (): {
  stream: NodeJS.WritableStream;
  value: () => string;
} => {
  let output = "";
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      output += chunk.toString();
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, value: () => output };
};

const writeExecutable = async (
  path: string,
  contents: string
): Promise<void> => {
  await writeFile(path, contents);
  await chmod(path, 0o755);
};

const createGitRepo = async (
  name: string
): Promise<{ repo: string; root: string }> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lw-test-")));
  const origin = join(root, "origin.git");
  const repo = join(root, name);

  runRequired("git", ["init", "--bare", "--initial-branch=main", origin], {
    env: safeEnv(),
  });
  runRequired("git", ["init", "--initial-branch=main", repo], {
    env: safeEnv(),
  });
  runRequired("git", ["-C", repo, "config", "user.email", "test@example.com"], {
    env: safeEnv(),
  });
  runRequired("git", ["-C", repo, "config", "user.name", "Test"], {
    env: safeEnv(),
  });
  await writeFile(join(repo, "README.md"), "test\n");
  runRequired("git", ["-C", repo, "add", "README.md"], { env: safeEnv() });
  runRequired("git", ["-C", repo, "commit", "-m", "init"], { env: safeEnv() });
  runRequired("git", ["-C", repo, "remote", "add", "origin", origin], {
    env: safeEnv(),
  });
  runRequired("git", ["-C", repo, "push", "-u", "origin", "main"], {
    env: safeEnv(),
  });
  runRequired("git", ["-C", repo, "remote", "set-head", "origin", "--auto"], {
    env: safeEnv(),
  });

  return { repo, root };
};

describe("runner integration", () => {
  it("--print creates a sibling worktree with the fallback prompt", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      stdout: output.stream,
      tokens: ["TST-123"],
    });

    const worktree = join(root, "src-tst-123");
    expect(
      runRequired("git", ["-C", worktree, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("tst-123");
    expect(output.value()).toContain("Work on Linear issue TST-123.");
    expect(output.value()).toContain(`cd ${worktree}`);
    // The captured stream is not a TTY, so the cd command is printed (`run:`)
    // but never copied to the real clipboard (which would say `copied:`).
    expect(output.value()).toContain("run:");
    expect(output.value()).not.toContain("copied:");
    // --print never launches, so nothing is ledgered.
    expect(readLog(safeEnv())).toEqual([]);
  });

  it("writes the rubric, wires memory, and injects both loop sections", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();
    const env = safeEnv();

    await runLinearWorktree({
      cwd: repo,
      env,
      print: true,
      stdout: output.stream,
      tokens: ["TST-123"],
    });

    const worktree = join(root, "src-tst-123");
    const rubric = await readFile(
      join(worktree, ".captain", "rubric.md"),
      "utf-8"
    );
    expect(rubric).toContain("# Definition of done — TST-123");
    expect(rubric).toContain("## How to verify");
    // The rubric must never show up in the worktree's diff.
    expect(
      await readFile(join(repo, ".git", "info", "exclude"), "utf-8")
    ).toContain(".captain/");
    // The fleet memory file exists and the prompt closes both loops. The path is
    // derived (disambiguated by repoRoot hash), not the legacy bare basename.
    const memory = memoryPath(repo, env);
    expect(await readFile(memory, "utf-8")).toContain("## Inbox");
    expect(output.value()).toContain("<workflow>");
    expect(output.value()).toContain("<finishing-protocol>");
    expect(output.value()).toContain("<fleet-memory>");
    expect(output.value()).toContain(memory);
  });

  it("errors when not in a git repo and no --repo is given", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lw-nogit-")));
    cleanup.push(dir);

    await expect(
      runLinearWorktree({
        cwd: dir,
        env: safeEnv(),
        print: true,
        tokens: ["TST-123"],
      })
    ).rejects.toThrow(/not in a git repo/u);
  });

  it("fails closed with an actionable error when issue context is unavailable", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const env = safeEnv();
    delete env.LINEAR_API_KEY;

    await expect(
      runLinearWorktree({ cwd: repo, env, print: true, tokens: ["TST-404"] })
    ).rejects.toMatchObject({
      errorType: "ISSUE_FETCH_FAILED",
      message:
        "cannot fetch Linear issue TST-404 — set LINEAR_API_KEY, then retry",
    });
    await expect(access(join(root, "src-tst-404"))).rejects.toThrow();

    vi.mocked(fetch).mockResolvedValueOnce({
      json: () => Promise.resolve({}),
      ok: false,
    } as Response);
    await expect(
      runLinearWorktree({
        cwd: repo,
        env: safeEnv(),
        print: true,
        tokens: ["TST-405"],
      })
    ).rejects.toMatchObject({
      errorType: "ISSUE_FETCH_FAILED",
      message: expect.stringContaining(
        "verify the issue id, credentials, and network"
      ),
    });
    await expect(access(join(root, "src-tst-405"))).rejects.toThrow();
  });

  it("fails before source preparation or launch when git fetch fails", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const env = safeEnv();
    runRequired(
      "git",
      ["-C", repo, "remote", "set-url", "origin", join(root, "missing.git")],
      { env }
    );

    await expect(
      runLinearWorktree({
        cwd: repo,
        env,
        print: true,
        tokens: ["TST-406"],
      })
    ).rejects.toMatchObject({ errorType: "GIT_FETCH_FAILED" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(access(join(root, "src-tst-406"))).rejects.toThrow();
    expect(readLog(env)).toEqual([]);
  });

  it("rejects multi-issue --print before preparing any worktree", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);

    await expect(
      runLinearWorktree({
        cwd: repo,
        env: safeEnv(),
        print: true,
        tokens: ["TST-1", "TST-2"],
      })
    ).rejects.toMatchObject({
      errorType: "USAGE",
      message: expect.stringContaining("one issue at a time"),
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(access(join(root, "src-tst-1"))).rejects.toThrow();
    await expect(access(join(root, "src-tst-2"))).rejects.toThrow();
  });

  it("reuses an existing worktree on a repeat run instead of erroring", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);

    await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      tokens: ["TST-123"],
    });

    const output = captureWritable();
    const status = await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      stdout: output.stream,
      tokens: ["TST-123"],
    });

    expect(status).toBe(0);
    const worktree = join(root, "src-tst-123");
    expect(output.value()).toContain(`cd ${worktree}`);
  });

  it("recreates a worktree whose directory was deleted but is still registered", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);

    await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      tokens: ["TST-123"],
    });

    // Delete the directory without telling git, leaving a stale registration.
    const worktree = join(root, "src-tst-123");
    await rm(worktree, { force: true, recursive: true });

    const status = await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      tokens: ["TST-123"],
    });

    expect(status).toBe(0);
    expect(
      runRequired("git", ["-C", worktree, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("tst-123");
  });

  it("fans out one cmux workspace per issue with a safely quoted repo", async () => {
    const { repo, root } = await createGitRepo("src repo");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "cmux.log");

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$CMUX_LOG"
`
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");

    const output = captureWritable();
    const errput = captureWritable();
    await runLinearWorktree({
      cwd: repo,
      env: {
        ...safeEnv(),
        CMUX_LOG: log,
        PATH: `${binDir}:${safeEnv().PATH}`,
      },
      repoOverride: repo,
      stderr: errput.stream,
      stdout: output.stream,
      tokens: ["TST-1", "TST-2"],
    });

    const cmuxLog = await readFile(log, "utf-8");
    expect(cmuxLog).toContain("new-workspace --name tst-1");
    expect(cmuxLog).toContain("new-workspace --name tst-2");
    expect(cmuxLog).toContain("--focus false");
    expect(cmuxLog).toContain(
      "claude --model 'default' --effort 'high' --permission-mode plan --allow-dangerously-skip-permissions"
    );
    expect(output.value()).toContain("spawned 2 workspaces");
    // No watcher to arm — the agents self-drive; status is the read surface.
    expect(output.value()).toContain("follow along: captain status");
    expect(errput.value()).toContain("[1/2] TST-1 ·");
    expect(errput.value()).toContain("opened tst-1 (1/2)");
    expect(errput.value()).toContain("opened tst-2 (2/2)");
    expect(errput.value().match(/git fetch origin/gu)).toHaveLength(1);

    const worktree1 = join(root, "src repo-tst-1");
    expect(
      runRequired("git", ["-C", worktree1, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("tst-1");

    // Each launch is ledgered under the repo-qualified identity approve/reject
    // will log later, so gain can join launch→decision latency by name.
    const launches = readLog(safeEnv()).filter((r) => r.kind === "launch");
    expect(launches.map((r) => r.name)).toEqual([
      "src repo-tst-1",
      "src repo-tst-2",
    ]);
  });

  it("skips source and git preparation for an all-reused batch", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);

    await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      tokens: ["TST-1"],
    });
    await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      print: true,
      tokens: ["TST-2"],
    });
    const fetchesBeforeRetry = vi.mocked(fetch).mock.calls.length;

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
if [ "$1" = "rpc" ] && [ "$2" = "workspace.list" ]; then
  printf '{"workspaces":[{"id":"ANCHOR-1","ref":"a1","description":"anchor-1","current_directory":"%s/src-tst-1"},{"id":"WS-1","ref":"r1","description":"tst-1","current_directory":"%s/src-tst-1"},{"id":"ANCHOR-2","ref":"a2","description":"anchor-2","current_directory":"%s/src-tst-2"},{"id":"WS-2","ref":"r2","description":"tst-2","current_directory":"%s/src-tst-2"}]}' "$ROOT" "$ROOT" "$ROOT" "$ROOT"
  exit 0
fi
if [ "$1" = "top" ]; then
  printf '0\t0\t0\ttag\tworkspace:WS-1:tag:claude_code\tworkspace:WS-1\tRunning\n'
  printf '0\t0\t0\ttag\tworkspace:WS-2:tag:claude_code\tworkspace:WS-2\tRunning\n'
fi
`
    );
    const env = {
      ...safeEnv(),
      PATH: `${binDir}:${safeEnv().PATH}`,
      ROOT: root,
    };
    runRequired(
      "git",
      ["-C", repo, "remote", "set-url", "origin", join(root, "missing.git")],
      { env }
    );

    const output = captureWritable();
    const status = await runLinearWorktree({
      cwd: repo,
      env,
      json: true,
      stdout: output.stream,
      tokens: ["TST-1", "TST-2"],
    });

    expect(status).toBe(0);
    const result = JSON.parse(output.value()) as {
      started: { workspaceId?: string }[];
    };
    expect(result.started.map((item) => item.workspaceId)).toEqual([
      "WS-1",
      "WS-2",
    ]);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(fetchesBeforeRetry);
  });

  it("ledgers the launch under cmux's actual workspace name when it differs", async () => {
    // A no-ticket dispatch identity falls back to the workspace name, so a
    // cmux dedupe/rename would break the launch→decision join unless the
    // launch record uses the name cmux actually assigned.
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
if [ "$1" = "rpc" ] && [ "$2" = "workspace.list" ]; then
  printf '{"workspaces":[{"id":"WS-1","ref":"r","description":"tidy-the-readme-copy","current_directory":"%s"}]}' "$REPO"
  exit 0
fi
exit 0
`
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");

    const output = captureWritable();
    await runStart({
      cwd: repo,
      env: {
        ...safeEnv(),
        PATH: `${binDir}:${safeEnv().PATH}`,
        REPO: repo,
      },
      stdout: output.stream,
      tokens: ["tidy", "the", "readme"],
    });

    const launches = readLog(safeEnv()).filter((r) => r.kind === "launch");
    expect(launches.map((r) => r.name)).toEqual(["tidy-the-readme-copy"]);
  });

  it("still launches when the ledger is unwritable (launch logging is fail-soft)", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "cmux.log");

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$CMUX_LOG"
`
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");

    // CAPTAIN_HOME pointing at a regular FILE makes appendLog's mkdir throw.
    const brokenHome = join(root, "not-a-dir");
    await writeFile(brokenHome, "");

    const status = await runLinearWorktree({
      cwd: repo,
      env: {
        ...safeEnv(),
        CAPTAIN_HOME: brokenHome,
        CMUX_LOG: log,
        PATH: `${binDir}:${safeEnv().PATH}`,
      },
      tokens: ["TST-999"],
    });

    expect(status).toBe(0);
    // The launch itself still went through cmux — only the sample was lost.
    expect(await readFile(log, "utf-8")).toContain(
      "new-workspace --name tst-999"
    );
  });

  it("opens a single focused cmux workspace rooted at the worktree", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "cmux.log");

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$CMUX_LOG"
`
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");

    const status = await runLinearWorktree({
      cwd: repo,
      env: {
        ...safeEnv(),
        CMUX_LOG: log,
        PATH: `${binDir}:${safeEnv().PATH}`,
      },
      tokens: ["TST-789"],
    });

    expect(status).toBe(0);
    const cmuxLog = await readFile(log, "utf-8");
    expect(cmuxLog).toContain("new-workspace --name tst-789");
    expect(cmuxLog).toContain("--focus true");
    expect(cmuxLog).toContain(
      "claude --model 'default' --effort 'high' --permission-mode plan --allow-dangerously-skip-permissions"
    );

    const worktree = join(root, "src-tst-789");
    expect(
      runRequired("git", ["-C", worktree, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("tst-789");
  });

  it("reuses a live cmux workspace on retry instead of launching a duplicate", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "cmux.log");
    const state = join(root, "cmux.state");
    const active = join(root, "cmux.active");
    const worktree = join(root, "src-tst-790");

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
if [ "$1" = "rpc" ] && [ "$2" = "workspace.list" ]; then
  if [ -f "$CMUX_STATE" ]; then
    printf '{"workspaces":[{"id":"WS-ANCHOR","ref":"anchor","description":"group anchor","current_directory":"%s"},{"id":"WS-REUSE","ref":"r","description":"tst-790","current_directory":"%s"}]}' "$WORKTREE" "$WORKTREE"
  fi
  exit 0
fi
if [ "$1" = "top" ]; then
  if [ -f "$CMUX_ACTIVE" ]; then
    printf '0\t0\t0\ttag\tworkspace:WS-REUSE:tag:claude_code\tworkspace:WS-REUSE\tRunning\n'
  fi
  exit 0
fi
if [ "$1" = "new-workspace" ]; then
  printf '%s\\n' "$*" >> "$CMUX_LOG"
  touch "$CMUX_STATE"
  touch "$CMUX_ACTIVE"
fi
`
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
    const env = {
      ...safeEnv(),
      CMUX_ACTIVE: active,
      CMUX_LOG: log,
      CMUX_STATE: state,
      PATH: `${binDir}:${safeEnv().PATH}`,
      WORKTREE: worktree,
    };

    await runLinearWorktree({ cwd: repo, env, tokens: ["TST-790"] });
    const rubricPath = join(worktree, ".captain", "rubric.md");
    await writeFile(rubricPath, "retry sentinel\n");
    const sourceFetchesBeforeRetry = vi.mocked(fetch).mock.calls.length;
    // A retry must not touch origin either. Making the remote invalid turns any
    // accidental fetch into a hard failure while the live reuse still succeeds.
    runRequired(
      "git",
      ["-C", repo, "remote", "set-url", "origin", join(root, "missing.git")],
      { env }
    );
    const retryOutput = captureWritable();
    const status = await runLinearWorktree({
      cwd: repo,
      env,
      stdout: retryOutput.stream,
      tokens: ["TST-790"],
    });

    expect(status).toBe(0);
    expect(retryOutput.value()).toContain(
      "reusing existing cmux workspace tst-790"
    );
    expect(vi.mocked(fetch).mock.calls).toHaveLength(sourceFetchesBeforeRetry);
    expect(await readFile(rubricPath, "utf-8")).toBe("retry sentinel\n");
    const cmuxLog = await readFile(log, "utf-8");
    expect(cmuxLog.match(/new-workspace/gu)).toHaveLength(1);
    expect(
      readLog(env).filter((record) => record.kind === "launch")
    ).toHaveLength(1);

    runRequired(
      "git",
      ["-C", repo, "remote", "set-url", "origin", join(root, "origin.git")],
      { env }
    );

    // --agent selects the agent for a NEW launch; it does not force a duplicate
    // while an exact-cwd tagged agent is still active.
    await runLinearWorktree({
      agent: "codex",
      cwd: repo,
      env,
      tokens: ["TST-790"],
    });
    const switchedAgentLog = await readFile(log, "utf-8");
    expect(switchedAgentLog.match(/new-workspace/gu)).toHaveLength(1);
    expect(
      readLog(env).filter((record) => record.kind === "launch")
    ).toHaveLength(1);

    // An active agent without Captain's authoritative rubric is not reusable:
    // normal preparation must restore fleet membership before rejoining it.
    await rm(rubricPath);
    const sourceFetchesBeforeRepair = vi.mocked(fetch).mock.calls.length;
    await runLinearWorktree({ cwd: repo, env, tokens: ["TST-790"] });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(
      sourceFetchesBeforeRepair + 1
    );
    expect(await readFile(rubricPath, "utf-8")).toContain(
      "# Definition of done — TST-790"
    );
    const repairedLog = await readFile(log, "utf-8");
    expect(repairedLog.match(/new-workspace/gu)).toHaveLength(1);

    // A same-cwd shell with no cmux-top agent tag is stale, not reusable.
    await rm(active);
    await runLinearWorktree({ cwd: repo, env, tokens: ["TST-790"] });
    const relaunchedLog = await readFile(log, "utf-8");
    expect(relaunchedLog.match(/new-workspace/gu)).toHaveLength(2);
    expect(
      readLog(env).filter((record) => record.kind === "launch")
    ).toHaveLength(2);
  });

  it("launches codex (best-effort, no plan mode) when --agent codex is set", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "cmux.log");

    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
printf '%s\\n' "$*" >> "$CMUX_LOG"
`
    );
    // codex must be on PATH for the launch probe to pass.
    await writeExecutable(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");

    const status = await runStart({
      agent: "codex",
      cwd: repo,
      env: {
        ...safeEnv(),
        CMUX_LOG: log,
        PATH: `${binDir}:${safeEnv().PATH}`,
      },
      tokens: ["TST-654"],
    });

    expect(status).toBe(0);
    const cmuxLog = await readFile(log, "utf-8");
    expect(cmuxLog).toContain("new-workspace --name tst-654");
    expect(cmuxLog).toContain(
      "codex -c model_reasoning_effort='high' --dangerously-bypass-approvals-and-sandbox"
    );
    // best-effort: no claude plan-mode flags leak into a codex launch.
    expect(cmuxLog).not.toContain("--permission-mode plan");
  });

  it("falls back to inline launch when cmux is not available", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "claude.log");

    await writeExecutable(
      join(binDir, "claude"),
      `#!/bin/sh
pwd > "$CLAUDE_LOG"
printf '%s\\n' "$*" >> "$CLAUDE_LOG"
`
    );

    const status = await runLinearWorktree({
      cwd: repo,
      env: {
        ...safeEnv(),
        CLAUDE_LOG: log,
        PATH: `${binDir}:${safeEnv().PATH}`,
      },
      tokens: ["TST-321"],
    });

    expect(status).toBe(0);
    const worktree = join(root, "src-tst-321");
    const launchLog = await readFile(log, "utf-8");
    expect(launchLog).toContain(worktree);
    expect(launchLog).toContain(
      "--model default --effort high --permission-mode plan --allow-dangerously-skip-permissions"
    );
    // The inline-fallback path ledgers the launch too.
    const launches = readLog(safeEnv()).filter((r) => r.kind === "launch");
    expect(launches.map((r) => r.name)).toEqual(["src-tst-321"]);
  });

  it("launches claude from the worktree with skip permissions", async () => {
    const { root } = await createGitRepo("src");
    const worktree = join(root, "src-tst-456");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);
    const log = join(root, "claude.log");

    await writeExecutable(
      join(binDir, "claude"),
      `#!/bin/sh
pwd > "$CLAUDE_LOG"
printf '%s\\n' "$*" >> "$CLAUDE_LOG"
`
    );

    await rm(worktree, { force: true, recursive: true });
    await mkdir(worktree);
    const status = launchPlanMode(worktree, "prompt body", {
      ...safeEnv(),
      CLAUDE_LOG: log,
      PATH: `${binDir}:${safeEnv().PATH}`,
    });

    expect(status).toBe(0);
    const launchLog = await readFile(log, "utf-8");
    expect(launchLog).toContain(worktree);
    expect(launchLog).toContain(
      "--model default --effort high --permission-mode plan --allow-dangerously-skip-permissions prompt body"
    );
  });
});

describe("start --json", () => {
  it("--print --json emits the brief metadata as one JSON value (Linear)", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    await runLinearWorktree({
      cwd: repo,
      env: safeEnv(),
      json: true,
      print: true,
      stdout: output.stream,
      tokens: ["TST-123"],
    });

    const parsed = JSON.parse(output.value().trim()) as {
      cwd: string;
      name: string;
      prompt: string;
    };
    expect(parsed.name).toBe("tst-123");
    expect(parsed.cwd).toBe(join(root, "src-tst-123"));
    expect(parsed.prompt).toContain("Work on Linear issue TST-123.");
    // No human hint lines leak into the JSON value.
    expect(output.value()).not.toContain("copied:");
  });

  it("fans out and emits { started: [...] } with workspace ids", async () => {
    const { repo, root } = await createGitRepo("src");
    const binDir = await mkdtemp(join(tmpdir(), "lw-bin-"));
    cleanup.push(root, binDir);

    // A fake cmux that reports a workspace per worktree on workspace.list, so
    // --json can resolve each cwd to an id.
    await writeExecutable(
      join(binDir, "cmux"),
      `#!/bin/sh
if [ "$1" = "ping" ]; then exit 0; fi
if [ "$1" = "rpc" ] && [ "$2" = "workspace.list" ]; then
  printf '{"workspaces":[{"id":"WS-1","ref":"r","current_directory":"%s/src-tst-1"},{"id":"WS-2","ref":"r","current_directory":"%s/src-tst-2"}]}' "$ROOT" "$ROOT"
  exit 0
fi
exit 0
`
    );
    await writeExecutable(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");

    const output = captureWritable();
    await runLinearWorktree({
      cwd: repo,
      env: {
        ...safeEnv(),
        PATH: `${binDir}:${safeEnv().PATH}`,
        ROOT: root,
      },
      json: true,
      repoOverride: repo,
      stdout: output.stream,
      tokens: ["TST-1", "TST-2"],
    });

    const parsed = JSON.parse(output.value().trim()) as {
      started: {
        name: string;
        branch: string;
        cwd: string;
        workspaceId?: string;
      }[];
    };
    expect(parsed.started).toHaveLength(2);
    expect(parsed.started[0]).toMatchObject({
      branch: "tst-1",
      name: "tst-1",
      workspaceId: "WS-1",
    });
    expect(parsed.started[1].workspaceId).toBe("WS-2");
    expect(output.value()).not.toContain("follow along");
  });

  it("dispatch --print --json omits branch (runs in the checkout)", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    await runDispatch({
      cwd: repo,
      env: safeEnv(),
      json: true,
      print: true,
      stdout: output.stream,
      task: "tidy the README",
    });

    const parsed = JSON.parse(output.value().trim()) as {
      cwd: string;
      name: string;
      prompt: string;
      branch?: string;
    };
    expect(parsed.name).toBe("tidy-the-readme");
    expect(parsed.cwd).toBe(repo);
    expect(parsed.branch).toBeUndefined();
    expect(parsed.prompt).toContain("Task:\n\ntidy the README");
  });
});

describe("runDispatch (non-Linear, current dir)", () => {
  it("--print writes the task brief into the current checkout, no worktree", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    const status = await runDispatch({
      cwd: repo,
      env: { ...safeEnv(), CAPTAIN_SKILLS: "/tidy,/pr-creator" },
      print: true,
      stdout: output.stream,
      task: "tidy the README",
    });

    expect(status).toBe(0);
    // .captain/ lands in the repo root itself (no sibling worktree created).
    const rubric = await readFile(join(repo, ".captain", "rubric.md"), "utf-8");
    expect(rubric).toContain("# Definition of done — tidy-the-readme");
    expect(rubric).toContain("- Source: free-form");
    expect(rubric).toContain("implements the task **tidy-the-readme**");
    expect(rubric).not.toContain("Linear issue");
    expect(
      await readFile(join(repo, ".git", "info", "exclude"), "utf-8")
    ).toContain(".captain/");
    // The brief carries the task text, the configured skills, and the loops.
    expect(output.value()).toContain("Task:\n\ntidy the README");
    expect(output.value()).toContain("Run /tidy.");
    expect(output.value()).toContain("Run /pr-creator.");
    expect(output.value()).toContain("<finishing-protocol>");
    expect(output.value()).toContain("<fleet-memory>");
  });

  it("errors on an empty task", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);

    await expect(
      runDispatch({ cwd: repo, env: safeEnv(), print: true, task: "   " })
    ).rejects.toThrow(/usage: captain start/u);
  });

  it("excludes .captain via the common git dir when the repo is a linked worktree", async () => {
    // A linked worktree's `.git` is a FILE, not a directory — writing the exclude
    // under `<worktree>/.git/info` would ENOTDIR. The write must resolve the
    // common git dir (the main checkout's .git) instead.
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const worktree = join(root, "src-linked");
    runRequired(
      "git",
      ["-C", repo, "worktree", "add", "-b", "linked-wt", worktree],
      { env: safeEnv() }
    );

    const output = captureWritable();
    const status = await runDispatch({
      cwd: worktree,
      env: safeEnv(),
      print: true,
      repoOverride: worktree,
      stdout: output.stream,
      task: "tidy the readme",
    });

    expect(status).toBe(0);
    // The rubric still lands in the worktree itself...
    expect(
      await readFile(join(worktree, ".captain", "rubric.md"), "utf-8")
    ).toContain("# Definition of done");
    // ...but the exclude write resolves the COMMON git dir (the main checkout's
    // .git), never the worktree's `.git` FILE.
    expect(
      await readFile(join(repo, ".git", "info", "exclude"), "utf-8")
    ).toContain(".captain/");
  });
});

describe("runStart routing", () => {
  it("routes a Linear issue id to the worktree fan-out", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    await runStart({
      cwd: repo,
      env: safeEnv(),
      print: true,
      stdout: output.stream,
      tokens: ["TST-7"],
    });

    expect(output.value()).toContain("Work on Linear issue TST-7.");
    expect(output.value()).toContain(`cd ${join(root, "src-tst-7")}`);
  });

  it("routes a donebear task UUID to the worktree fan-out (no-token coarse path)", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    // No DONEBEAR_TOKEN in safeEnv → fetch degrades to undefined, so the brief
    // uses the coarse donebear wording and a db-<8hex> worktree, deterministically.
    const uuid = "35a2097c-a5c9-477f-b50c-d39b942567a9";
    await runStart({
      cwd: repo,
      env: safeEnv(),
      print: true,
      stdout: output.stream,
      tokens: [uuid],
    });

    const worktree = join(root, "src-db-35a2097c");
    expect(
      runRequired("git", ["-C", worktree, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("db-35a2097c");
    // The brief names donebear, not Linear.
    expect(output.value()).toContain("Work on donebear issue db-35a2097c.");
    const rubric = await readFile(
      join(worktree, ".captain", "rubric.md"),
      "utf-8"
    );
    expect(rubric).toContain("# Definition of done — db-35a2097c");
    expect(rubric).toContain("implements donebear issue db-35a2097c");
  });

  it("routes free-form text to a current-dir dispatch", async () => {
    const { repo, root } = await createGitRepo("src");
    cleanup.push(root);
    const output = captureWritable();

    await runStart({
      cwd: repo,
      env: safeEnv(),
      print: true,
      stdout: output.stream,
      tokens: ["tidy", "the", "readme"],
    });

    expect(output.value()).toContain("Task:\n\ntidy the readme");
    // dispatch runs in place — the rubric lands in the checkout, no sibling.
    expect(
      await readFile(join(repo, ".captain", "rubric.md"), "utf-8")
    ).toContain("# Definition of done — tidy-the-readme");
  });
});

describe("collapsedWorktreeNotes", () => {
  it("stays silent when the workspace list is empty (unreliable RPC)", () => {
    expect(collapsedWorktreeNotes(["/wt/chat-tig-487"], [])).toEqual([]);
  });

  it("stays silent when every worktree owns a workspace", () => {
    const notes = collapsedWorktreeNotes(
      ["/wt/chat-tig-487", "/wt/chat-tig-488"],
      [{ cwd: "/wt/chat-tig-487" }, { cwd: "/other/root/chat-tig-488" }]
    );
    expect(notes).toEqual([]);
  });

  it("names the ticket whose worktree got no dedicated workspace", () => {
    const notes = collapsedWorktreeNotes(
      ["/wt/chat-tig-487", "/wt/chat-tig-488"],
      [{ cwd: "/wt/chat-tig-487" }, { cwd: "/wt/chat" }]
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("chat-tig-488");
    expect(notes[0]).toContain("captain fanout TIG-488");
  });
});

describe("uncappedJestNote", () => {
  const makeCheckout = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "lw-test-jest-"));
    cleanup.push(dir);
    return dir;
  };

  it("stays silent when the checkout has no jest config", async () => {
    expect(uncappedJestNote(await makeCheckout())).toBeNull();
  });

  it("warns when a root jest config sets no maxWorkers", async () => {
    const dir = await makeCheckout();
    await writeFile(join(dir, "jest.config.js"), "module.exports = {}");
    expect(uncappedJestNote(dir)).toContain("jest.config.js");
    expect(uncappedJestNote(dir)).toContain("maxWorkers");
  });

  it("finds an uncapped config one level down in src/", async () => {
    const dir = await makeCheckout();
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "jest.config.js"), "module.exports = {}");
    expect(uncappedJestNote(dir)).toContain("src/jest.config.js");
  });

  it("stays silent when the config caps maxWorkers", async () => {
    const dir = await makeCheckout();
    await writeFile(
      join(dir, "jest.config.js"),
      "module.exports = { maxWorkers: '25%' }"
    );
    expect(uncappedJestNote(dir)).toBeNull();
  });
});
