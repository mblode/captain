import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { CmuxWorkspace } from "./captain/control";
import { boardRows, workerName } from "./evidence";
import type { Ports } from "./evidence";
import type { Project } from "./project";
import { parseTask } from "./task";

const root = mkdtempSync(join(tmpdir(), "captain-identity-"));
afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const project: Project = {
  bootstrap: "",
  checkout: "worktree",
  dir: join(root, "project"),
  name: "first",
  repo: root,
  wip: 4,
};
const task = (id: string, title = "Fix login") => ({
  ...parseTask("", id),
  branch: "main",
  state: "active" as const,
  title,
  worktree: root,
});
const workspace = (name: string, id: string, cwd = root): CmuxWorkspace => ({
  cwd,
  id,
  name,
  ref: id,
});
const unexpectedMutation = (): never => {
  throw new Error("worker discovery must not mutate cmux");
};
const ports = (workspaces: CmuxWorkspace[]): Ports => ({
  cmux: {
    feedList: () => [],
    listWorkspaces: () => workspaces,
    notify: unexpectedMutation,
    pressKey: unexpectedMutation,
    reachable: () => true,
    readScreen: () => "",
    replyExitPlan: unexpectedMutation,
    runStates: () =>
      Object.fromEntries(workspaces.map((w) => [w.id, "running"])),
    send: unexpectedMutation,
  },
  // No PR exists for these shared-checkout fixtures.
  // oxlint-disable-next-line unicorn/no-useless-undefined
  github: { pr: () => undefined },
});

describe("worker discovery across naming changes", () => {
  it.each(["t-1", "fix-login"])(
    "finds an existing %s worker even after the project changes checkout mode",
    (name) => {
      const rows = boardRows(
        project,
        [task("t-1")],
        ports([
          workspace(name, "wrong-repo", join(root, "other")),
          workspace(name, "worker"),
        ])
      );
      expect(rows[0].workspaceId).toBe("worker");
    }
  );

  it("distinguishes identical titles and project-local IDs, even after a title edit", () => {
    const first = task("t-1");
    const second = task("t-2");
    const otherProject = { ...project, name: "second" };
    const world = ports([
      workspace(workerName(otherProject, first), "other-project"),
      workspace(workerName(project, second), "second"),
      workspace(workerName(project, first), "first"),
    ]);
    expect(
      boardRows(project, [{ ...first, title: "New title" }, second], world).map(
        (row) => row.workspaceId
      )
    ).toEqual(["first", "second"]);
    expect(boardRows(otherProject, [first], world)[0].workspaceId).toBe(
      "other-project"
    );
  });

  it("reports ambiguous legacy titles instead of steering the first match", () => {
    expect(() =>
      boardRows(
        project,
        [task("t-1"), task("t-2")],
        ports([workspace("fix-login", "old-worker")])
      )
    ).toThrow("ambiguous legacy worker name");
  });

  it("reports duplicate workspaces instead of hiding a second running worker", () => {
    expect(() =>
      boardRows(
        project,
        [task("t-1")],
        ports([workspace("t-1", "one"), workspace("t-1", "two")])
      )
    ).toThrow("multiple workspaces match");
  });
});
