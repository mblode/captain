import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureWorktree, fetchOrigin, worktreePathFor } from "./git";
import { runRequired } from "./shell";

describe("ensureWorktree --base", () => {
  let root: string;
  let repo: string;
  const env = { ...process.env };
  const git = (...args: string[]): string =>
    runRequired("git", ["-C", repo, ...args], { env });

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "captain-base-")));
    repo = join(root, "linkiq");
    mkdirSync(repo);
    const commit = (m: string): string => {
      runRequired(
        "git",
        [
          "-C",
          repo,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "--allow-empty",
          "-q",
          "-m",
          m,
        ],
        { env }
      );
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    commit("init");
    // The prerequisite branch a dependent ticket should start from.
    git("checkout", "-q", "-b", "tig-100-prereq");
    writeFileSync(join(repo, "prereq.ts"), "export const x = 1;\n");
    git("add", "prereq.ts");
    commit("prereq work");
    git("checkout", "-q", "main");
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("branches the new worktree off the given ref, not the default branch", async () => {
    const result = await ensureWorktree({
      base: "tig-100-prereq",
      env,
      issueId: "tig-200",
      repoRoot: repo,
      skipFetch: true,
      slug: "dependent",
    });
    expect(result.branch).toBe("tig-200-dependent");
    const head = runRequired(
      "git",
      ["-C", result.worktreePath, "rev-parse", "HEAD"],
      { env }
    );
    const prereqTip = git("rev-parse", "tig-100-prereq");
    expect(head).toBe(prereqTip);
  });

  it("rejects an unresolvable base", async () => {
    await expect(
      ensureWorktree({
        base: "no-such-ref",
        env,
        issueId: "tig-201",
        repoRoot: repo,
        skipFetch: true,
        slug: "x",
      })
    ).rejects.toThrow("cannot resolve --base");
  });

  it("rechecks for a concurrently-created worktree after acquiring the lock", async () => {
    const options = {
      base: "main",
      env,
      issueId: "tig-202",
      repoRoot: repo,
      skipFetch: true,
      slug: "concurrent",
    };

    const [first, second] = await Promise.all([
      ensureWorktree(options),
      ensureWorktree(options),
    ]);

    expect(second).toEqual(first);
    expect(git("worktree", "list", "--porcelain")).toContain(
      `worktree ${first.worktreePath}`
    );
  });

  it("derives the canonical sibling path in one shared helper", () => {
    expect(worktreePathFor(repo, "tig-999")).toBe(join(root, "linkiq-tig-999"));
  });

  it("fails closed with a stable actionable error when origin fetch fails", () => {
    expect(() => fetchOrigin(repo, env)).toThrowError(
      expect.objectContaining({
        errorType: "GIT_FETCH_FAILED",
        message: expect.stringContaining(
          "verify the origin remote and network, then retry"
        ),
      })
    );
  });
});
