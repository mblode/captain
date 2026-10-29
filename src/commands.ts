import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { inProgress, openBlockers, sortRows } from "./board";
import type { Row } from "./board";
import { appendLog, now, readLog } from "./captain/log";
import { explainCmuxUnreachable, harnessCommand, openWorkspace } from "./cmux";
import {
  loadAgentEnv,
  loadDataScope,
  loadHarnessDefaults,
  loadSkills,
  REVIEW_EFFORT,
} from "./config";
import { CliError, EXIT } from "./errors";
import { boardRows, isShared, reviewName, workerName } from "./evidence";
import type { Ports } from "./evidence";
import { renderBoard, renderGain, renderTaskLine } from "./format";
import { screenPlanApprovable } from "./gate";
import {
  ensureWorktree,
  gitCommonDir,
  sharedBranchOf,
  worktreePathFor,
} from "./git";
import { openBlockers as issueBlockers, slugify } from "./issue";
import { readMemoryExcerpt } from "./memory";
import { isChange, listChanges, openspecHome, readChange } from "./openspec";
import {
  commit,
  findTask,
  initProject,
  learningsPath,
  listTasks,
  logDir,
  mainRepoRoot,
  projectForRepo,
  resolveProject,
  taskExists,
  writeTask,
} from "./project";
import type { Checkout as CheckoutMode, Project } from "./project";
import { renderPrompt, renderPromptExtras, renderReviewPrompt } from "./prompt";
import {
  renderRubric,
  REVIEW_RELPATH,
  sharedStateDir,
  statePaths,
} from "./rubric";
import type { Shared } from "./rubric";
import { sourceFor } from "./source";
import { computeGain } from "./stats";
import {
  criteriaOf,
  HARNESSES,
  nextMessageId,
  otherVendor,
  parseList,
  RISKS,
  smokeOf,
  titleFromMessage,
} from "./task";
import type { Harness, Risk, Task } from "./task";
import type { Issue } from "./types";

// Every command the chat (or you) runs. Each takes its world as `Deps`, so the
// tests drive the real code against a fake cmux and a fake GitHub.

export interface Deps {
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  ports: () => Ports;
  color: boolean;
  // how long `start` waits for each claude worker's agent to appear; unset
  // skips the check (the tests' fake cmux never runs an agent)
  startTimeoutMs?: number;
}

interface Common {
  project?: string;
  json?: boolean;
}

const out = (deps: Deps, text: string): void => {
  deps.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

const json = (deps: Deps, value: unknown): void => {
  out(deps, JSON.stringify(value, null, 2));
};

const today = (): string => new Date().toISOString().slice(0, 10);

const asHarness = (value: string | undefined): Harness | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  if (!(HARNESSES as readonly string[]).includes(v)) {
    throw new CliError(
      `unknown harness "${value}" (use ${HARNESSES.join(", ")})`,
      EXIT.USAGE,
      "BAD_HARNESS"
    );
  }
  return v as Harness;
};

const asRisk = (value: string | undefined): Risk | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  if (!(RISKS as readonly string[]).includes(v)) {
    throw new CliError(
      `unknown risk "${value}" (use ${RISKS.join(", ")})`,
      EXIT.USAGE,
      "BAD_RISK"
    );
  }
  return v as Risk;
};

// An escalate task always runs in Claude Code plan mode: it is the one harness
// with a stop the agent can't pass on its own. Claude is also the default:
// it is the harness the fleet actually runs (codex and cursor are opt-in).
const harnessFor = (risk: Risk, chosen: Harness | undefined): Harness =>
  risk === "escalate" ? "claude" : (chosen ?? "claude");

export const init = (
  options: Common & {
    name: string;
    repo: string;
    wip?: number;
    bootstrap?: string;
    checkout?: CheckoutMode;
  },
  deps: Deps
): void => {
  const project = initProject(deps.env, options);
  if (options.json) {
    json(deps, {
      checkout: project.checkout,
      dir: project.dir,
      name: project.name,
      repo: project.repo,
      wip: project.wip,
    });
    return;
  }
  out(
    deps,
    `created ${project.dir}\n  repo     ${project.repo}\n  checkout ${project.checkout}\n  wip      ${project.wip}`
  );
};

// ---------------------------------------------------------------- add

export interface AddOptions extends Common {
  title?: string;
  risk?: string;
  harness?: string;
  model?: string;
  effort?: string;
  blockedBy?: string;
}

const issueBody = (issue: Issue): string => {
  let body = issue.description?.trim() ?? "";
  const criteria = (issue.criteria ?? []).filter((c) => c.title);
  if (criteria.length > 0) {
    body += `${body ? "\n\n" : ""}## Acceptance criteria\n\n${criteria
      .map((c) => `- [ ] ${c.title}${c.ref ? ` (${c.ref})` : ""}`)
      .join("\n")}`;
  }
  return body;
};

// Add a task from a chat message or a ticket (Linear id/URL, Done Bear
// URL/UUID). A ticket is copied in with its blockers and checklist, and keeps
// a link back; after that, the task file is the record.
export const add = async (
  input: string,
  options: AddOptions,
  deps: Deps
): Promise<Task> => {
  const project = resolveProject(deps.env, options.project);
  const text = input.trim();
  if (!text) {
    throw new CliError(
      "nothing to add: pass a message or a ticket",
      EXIT.USAGE,
      "EMPTY"
    );
  }
  const risk = asRisk(options.risk) ?? "low";
  const base = {
    branch: "",
    created: today(),
    effort: options.effort ?? "",
    harness: harnessFor(risk, asHarness(options.harness)),
    model: options.model ?? "",
    risk,
    state: "todo" as const,
    worktree: "",
  };
  let task: Task;
  const source = sourceFor(text);
  if (source) {
    const { parsed, fetch } = source.prepare(text);
    const issue = await fetch(deps.env);
    if (!issue) {
      throw new CliError(
        `could not fetch ${parsed.displayId} from ${source.name} (is ${source.credential} set?)`,
        EXIT.GENERIC,
        "FETCH_FAILED"
      );
    }
    task = {
      ...base,
      blockedBy: [
        ...issueBlockers(issue).map((id) => id.toLowerCase()),
        ...parseList(options.blockedBy),
      ],
      body: issueBody(issue),
      id: parsed.issueId,
      source: text,
      title: options.title ?? issue.title ?? parsed.displayId,
    };
  } else {
    task = {
      ...base,
      blockedBy: parseList(options.blockedBy),
      body: text,
      id: nextMessageId(listTasks(project).map((t) => t.id)),
      source: "",
      title: options.title ?? titleFromMessage(text),
    };
  }
  if (taskExists(project, task.id)) {
    throw new CliError(
      `task ${task.id} already exists`,
      EXIT.USAGE,
      "TASK_EXISTS"
    );
  }
  writeTask(project, task);
  appendLog({ kind: "add", name: task.id, ts: now() }, logDir(project));
  commit(project, `add ${task.id}: ${task.title}`);
  if (options.json) {
    json(deps, { task });
  } else {
    out(deps, `added ${task.id}  ${task.title}`);
  }
  return task;
};

// ---------------------------------------------------------------- start

export interface StartOptions extends Common {
  harness?: string;
  model?: string;
  effort?: string;
  force?: boolean;
  print?: boolean;
}

// Keep `.captain/` (rubric, plan, verdict, review, brief) out of every
// worktree's diff. Linked worktrees share the main checkout's
// `.git/info/exclude`, so one line covers them all; nothing is committed.
const excludeCaptainDir = async (
  repo: string,
  env: NodeJS.ProcessEnv
): Promise<void> => {
  const excludePath = join(gitCommonDir(repo, env), "info", "exclude");
  const current = await readFile(excludePath, "utf-8").catch(() => "");
  if (current.split("\n").includes(".captain/")) {
    return;
  }
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(
    excludePath,
    `${current.endsWith("\n") || current === "" ? "" : "\n"}.captain/\n`
  );
};

const issueOf = (task: Task): Issue => ({
  criteria: criteriaOf(task.body).map((title) => ({ title })),
  description: task.body,
  identifier: task.id.toUpperCase(),
  title: task.title,
});

// A task added by `captain spec` names its OpenSpec change in `source`.
const OPENSPEC_SOURCE = "openspec:";

const briefFor = (
  project: Project,
  task: Task,
  env: NodeJS.ProcessEnv,
  shared?: Shared
): string => {
  const memoryPath = learningsPath(project);
  const rubricPath = statePaths(shared).rubric;
  return (
    renderPrompt(task, rubricPath) +
    renderPromptExtras({
      dataScope: loadDataScope(env),
      gated: task.risk === "escalate",
      harness: task.harness,
      id: task.id,
      memory: readMemoryExcerpt(memoryPath),
      memoryPath,
      openspecHome: task.source.startsWith(OPENSPEC_SOURCE)
        ? openspecHome(project.repo, env)
        : undefined,
      rubricPath,
      shared,
      skills: loadSkills(env),
      workflow: true,
    })
  );
};

const requireCmux = (env: NodeJS.ProcessEnv): void => {
  const why = explainCmuxUnreachable(env);
  if (why) {
    throw new CliError(why, EXIT.CMUX_UNREACHABLE, "CMUX_UNREACHABLE");
  }
};

// Where a task runs: its own worktree and branch, or the project repo's checkout
// on its current branch, with its captain files under its own state dir.
interface Checkout {
  cwd: string;
  branch: string;
  shared?: Shared;
}

const checkoutFor = async (
  project: Project,
  task: Task,
  env: NodeJS.ProcessEnv
): Promise<Checkout> => {
  if (project.checkout === "shared") {
    const { baseSha, branch } = sharedBranchOf(project.repo, env);
    return {
      branch,
      cwd: project.repo,
      shared: { baseSha, branch, stateDir: sharedStateDir(task.id) },
    };
  }
  // The folder carries the project name: two projects on one repo both have a
  // `t-1`. A task started before that keeps the worktree it already has.
  const worktree = await ensureWorktree({
    branch:
      task.worktree && task.worktree !== project.repo && task.branch
        ? task.branch
        : undefined,
    env,
    issueId: `${project.name}/${task.id}`,
    repoRoot: project.repo,
    slug: slugify(task.title),
    worktreePath:
      task.worktree && task.worktree !== project.repo
        ? task.worktree
        : worktreePathFor(project.repo, `${project.name}-${task.id}`),
  });
  return { branch: worktree.branch, cwd: worktree.worktreePath };
};

// Start one task: a worktree off the project repo (or the shared checkout), its
// rubric and brief, and a full harness in its own cmux workspace. Refuses a
// blocked task and refuses past the WIP limit (unless --force), because every
// started task is work you will have to review.
const refuseStart = (
  project: Project,
  task: Task,
  options: StartOptions,
  rows: Row[]
): void => {
  const all = listTasks(project);
  if (task.state === "done" || task.state === "dropped") {
    throw new CliError(
      `task ${task.id} is ${task.state}`,
      EXIT.USAGE,
      "TASK_CLOSED"
    );
  }
  const row = rows.find((r) => r.id === task.id);
  if (row?.workspaceId) {
    throw new CliError(
      `task ${task.id} already has a worker (captain peek ${task.id})`,
      EXIT.USAGE,
      "ALREADY_RUNNING"
    );
  }
  const blockers = openBlockers(task, all);
  if (blockers.length > 0 && !options.force) {
    throw new CliError(
      `task ${task.id} is blocked by ${blockers.join(", ")} (--force to start anyway)`,
      EXIT.USAGE,
      "BLOCKED"
    );
  }
  if (
    task.state !== "active" &&
    inProgress(rows) >= project.wip &&
    !options.force &&
    !options.print
  ) {
    throw new CliError(
      `${inProgress(rows)} tasks in progress, WIP limit is ${project.wip}. Merge or close one first (--force to override)`,
      EXIT.USAGE,
      "WIP_LIMIT"
    );
  }
};

// Write a task's rubric, brief and session into its checkout, then open its
// cmux workspace running the harness. Returns the launch command.
const launch = async (
  project: Project,
  task: Task,
  checkout: Checkout,
  rows: Row[],
  env: NodeJS.ProcessEnv
): Promise<string> => {
  const { shared } = checkout;
  const paths = statePaths(shared);
  await mkdir(join(checkout.cwd, shared?.stateDir ?? ".captain"), {
    recursive: true,
  });
  if (shared) {
    // A relaunch is a fresh run: the last run's plan, verdict and smoke test
    // no longer apply.
    for (const file of [paths.verdict, paths.plan, paths.smoke]) {
      await rm(join(checkout.cwd, file), { force: true });
    }
  }
  await writeFile(
    join(checkout.cwd, paths.rubric),
    renderRubric(
      issueOf(task),
      // A shared run's commits are tagged with the id as written, so the tag
      // matches the OpenSpec change it may have come from.
      shared ? task.id : task.id.toUpperCase(),
      loadDataScope(env),
      "Captain",
      shared ? { ...shared, smoke: smokeOf(task.body) } : undefined
    ).text
  );
  const promptPath = join(checkout.cwd, paths.brief);
  await writeFile(promptPath, briefFor(project, task, env, shared));
  await excludeCaptainDir(project.repo, env);
  // Claude's fixed session id is how a shared worker's feed gates are told
  // apart from its neighbours' (they all share one cwd).
  const sessionId =
    shared && task.harness === "claude" ? randomUUID() : undefined;
  if (shared) {
    await writeFile(join(checkout.cwd, paths.session), sessionId ?? "");
  }
  const name = workerName(project, {
    ...task,
    branch: checkout.branch,
    worktree: checkout.cwd,
  });
  const command = harnessCommand({
    bin: loadHarnessDefaults(task.harness, env).bin,
    // The bootstrap prepares a fresh worktree; in the shared checkout it would
    // run once per worker, concurrently, in the same directory.
    bootstrap: shared ? undefined : project.bootstrap,
    effort: task.effort,
    env: { ...loadAgentEnv(env), CAPTAIN_SLOT: String(inProgress(rows)) },
    gated: task.risk === "escalate",
    harness: task.harness,
    model: task.model,
    name,
    promptPath,
    sessionId,
  });
  openWorkspace({ command, cwd: checkout.cwd, env, name });
  return command;
};

const startOne = async (
  project: Project,
  id: string,
  options: StartOptions,
  deps: Deps,
  rows: Row[]
): Promise<Task & { command: string }> => {
  let task = findTask(project, id);
  refuseStart(project, task, options, rows);

  const { risk } = task;
  const harness = harnessFor(risk, asHarness(options.harness) ?? task.harness);
  const defaults = loadHarnessDefaults(harness, deps.env);
  task = {
    ...task,
    effort: options.effort ?? (task.effort || defaults.effort),
    harness,
    model: options.model ?? (task.model || defaults.model),
  };

  if (options.print) {
    const checkout =
      project.checkout === "shared"
        ? await checkoutFor(project, task, deps.env)
        : undefined;
    return {
      ...task,
      command: briefFor(project, task, deps.env, checkout?.shared),
    };
  }
  requireCmux(deps.env);

  const checkout = await checkoutFor(project, task, deps.env);
  const command = await launch(project, task, checkout, rows, deps.env);

  task = {
    ...task,
    branch: checkout.branch,
    state: "active",
    worktree: checkout.cwd,
  };
  writeTask(project, task);
  appendLog(
    {
      kind: "start",
      name: task.id,
      note: `${harness} ${task.model} ${task.effort}`.trim(),
      ts: now(),
    },
    logDir(project)
  );
  commit(project, `start ${task.id} on ${harness}`);
  return { ...task, command };
};

// cmux types `--command` into the new shell before its init finishes, so a
// startup prompt that reads stdin (fnm or nvm offering to install the repo's
// Node version) can swallow the agent command and leave a bare shell that
// looks started. Wait for each claude worker's `cmux top` tag; codex and
// cursor carry no reliable tag, so they aren't checked.
const unstartedWorkers = async (
  cmux: Ports["cmux"],
  names: string[],
  timeoutMs: number,
  intervalMs = 2000
): Promise<string[]> => {
  let pending = names;
  const deadline = Date.now() + timeoutMs;
  while (pending.length > 0) {
    const runs = cmux.runStates();
    const workspaces = cmux.listWorkspaces();
    pending = pending.filter(
      (name) =>
        !workspaces.some((w) => w.name === name && w.id.toLowerCase() in runs)
    );
    if (pending.length === 0 || Date.now() >= deadline) {
      break;
    }
    await sleep(intervalMs);
  }
  return pending;
};

export const start = async (
  ids: string[],
  options: StartOptions,
  deps: Deps
): Promise<{ unstarted: string[] }> => {
  if (ids.length === 0) {
    throw new CliError("pass the task id(s) to start", EXIT.USAGE, "NO_TASK");
  }
  const project = resolveProject(deps.env, options.project);
  const started: (Task & { command: string })[] = [];
  for (const id of ids) {
    // Re-derive the board before each start, so the WIP check counts the
    // task started one iteration earlier.
    const rows = options.print
      ? []
      : boardRows(project, listTasks(project), deps.ports());
    started.push(await startOne(project, id, options, deps, rows));
  }
  const unstartedNames =
    options.print || deps.startTimeoutMs === undefined
      ? []
      : await unstartedWorkers(
          deps.ports().cmux,
          started
            .filter((t) => t.harness === "claude")
            .map((t) => workerName(project, t)),
          deps.startTimeoutMs
        );
  const unstarted = started
    .filter((t) => unstartedNames.includes(workerName(project, t)))
    .map((t) => t.id);
  if (options.json) {
    json(deps, { started, unstarted });
    return { unstarted };
  }
  for (const t of started) {
    out(
      deps,
      options.print
        ? t.command
        : `started ${t.id} on ${t.harness}${t.model && t.model !== "default" ? ` (${t.model})` : ""} in ${t.worktree}`
    );
  }
  for (const id of unstarted) {
    out(
      deps,
      `not started ${id}: no agent in its workspace after ${Math.round((deps.startTimeoutMs ?? 0) / 1000)}s. If its screen shows the launch command above the first prompt, shell init read stdin and ate it (often fnm or nvm asking to install the repo's Node version). Fix the shell, close that workspace, then captain start ${id}`
    );
  }
  return { unstarted };
};

// ---------------------------------------------------------------- spec

export interface SpecOptions extends StartOptions {
  all?: boolean;
  root?: boolean;
  risk?: string;
  // the repo to run in, for a driver whose cwd is elsewhere (default: cwd)
  repoPath?: string;
}

// The project an OpenSpec launch runs against: --project or $CAPTAIN_PROJECT,
// else the project whose repo holds the current directory. Never the "only
// project" fallback, which would launch one repo's changes in another. With
// no project for this repo yet, one is created (shared checkout), so a repo
// with OpenSpec changes needs no setup.
const specProject = (options: SpecOptions, deps: Deps): Project => {
  if (options.project || deps.env.CAPTAIN_PROJECT) {
    return resolveProject(deps.env, options.project);
  }
  const repo = mainRepoRoot(resolve(options.repoPath ?? "."), deps.env);
  if (!repo) {
    throw new CliError(
      "not inside a git repo: run from the repo, or pass --repo-path or --project",
      EXIT.USAGE,
      "NO_PROJECT"
    );
  }
  const found = projectForRepo(deps.env, repo);
  if (found) {
    return found;
  }
  const project = initProject(deps.env, {
    checkout: "shared",
    name: basename(repo),
    repo,
  });
  out(deps, `created project ${project.name} for ${repo}`);
  return project;
};

// The task for an OpenSpec change. A new or not-yet-started task takes the
// change folder's current text; a started one keeps the contract it ran with.
const taskForChange = (
  project: Project,
  home: string,
  id: string,
  options: SpecOptions
): Task => {
  const { title, body } = readChange(home, id);
  if (taskExists(project, id)) {
    const existing = findTask(project, id);
    if (existing.state !== "todo") {
      return existing;
    }
    const refreshed = { ...existing, body, title };
    writeTask(project, refreshed);
    return refreshed;
  }
  const risk = asRisk(options.risk) ?? "low";
  const task: Task = {
    blockedBy: [],
    body,
    branch: "",
    created: today(),
    effort: options.effort ?? "",
    harness: harnessFor(risk, asHarness(options.harness)),
    id,
    model: options.model ?? "",
    risk,
    source: `${OPENSPEC_SOURCE}${id}`,
    state: "todo",
    title,
    worktree: "",
  };
  writeTask(project, task);
  appendLog({ kind: "add", name: id, ts: now() }, logDir(project));
  return task;
};

// Start OpenSpec changes: each becomes a task (see taskForChange) and starts
// like any other. `--all` takes every active change that has no task in flight
// or closed, up to the WIP limit; the rest wait for the next run.
export const spec = async (
  ids: string[],
  options: SpecOptions,
  deps: Deps
): Promise<{ unstarted: string[] }> => {
  // --root only prints where the changes live: it must not create a project.
  const repoHere = mainRepoRoot(resolve(options.repoPath ?? "."), deps.env);
  if (
    options.root &&
    repoHere &&
    !options.project &&
    !deps.env.CAPTAIN_PROJECT
  ) {
    out(deps, openspecHome(repoHere, deps.env));
    return { unstarted: [] };
  }
  const project = specProject(options, deps);
  const home = openspecHome(project.repo, deps.env);
  if (options.root) {
    out(deps, home);
    return { unstarted: [] };
  }
  const tasks = listTasks(project);
  const wanted = options.all
    ? listChanges(home).filter((id) => {
        const task = tasks.find((t) => t.id === id);
        return !task || task.state === "todo";
      })
    : ids.map((id) => id.trim().toLowerCase());
  if (wanted.length === 0) {
    throw new CliError(
      options.all
        ? `no change to start in ${home}/openspec/changes`
        : "pass the change id(s), or --all",
      EXIT.USAGE,
      "NO_CHANGE"
    );
  }
  for (const id of wanted) {
    if (!isChange(home, id)) {
      throw new CliError(
        `no OpenSpec change "${id}" in ${home}/openspec/changes`,
        EXIT.USAGE,
        "UNKNOWN_CHANGE"
      );
    }
  }
  for (const id of wanted) {
    taskForChange(project, home, id, options);
  }
  commit(project, `spec ${wanted.join(", ")}`);
  const startable = options.all
    ? wanted.filter(
        (id) => openBlockers(findTask(project, id), tasks).length === 0
      )
    : wanted;
  const room =
    options.all && !options.force && !options.print
      ? Math.max(
          0,
          project.wip -
            inProgress(boardRows(project, listTasks(project), deps.ports()))
        )
      : startable.length;
  const starting = startable.slice(0, room);
  const waiting = wanted.filter((id) => !starting.includes(id));
  const result =
    starting.length > 0
      ? await start(starting, { ...options, project: project.name }, deps)
      : { unstarted: [] };
  if (waiting.length > 0 && !options.json) {
    out(
      deps,
      `queued ${waiting.join(", ")} (blocked or past the WIP limit of ${project.wip}): captain spec --all again once one ships`
    );
  }
  return result;
};

// ---------------------------------------------------------------- status

export interface StatusOptions extends Common {
  all?: boolean;
}

export const status = (
  ids: string[],
  options: StatusOptions,
  deps: Deps
): Row[] => {
  const project = resolveProject(deps.env, options.project);
  const tasks = listTasks(project);
  const wanted = new Set(ids.map((i) => i.toLowerCase()));
  const rows = sortRows(boardRows(project, tasks, deps.ports())).filter(
    (r) =>
      (wanted.size === 0 || wanted.has(r.id)) &&
      (options.all || wanted.size > 0 || r.group !== "closed")
  );
  if (options.json) {
    json(deps, {
      inProgress: inProgress(rows),
      project: project.name,
      rows,
      wip: project.wip,
    });
  } else {
    out(deps, renderBoard(project, rows, deps.color));
  }
  return rows;
};

// ---------------------------------------------------------------- one task

const rowFor = (project: Project, id: string, deps: Deps): Row => {
  const tasks = listTasks(project);
  const task = findTask(project, id);
  const row = boardRows(project, tasks, deps.ports()).find(
    (r) => r.id === task.id
  );
  if (!row) {
    throw new CliError(`no task "${id}"`, EXIT.USAGE, "UNKNOWN_TASK");
  }
  return row;
};

const workerOf = (row: Row): string => {
  if (!row.workspaceId) {
    throw new CliError(
      `task ${row.id} has no running worker (captain start ${row.id})`,
      EXIT.USAGE,
      "NO_WORKER"
    );
  }
  return row.workspaceId;
};

const planGate = (row: Row): void => {
  if (row.gate?.kind !== "plan") {
    throw new CliError(
      `task ${row.id} has no plan waiting for approval`,
      EXIT.USAGE,
      "NO_PLAN_GATE"
    );
  }
};

// Answer a plan gate: through the feed, or with a keypress on the menu when
// the gate was read off the screen. Enter takes the highlighted approval, so
// it is pressed only when that is the bypass-permissions option; Escape
// declines and leaves the agent in plan mode at its prompt.
const replyToPlan = (row: Row, approved: boolean, ports: Ports): void => {
  planGate(row);
  const { cmux } = ports;
  if (!row.gate?.onScreen) {
    cmux.replyExitPlan(row.gate?.replyId ?? "", approved);
    return;
  }
  const worker = workerOf(row);
  if (approved && !screenPlanApprovable(cmux.readScreen(worker))) {
    throw new CliError(
      `the plan menu for ${row.id} has no highlighted "Yes, and bypass permissions" option, so nothing was approved. Answer it in the workspace (captain peek ${row.id})`,
      EXIT.GENERIC,
      "PLAN_MENU_UNRECOGNISED"
    );
  }
  cmux.pressKey(worker, approved ? "enter" : "escape");
};

export const approve = (
  id: string,
  options: Common & { note?: string },
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  replyToPlan(row, true, deps.ports());
  appendLog(
    { kind: "approve", name: row.id, note: options.note, ts: now() },
    logDir(project)
  );
  if (options.json) {
    json(deps, { approved: row.id, note: options.note });
  } else {
    out(deps, `approved ${row.id}`);
  }
};

export const reject = (
  id: string,
  options: Common & { note: string },
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  const ports = deps.ports();
  replyToPlan(row, false, ports);
  // Denying the plan returns the agent to planning; the feedback is what it
  // re-plans against.
  ports.cmux.send(workerOf(row), options.note);
  appendLog(
    { kind: "reject", name: row.id, note: options.note, ts: now() },
    logDir(project)
  );
  if (options.json) {
    json(deps, { note: options.note, rejected: row.id });
  } else {
    out(deps, `rejected ${row.id}: sent your note back to the agent`);
  }
};

export const send = (
  id: string,
  message: string,
  options: Common,
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  deps.ports().cmux.send(workerOf(row), message);
  if (options.json) {
    json(deps, { sent: row.id });
  } else {
    out(deps, `sent to ${row.id}`);
  }
};

export const peek = (
  id: string,
  options: Common & { lines?: number },
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  const screen = deps.ports().cmux.readScreen(workerOf(row));
  const lines = screen.trimEnd().split("\n");
  const tail = lines.slice(-(options.lines ?? 40)).join("\n");
  if (options.json) {
    json(deps, { id: row.id, screen: tail });
  } else {
    out(deps, `${renderTaskLine(row, deps.color)}\n\n${tail}`);
  }
};

// Have the other vendor review the PR: a second workspace in the same
// worktree, running a review-only brief that writes `.captain/review.json`.
export const review = async (
  id: string,
  options: Common & { harness?: string; model?: string; effort?: string },
  deps: Deps
): Promise<void> => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  const task = findTask(project, id);
  if (isShared(project, task)) {
    throw new CliError(
      `task ${task.id} runs in the shared checkout and has no PR of its own to review`,
      EXIT.USAGE,
      "SHARED_TASK"
    );
  }
  if (!row.pr || row.pr.state !== "open") {
    throw new CliError(
      `task ${task.id} has no open PR to review`,
      EXIT.USAGE,
      "NO_PR"
    );
  }
  requireCmux(deps.env);
  const harness = asHarness(options.harness) ?? otherVendor(task.harness);
  const defaults = loadHarnessDefaults(harness, deps.env);
  const promptPath = join(task.worktree, ".captain", "review-brief.md");
  // A fresh review replaces the last one, so a stale pass never outlives the
  // fixes it asked for.
  await writeFile(join(task.worktree, REVIEW_RELPATH), "").catch(() => {
    // no previous review
  });
  await writeFile(promptPath, renderReviewPrompt(task, row.pr.url));
  openWorkspace({
    command: harnessCommand({
      bin: defaults.bin,
      effort: options.effort ?? (defaults.effort ? REVIEW_EFFORT : ""),
      env: loadAgentEnv(deps.env),
      gated: false,
      harness,
      model: options.model ?? defaults.model,
      name: reviewName(task.branch),
      promptPath,
    }),
    cwd: task.worktree,
    env: deps.env,
    name: reviewName(task.branch),
  });
  appendLog(
    { kind: "review", name: task.id, note: harness, ts: now() },
    logDir(project)
  );
  if (options.json) {
    json(deps, { harness, reviewing: task.id });
  } else {
    out(deps, `reviewing ${task.id} with ${harness}`);
  }
};

// Close a task: `done` once merged, `drop` when it's abandoned.
export const close = (
  id: string,
  state: "done" | "dropped",
  options: Common & { note?: string },
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const task = { ...findTask(project, id), state };
  writeTask(project, task);
  appendLog(
    {
      kind: state === "done" ? "done" : "drop",
      name: task.id,
      note: options.note,
      ts: now(),
    },
    logDir(project)
  );
  commit(project, `${state} ${task.id}`);
  if (options.json) {
    json(deps, { id: task.id, state });
  } else {
    out(
      deps,
      `${state} ${task.id}${task.worktree && !isShared(project, task) ? `\n  remove the worktree when you're finished: git worktree remove ${task.worktree}` : ""}`
    );
  }
};

// ---------------------------------------------------------------- gain

export const gain = (
  options: Common & { since?: string },
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const metrics = computeGain({
    log: readLog(logDir(project)),
    now: now(),
    since: options.since,
    tasks: listTasks(project),
  });
  if (options.json) {
    json(deps, metrics);
  } else {
    out(deps, renderGain(project, metrics, deps.color));
  }
};
