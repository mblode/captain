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
import { runLinearWorktree, worktreeMatch } from "./runner";
import { runRequired } from "./shell";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const safeEnv = (): NodeJS.ProcessEnv => ({
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

describe("worktreeMatch", () => {
  it("scopes to the shared parent of sibling worktrees", () => {
    expect(worktreeMatch(["/repo/wt/feat-1", "/repo/wt/feat-2"])).toBe(
      "/repo/wt"
    );
  });

  it("scopes a single worktree to its parent, not its leaf", () => {
    // So a later `fanout` adding a sibling under /repo/wt still matches.
    expect(worktreeMatch(["/repo/wt/feat-1"])).toBe("/repo/wt");
  });

  it("is undefined for an empty list (no scope)", () => {
    expect(worktreeMatch([])).toBeUndefined();
  });

  it("is undefined for disjoint trees, so the watcher stays unscoped", () => {
    expect(worktreeMatch(["/a/x", "/b/y"])).toBeUndefined();
  });
});

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
        CAPTAIN_NO_WATCH: "1",
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
    // CAPTAIN_NO_WATCH=1 suppresses auto-arming the watcher.
    expect(output.value()).not.toContain("watcher:");
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
        CAPTAIN_NO_WATCH: "1",
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
