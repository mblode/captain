import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rowOf } from "./board";
import type { Evidence, Grade, Row } from "./board";
import type { CmuxPort, CmuxWorkspace } from "./captain/control";
import { parseSmoke } from "./captain/smoke";
import { parseVerdict, verdictCounts } from "./captain/verdict";
import { CliError, EXIT } from "./errors";
import { pendingGate, sameCwd, screenGate } from "./gate";
import type { GithubPort } from "./github";
import { slugify } from "./issue";
import type { Project } from "./project";
import {
  REVIEW_RELPATH,
  rubricBody,
  rubricHash,
  sharedStateDir,
  statePaths,
} from "./rubric";
import type { Task } from "./task";

// The fs + cmux + GitHub edge of the board: gather each task's evidence, then
// hand it to the pure grouping rule in board.ts. Every read fails soft, so one
// unreadable worktree degrades its own row and never the whole board.

export interface Ports {
  cmux: CmuxPort;
  github: GithubPort;
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

// A task runs in the shared checkout when its "worktree" is the project repo
// itself; its captain files then live under its own state dir.
export const isShared = (project: Project, task: Task): boolean =>
  Boolean(task.worktree) && task.worktree === project.repo;

export const pathsOf = (
  project: Project,
  task: Task
): ReturnType<typeof statePaths> =>
  statePaths(
    isShared(project, task) ? { stateDir: sharedStateDir(task.id) } : undefined
  );

// The worker's cmux workspace name, as v2 named it: the branch in a worktree.
// In the shared checkout every worker is on one branch, so the name comes from
// the task: `<ticket>-<title slug>`, the title slug alone for a chat message
// (`t-<n>` says nothing), and the change id for an OpenSpec change (already a
// slug).
export const workerName = (project: Project, task: Task): string => {
  if (!isShared(project, task)) {
    return task.branch;
  }
  const slug = slugify(task.title);
  if (!slug || task.source.startsWith("openspec:")) {
    return task.id;
  }
  return /^t-\d+$/u.test(task.id) ? slug : `${task.id}-${slug}`;
};

// The worker's verdict counts only if it cites the rubric as it exists NOW, so
// editing the criteria after the fact voids it.
export const readVerdict = (
  checkout: string,
  paths = statePaths()
): Grade | undefined => {
  const verdict = parseVerdict(readText(join(checkout, paths.verdict)) ?? "");
  if (!verdict) {
    return undefined;
  }
  const rubric = readText(join(checkout, paths.rubric));
  const expected = rubric ? rubricHash(rubricBody(rubric)) : undefined;
  return verdictCounts(verdict, expected)
    ? { summary: verdict.summary, verdict: verdict.verdict }
    : undefined;
};

// Pure: the reviewer's file. Anything malformed reads as "no review yet",
// never as a pass.
export const parseReview = (text: string): Grade | undefined => {
  try {
    const raw = JSON.parse(text) as { verdict?: unknown; summary?: unknown };
    if (raw.verdict !== "pass" && raw.verdict !== "fail") {
      return undefined;
    }
    return {
      summary: typeof raw.summary === "string" ? raw.summary : "",
      verdict: raw.verdict,
    };
  } catch {
    return undefined;
  }
};

export const reviewName = (branch: string): string => `${branch}:review`;

// The worker's workspace is named after the branch (the task id when
// shared); the reviewer's after `<branch>:review`. Matching by cwd is the
// fallback for a renamed worktree workspace, never for a shared one: every
// shared worker has the same cwd.
const workerOf = (
  project: Project,
  task: Task,
  workspaces: CmuxWorkspace[]
): CmuxWorkspace | undefined =>
  workspaces.find((w) => w.name === workerName(project, task)) ??
  (isShared(project, task)
    ? undefined
    : workspaces.find(
        (w) =>
          Boolean(task.worktree) &&
          sameCwd(w.cwd, task.worktree) &&
          w.name !== reviewName(task.branch)
      ));

const evidenceFor = (
  project: Project,
  tasks: Task[],
  ports: Ports
): Map<string, Evidence> => {
  const active = tasks.filter((t) => t.state === "active");
  const out = new Map<string, Evidence>();
  if (active.length === 0) {
    return out;
  }
  // A dead cmux returns empty lists, which would read as "every worker is
  // gone". Fail loudly instead of reporting a fleet that isn't real.
  if (!ports.cmux.reachable()) {
    throw new CliError(
      "cmux is not reachable, so the board can't see the workers. Start the cmux app, or run `captain install` to diagnose",
      EXIT.CMUX_UNREACHABLE,
      "CMUX_UNREACHABLE"
    );
  }
  const workspaces = ports.cmux.listWorkspaces();
  const runs = ports.cmux.runStates();
  const feed = ports.cmux.feedList();
  for (const task of active) {
    const worker = workerOf(project, task, workspaces);
    const ev: Evidence = {
      reviewing: workspaces.some((w) => w.name === reviewName(task.branch)),
    };
    if (worker) {
      ev.workspace = {
        id: worker.id,
        run: runs[worker.id.toLowerCase()] ?? "unknown",
      };
    }
    const paths = pathsOf(project, task);
    if (isShared(project, task)) {
      const smoke = parseSmoke(
        readText(join(task.worktree, paths.smoke)) ?? ""
      );
      ev.shared = {
        branch: task.branch,
        smoke: smoke ?? undefined,
      };
      ev.reviewing = false;
      const session = readText(join(task.worktree, paths.session))?.trim();
      // A shared worker without a session id (codex, cursor) has no feed gate
      // captain can tell apart from its neighbours', so none is read.
      ev.gate = session ? pendingGate(feed, task.worktree, session) : undefined;
      ev.verdict = readVerdict(task.worktree, paths);
    } else if (task.worktree) {
      ev.gate = pendingGate(feed, task.worktree);
      ev.verdict = readVerdict(task.worktree);
      ev.review = parseReview(
        readText(join(task.worktree, REVIEW_RELPATH)) ?? ""
      );
    }
    // The feed forgets a gate about two minutes after it lands, so a worker
    // the feed shows nothing for gets its screen read for a menu instead.
    if (worker && !ev.gate) {
      ev.gate = screenGate(ports.cmux.readScreen(worker.id));
    }
    if (task.branch) {
      ev.pr = ports.github.pr(project.repo, task.branch);
    }
    out.set(task.id, ev);
  }
  return out;
};

export const boardRows = (
  project: Project,
  tasks: Task[],
  ports: Ports
): Row[] => {
  const evidence = evidenceFor(project, tasks, ports);
  return tasks.map((t) => rowOf(t, evidence.get(t.id) ?? {}, tasks));
};
