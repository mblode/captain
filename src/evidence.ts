import { readFileSync } from "node:fs";
import { join } from "node:path";

import { rowOf } from "./board";
import type { Evidence, Grade, Row } from "./board";
import type { CmuxPort, CmuxWorkspace } from "./captain/control";
import { parseVerdict, verdictCounts } from "./captain/verdict";
import { CliError, EXIT } from "./errors";
import { pendingGate, sameCwd } from "./gate";
import type { GithubPort } from "./github";
import type { Project } from "./project";
import {
  REVIEW_RELPATH,
  RUBRIC_RELPATH,
  rubricBody,
  rubricHash,
  VERDICT_RELPATH,
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

// The worker's verdict counts only if it cites the rubric as it exists NOW, so
// editing the criteria after the fact voids it.
export const readVerdict = (worktree: string): Grade | undefined => {
  const verdict = parseVerdict(readText(join(worktree, VERDICT_RELPATH)) ?? "");
  if (!verdict) {
    return undefined;
  }
  const rubric = readText(join(worktree, RUBRIC_RELPATH));
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

// The worker's workspace is named after the branch; the reviewer's after
// `<branch>:review`. Matching by cwd is the fallback for a workspace someone
// renamed.
const workerOf = (
  task: Task,
  workspaces: CmuxWorkspace[]
): CmuxWorkspace | undefined =>
  workspaces.find((w) => w.name === task.branch) ??
  workspaces.find(
    (w) =>
      Boolean(task.worktree) &&
      sameCwd(w.cwd, task.worktree) &&
      w.name !== reviewName(task.branch)
  );

export const evidenceFor = (
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
    const worker = workerOf(task, workspaces);
    const ev: Evidence = {
      reviewing: workspaces.some((w) => w.name === reviewName(task.branch)),
    };
    if (worker) {
      ev.workspace = {
        id: worker.id,
        run: runs[worker.id.toLowerCase()] ?? "unknown",
      };
    }
    if (task.worktree) {
      ev.gate = pendingGate(feed, task.worktree);
      ev.verdict = readVerdict(task.worktree);
      ev.review = parseReview(
        readText(join(task.worktree, REVIEW_RELPATH)) ?? ""
      );
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
