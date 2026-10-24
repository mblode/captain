import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { CliError, EXIT } from "./errors";
import { gitCommonDir } from "./git";
import { ensureMemoryFile } from "./memory";
import { run } from "./shell";
import { parseTask, renderTask } from "./task";
import type { Task } from "./task";

// A project is one folder of plain files, kept in its own small git repo so the
// task list has history and undo:
//
//   ~/captain/<name>/project.json   the product repo, the WIP limit, bootstrap
//   ~/captain/<name>/tasks/<id>.md  one file per task (see task.ts)
//   ~/captain/<name>/learnings.md   shared memory injected into every brief
//   ~/captain/<name>/log.jsonl      every start, approve, reject, review, close
//
// The chat maintains the task files directly; `captain` commands write through
// here. It lives outside the product repo, so it never lands in an agent's PR.

// How a project's workers share the repo. `shared` (the default): every worker
// runs in the repo's own checkout on its current branch, commits only its own
// paths with an `[<id>]` tag and pushes to that branch; the human merges the
// branch, and each worker then checks production. `worktree`: each task gets
// its own worktree, branch and PR, reviewed by the other vendor.
export const CHECKOUTS = ["shared", "worktree"] as const;
export type Checkout = (typeof CHECKOUTS)[number];

export interface Project {
  name: string;
  dir: string;
  // the product repo: the shared checkout, or what every worktree branches from
  repo: string;
  checkout: Checkout;
  // max tasks in progress at once (each one is a PR you will review)
  wip: number;
  // optional shell command run in each new worktree before the agent starts
  // (install deps, copy env files, pick ports from $CAPTAIN_SLOT)
  bootstrap: string;
}

const DEFAULT_WIP = 4;

const projectsRoot = (env: NodeJS.ProcessEnv): string =>
  env.CAPTAIN_DIR || join(env.HOME || homedir(), "captain");

const PROJECT_FILE = "project.json";

const readProject = (dir: string, name: string): Project => {
  let raw: Partial<Project> = {};
  try {
    raw = JSON.parse(
      readFileSync(join(dir, PROJECT_FILE), "utf-8")
    ) as Partial<Project>;
  } catch {
    throw new CliError(
      `${join(dir, PROJECT_FILE)} is missing or not JSON; run \`captain init ${name} --repo <path>\``,
      EXIT.USAGE,
      "NO_PROJECT"
    );
  }
  if (typeof raw.repo !== "string" || !raw.repo) {
    throw new CliError(
      `${join(dir, PROJECT_FILE)} has no "repo"`,
      EXIT.USAGE,
      "NO_PROJECT"
    );
  }
  const wip = Number(raw.wip);
  return {
    bootstrap: typeof raw.bootstrap === "string" ? raw.bootstrap : "",
    checkout: raw.checkout === "worktree" ? "worktree" : "shared",
    dir,
    name,
    repo: raw.repo,
    wip: Number.isInteger(wip) && wip > 0 ? wip : DEFAULT_WIP,
  };
};

const projectNames = (root: string): string[] => {
  try {
    return readdirSync(root).filter((name) =>
      existsSync(join(root, name, PROJECT_FILE))
    );
  } catch {
    return [];
  }
};

// The main checkout of the git repo holding `cwd`, or undefined outside one.
// Every linked worktree resolves to the same root.
export const mainRepoRoot = (
  cwd: string,
  env: NodeJS.ProcessEnv
): string | undefined =>
  run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { env }).status === 0
    ? dirname(gitCommonDir(cwd, env))
    : undefined;

// The one project whose repo is `repo`, if any.
export const projectForRepo = (
  env: NodeJS.ProcessEnv,
  repo: string
): Project | undefined => {
  const root = projectsRoot(env);
  const matches = projectNames(root)
    .map((n) => readProject(join(root, n), n))
    .filter((p) => p.repo === repo);
  return matches.length === 1 ? matches[0] : undefined;
};

// Which project a command runs against: --project, then $CAPTAIN_PROJECT, then
// the project whose repo holds the current directory, then the only project
// there is. Anything ambiguous is an error that names the choices, never a
// guess (a wrong-repo launch was v2's worst silent failure).
export const resolveProject = (
  env: NodeJS.ProcessEnv,
  name?: string,
  cwd = process.cwd()
): Project => {
  const root = projectsRoot(env);
  const chosen = name || env.CAPTAIN_PROJECT;
  if (chosen) {
    return readProject(join(root, chosen), chosen);
  }
  const here = mainRepoRoot(cwd, env);
  const local = here ? projectForRepo(env, here) : undefined;
  if (local) {
    return local;
  }
  const names = projectNames(root);
  if (names.length === 1) {
    return readProject(join(root, names[0]), names[0]);
  }
  throw new CliError(
    names.length === 0
      ? `no project in ${root}; run \`captain init <name> --repo <path>\``
      : `several projects (${names.join(", ")}); pass --project or set CAPTAIN_PROJECT`,
    EXIT.USAGE,
    "NO_PROJECT"
  );
};

const tasksDir = (project: Project): string => join(project.dir, "tasks");

export const learningsPath = (project: Project): string =>
  join(project.dir, "learnings.md");

export const logDir = (project: Project): string => project.dir;

const git = (project: Project, args: string[]): number | null =>
  run("git", ["-C", project.dir, ...args]).status;

// Record the task list's state in the project's own git history. Best-effort:
// history is a convenience, and a commit failure must never fail the command.
export const commit = (project: Project, message: string): void => {
  git(project, ["add", "-A"]);
  git(project, [
    "-c",
    "user.name=captain",
    "-c",
    "user.email=captain@localhost",
    "commit",
    "--quiet",
    "--no-verify",
    "-m",
    message,
  ]);
};

export const initProject = (
  env: NodeJS.ProcessEnv,
  options: {
    name: string;
    repo: string;
    wip?: number;
    bootstrap?: string;
    checkout?: Checkout;
  }
): Project => {
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(options.name)) {
    throw new CliError(
      `project name "${options.name}" must be letters, digits, dot, dash or underscore`,
      EXIT.USAGE,
      "BAD_NAME"
    );
  }
  const repo = resolve(options.repo);
  if (
    run("git", ["-C", repo, "rev-parse", "--show-toplevel"]).stdout.trim() !==
    repo
  ) {
    throw new CliError(
      `${repo} is not the root of a git repo`,
      EXIT.USAGE,
      "BAD_REPO"
    );
  }
  const dir = join(projectsRoot(env), options.name);
  mkdirSync(join(dir, "tasks"), { recursive: true });
  const project: Project = {
    bootstrap: options.bootstrap ?? "",
    checkout: options.checkout ?? "shared",
    dir,
    name: options.name,
    repo,
    wip: options.wip ?? DEFAULT_WIP,
  };
  writeFileSync(
    join(dir, PROJECT_FILE),
    `${JSON.stringify({ bootstrap: project.bootstrap, checkout: project.checkout, repo, wip: project.wip }, null, 2)}\n`
  );
  ensureMemoryFile(learningsPath(project));
  if (!existsSync(join(dir, ".git"))) {
    run("git", ["init", "--quiet", dir]);
  }
  commit(project, `init ${options.name}`);
  return project;
};

const taskPath = (project: Project, id: string): string =>
  join(tasksDir(project), `${id}.md`);

export const listTasks = (project: Project): Task[] => {
  let files: string[] = [];
  try {
    files = readdirSync(tasksDir(project)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return files
    .filter((f) => statSync(join(tasksDir(project), f)).isFile())
    .map((f) =>
      parseTask(
        readFileSync(join(tasksDir(project), f), "utf-8"),
        f.slice(0, -3)
      )
    );
};

export const findTask = (project: Project, id: string): Task => {
  const wanted = id.trim().toLowerCase();
  const task = listTasks(project).find((t) => t.id === wanted);
  if (!task) {
    throw new CliError(
      `no task "${id}" in ${tasksDir(project)}`,
      EXIT.USAGE,
      "UNKNOWN_TASK"
    );
  }
  return task;
};

export const taskExists = (project: Project, id: string): boolean =>
  existsSync(taskPath(project, id));

export const writeTask = (project: Project, task: Task): void => {
  mkdirSync(tasksDir(project), { recursive: true });
  writeFileSync(taskPath(project, task.id), renderTask(task));
};
