import {
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

import { afterEach, describe, expect, it } from "vitest";

import { launchPlanMode } from "./launch";
import { memoryPath } from "./memory";
import {
  collapsedWorktreeNotes,
  runDispatch,
  runLinearWorktree,
  runStart,
} from "./runner";
import { runRequired } from "./shell";

const cleanup: string[] = [];

// Fleet-memory writes land here instead of the real ~/.claude/captain/memory.
const memoryDir = join(tmpdir(), `lw-test-memory-${process.pid}`);

afterEach(async () => {
  cleanup.push(memoryDir);
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const safeEnv = (): NodeJS.ProcessEnv => ({
  CAPTAIN_MEMORY_DIR: memoryDir,
  HOME: process.env.HOME,
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
      "claude --permission-mode plan --allow-dangerously-skip-permissions"
    );
    expect(output.value()).toContain("spawned 2 workspaces");
    // No watcher to arm — the agents self-drive; status is the read surface.
    expect(output.value()).toContain("follow along: captain status");
    expect(errput.value()).toContain("[1/2] TST-1 ·");
    expect(errput.value()).toContain("opened tst-1 (1/2)");
    expect(errput.value()).toContain("opened tst-2 (2/2)");

    const worktree1 = join(root, "src repo-tst-1");
    expect(
      runRequired("git", ["-C", worktree1, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("tst-1");
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
      "claude --permission-mode plan --allow-dangerously-skip-permissions"
    );

    const worktree = join(root, "src-tst-789");
    expect(
      runRequired("git", ["-C", worktree, "branch", "--show-current"], {
        env: safeEnv(),
      })
    ).toBe("tst-789");
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
      "--permission-mode plan --allow-dangerously-skip-permissions"
    );
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
      "--permission-mode plan --allow-dangerously-skip-permissions prompt body"
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
      env: { ...safeEnv(), CAPTAIN_SKILLS: "/simplify,/pr-creator" },
      print: true,
      stdout: output.stream,
      task: "tidy the README",
    });

    expect(status).toBe(0);
    // .captain/ lands in the repo root itself (no sibling worktree created).
    const rubric = await readFile(join(repo, ".captain", "rubric.md"), "utf-8");
    expect(rubric).toContain("# Definition of done — tidy-the-readme");
    expect(
      await readFile(join(repo, ".git", "info", "exclude"), "utf-8")
    ).toContain(".captain/");
    // The brief carries the task text, the configured skills, and the loops.
    expect(output.value()).toContain("Task:\n\ntidy the README");
    expect(output.value()).toContain("Run /simplify.");
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
