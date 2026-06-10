import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runRequired } from "../shell";
import { repoLabel } from "./control";

describe("repoLabel", () => {
  let root: string;
  let repo: string;
  let worktree: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "captain-repolabel-"));
    repo = join(root, "linkiq");
    worktree = join(root, "linkiq-tig-494");
    mkdirSync(repo);
    const env = { ...process.env };
    runRequired("git", ["-C", repo, "init", "-q"], { env });
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
        "init",
      ],
      { env }
    );
    runRequired(
      "git",
      ["-C", repo, "worktree", "add", "-q", worktree, "-b", "tig-494"],
      { env }
    );
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("labels the main checkout by its directory name", () => {
    expect(repoLabel(repo)).toBe("linkiq");
  });

  it("labels a linked worktree by the MAIN checkout, not the worktree dir", () => {
    expect(repoLabel(worktree)).toBe("linkiq");
  });

  it("fails soft on a path that isn't a git repo", () => {
    expect(repoLabel(join(root, "nope"))).toBeUndefined();
  });
});
