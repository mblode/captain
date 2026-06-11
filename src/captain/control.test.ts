import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runRequired } from "../shell";
import { realCmux, repoLabel } from "./control";

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

// The cmux RPC is unreliable: status-0 stdout can still be garbage. Every reader
// must treat that as "no data this tick", never a thrown exception.
describe("realCmux fails soft on garbage RPC output", () => {
  let binDir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "captain-cmux-bin-"));
    // A fake cmux that exits 0 but prints non-JSON for every rpc/top call.
    const fake = join(binDir, "cmux");
    writeFileSync(fake, "#!/bin/sh\nprintf 'not json at all'\nexit 0\n");
    chmodSync(fake, 0o755);
    env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
  });

  afterAll(async () => {
    await rm(binDir, { force: true, recursive: true });
  });

  it("feedList returns [] instead of throwing", () => {
    expect(realCmux(env).feedList()).toEqual([]);
  });

  it("listWorkspaces returns [] instead of throwing", () => {
    expect(realCmux(env).listWorkspaces()).toEqual([]);
  });
});
