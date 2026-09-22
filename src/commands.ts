import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { inProgress, openBlockers, sortRows } from "./board";
import type { Row } from "./board";
import { appendLog, now, readLog } from "./captain/log";
import { explainCmuxUnreachable, harnessCommand, openWorkspace } from "./cmux";
import {
  loadAgentEnv,
  loadDataScope,
  loadHarnessDefaults,
  loadSkills,
} from "./config";
import { CliError, EXIT } from "./errors";
import { boardRows, reviewName } from "./evidence";
import type { Ports } from "./evidence";
import { renderBoard, renderGain, renderTaskLine } from "./format";
import { ensureWorktree, gitCommonDir } from "./git";
import { openBlockers as issueBlockers, slugify } from "./issue";
import { readMemoryExcerpt } from "./memory";
import {
  commit,
  findTask,
  initProject,
  learningsPath,
  listTasks,
  logDir,
  resolveProject,
  taskExists,
  writeTask,
} from "./project";
import type { Project } from "./project";
import { renderPrompt, renderPromptExtras, renderReviewPrompt } from "./prompt";
import {
  BRIEF_RELPATH,
  renderRubric,
  REVIEW_RELPATH,
  RUBRIC_RELPATH,
} from "./rubric";
import { sourceFor } from "./source";
import { computeGain } from "./stats";
import {
  criteriaOf,
  HARNESSES,
  nextMessageId,
  otherVendor,
  parseList,
  RISKS,
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
// with a stop the agent can't pass on its own.
const harnessFor = (risk: Risk, chosen: Harness | undefined): Harness =>
  risk === "escalate" ? "claude" : (chosen ?? "codex");

export const init = (
  options: Common & {
    name: string;
    repo: string;
    wip?: number;
    bootstrap?: string;
  },
  deps: Deps
): void => {
  const project = initProject(deps.env, options);
  if (options.json) {
    json(deps, {
      dir: project.dir,
      name: project.name,
      repo: project.repo,
      wip: project.wip,
    });
    return;
  }
  out(
    deps,
    `created ${project.dir}\n  repo ${project.repo}\n  wip  ${project.wip}`
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

const briefFor = (
  project: Project,
  task: Task,
  env: NodeJS.ProcessEnv
): string => {
  const memoryPath = learningsPath(project);
  return (
    renderPrompt(task) +
    renderPromptExtras({
      dataScope: loadDataScope(env),
      gated: task.risk === "escalate",
      harness: task.harness,
      memory: readMemoryExcerpt(memoryPath),
      memoryPath,
      rubricPath: RUBRIC_RELPATH,
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

// Start one task: a worktree off the project repo, its rubric and brief, and a
// full harness in its own cmux workspace. Refuses a blocked task and refuses
// past the WIP limit (unless --force), because every started task is a PR you
// will have to review.
const startOne = async (
  project: Project,
  id: string,
  options: StartOptions,
  deps: Deps,
  rows: Row[]
): Promise<Task & { command: string }> => {
  let task = findTask(project, id);
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

  const { risk } = task;
  const harness = harnessFor(risk, asHarness(options.harness) ?? task.harness);
  const defaults = loadHarnessDefaults(harness, deps.env);
  task = {
    ...task,
    effort: options.effort ?? (task.effort || defaults.effort),
    harness,
    model: options.model ?? (task.model || defaults.model),
  };

  const brief = briefFor(project, task, deps.env);
  if (options.print) {
    return { ...task, command: brief };
  }
  requireCmux(deps.env);

  const worktree = await ensureWorktree({
    env: deps.env,
    issueId: task.id,
    repoRoot: project.repo,
    slug: slugify(task.title),
  });
  await mkdir(join(worktree.worktreePath, ".captain"), { recursive: true });
  await writeFile(
    join(worktree.worktreePath, RUBRIC_RELPATH),
    renderRubric(
      issueOf(task),
      task.id.toUpperCase(),
      loadDataScope(deps.env),
      "Captain"
    ).text
  );
  const promptPath = join(worktree.worktreePath, BRIEF_RELPATH);
  await writeFile(promptPath, brief);
  await excludeCaptainDir(project.repo, deps.env);

  const slot = String(inProgress(rows));
  const command = harnessCommand({
    bootstrap: project.bootstrap,
    effort: task.effort,
    env: { ...loadAgentEnv(deps.env), CAPTAIN_SLOT: slot },
    gated: risk === "escalate",
    harness,
    model: task.model,
    name: worktree.branch,
    promptPath,
  });
  openWorkspace({
    command,
    cwd: worktree.worktreePath,
    env: deps.env,
    name: worktree.branch,
  });

  task = {
    ...task,
    branch: worktree.branch,
    state: "active",
    worktree: worktree.worktreePath,
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

export const start = async (
  ids: string[],
  options: StartOptions,
  deps: Deps
): Promise<void> => {
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
  if (options.json) {
    json(deps, { started });
    return;
  }
  for (const t of started) {
    out(
      deps,
      options.print
        ? t.command
        : `started ${t.id} on ${t.harness}${t.model && t.model !== "default" ? ` (${t.model})` : ""} in ${t.worktree}`
    );
  }
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

const planGate = (row: Row): string => {
  if (row.gate?.kind !== "plan") {
    throw new CliError(
      `task ${row.id} has no plan waiting for approval`,
      EXIT.USAGE,
      "NO_PLAN_GATE"
    );
  }
  return row.gate.replyId ?? "";
};

export const approve = (
  id: string,
  options: Common & { note?: string },
  deps: Deps
): void => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  deps.ports().cmux.replyExitPlan(planGate(row), true);
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
  const { cmux } = deps.ports();
  cmux.replyExitPlan(planGate(row), false);
  // Denying the plan returns the agent to planning; the feedback is what it
  // re-plans against.
  cmux.send(workerOf(row), options.note);
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
  options: Common & { harness?: string; model?: string },
  deps: Deps
): Promise<void> => {
  const project = resolveProject(deps.env, options.project);
  const row = rowFor(project, id, deps);
  const task = findTask(project, id);
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
      effort: defaults.effort,
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
      `${state} ${task.id}${task.worktree ? `\n  remove the worktree when you're finished: git worktree remove ${task.worktree}` : ""}`
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
