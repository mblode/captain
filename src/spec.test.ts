import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runRequired } from "./shell";
import { runSpec } from "./spec";

const writeChange = (root: string, id: string, title: string): void => {
  const dir = join(root, "openspec", "changes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), `# Change: ${title}\n`);
  writeFileSync(join(dir, "tasks.md"), "- [ ] 1.1 Do it\n");
};

describe("captain spec change resolution", () => {
  let tmp: string;

  afterEach(async () => {
    await rm(tmp, { force: true, recursive: true });
  });

  it("reads a change from the repo's OpenSpec home first, and a team change from the repo", async () => {
    tmp = mkdtempSync(join(tmpdir(), "captain-spec-"));
    const repo = join(tmp, "app");
    mkdirSync(repo);
    runRequired("git", ["init", "--quiet", "-b", "main", repo]);
    runRequired("git", [
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    ]);
    const env = {
      ...process.env,
      CAPTAIN_CONFIG: join(tmp, "config.json"),
      CAPTAIN_HOME: join(tmp, "home"),
      CAPTAIN_MEMORY_DIR: join(tmp, "memory"),
    };
    let printed = "";
    const stdout = new PassThrough();
    stdout.on("data", (c: Buffer) => {
      printed += c.toString();
    });
    await runSpec({ env, ids: [], repoOverride: repo, root: true, stdout });
    const home = printed.trim();
    expect(home.startsWith(join(tmp, "home", "openspec", "app-"))).toBe(true);

    writeChange(home, "mine", "From home");
    writeChange(repo, "mine", "Shadowed repo copy");
    writeChange(repo, "theirs", "Team change");
    printed = "";
    await runSpec({
      env,
      ids: ["mine", "theirs"],
      print: true,
      repoOverride: repo,
      stdout,
    });
    expect(printed).toContain("Work on OpenSpec change issue mine: From home.");
    expect(printed).toContain(`${home}/openspec/changes/mine/tasks.md`);
    expect(printed).not.toContain("Shadowed repo copy");
    expect(printed).toContain(
      "Work on OpenSpec change issue theirs: Team change."
    );
    expect(printed).toContain("`openspec/changes/theirs/` is the team's copy");
  });
});
