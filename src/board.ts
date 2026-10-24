// 100% PURE (lint-enforced: no fs/subprocess). The board: every task's live
// state, derived fresh from its file plus the evidence around it (cmux, git,
// GitHub, the verdict and review files). Nothing here is stored, so the board
// can't drift from reality, and a crashed chat loses nothing.

import type { RunState } from "./captain/control";
import type { Gate } from "./gate";
import type { Task } from "./task";

export type Group =
  | "needs-you"
  | "ready"
  | "captain"
  | "working"
  | "queued"
  | "blocked"
  | "merged"
  | "closed";

// Display order, most urgent first.
export const GROUPS: Group[] = [
  "needs-you",
  "ready",
  "captain",
  "working",
  "queued",
  "blocked",
  "merged",
  "closed",
];

export type Checks = "pass" | "fail" | "pending" | "none";

export interface PullRequest {
  url: string;
  state: "open" | "merged" | "closed";
  checks: Checks;
}

// A verdict or review file, reduced to what grouping needs.
export interface Grade {
  verdict: "pass" | "fail";
  summary: string;
}

// Everything the edge gathered about one task.
export interface Evidence {
  // is a worker workspace open for this task, and what is its agent doing
  workspace?: { id: string; run: RunState };
  gate?: Gate;
  pr?: PullRequest;
  // the worker's rubric verdict (hash-checked by the edge)
  verdict?: Grade;
  // the other vendor's review
  review?: Grade;
  // is a review workspace open right now
  reviewing?: boolean;
}

export interface Row {
  id: string;
  title: string;
  state: Task["state"];
  harness: Task["harness"];
  risk: Task["risk"];
  group: Group;
  // one line on why the task is in its group
  why: string;
  // the one command that moves it forward
  next: string;
  openBlockers: string[];
  workspaceId?: string;
  run?: RunState;
  gate?: Gate;
  pr?: PullRequest;
  verdict?: Grade;
  review?: Grade;
}

// A blocker is open unless it names a task in this project that is done or
// dropped. An id with no task behind it stays open: the chat either adds that
// task or edits the blocker away, rather than it silently unblocking.
export const openBlockers = (task: Task, all: Task[]): string[] =>
  task.blockedBy.filter((id) => {
    const blocker = all.find((t) => t.id === id);
    return (
      !blocker || (blocker.state !== "done" && blocker.state !== "dropped")
    );
  });

interface Decision {
  group: Group;
  why: string;
  next: string;
}

// Step 1 of the grouping rule: anything that stops on a person.
const waitingOnHuman = (id: string, ev: Evidence): Decision | undefined => {
  if (ev.gate?.kind === "plan") {
    return {
      group: "needs-you",
      next: `captain approve ${id} --note "..."`,
      why: "plan waiting for approval",
    };
  }
  if (ev.gate || ev.workspace?.run === "needs-input") {
    return {
      group: "needs-you",
      next: `captain send ${id} "<answer>"`,
      why: ev.gate?.hint ? `asks: ${ev.gate.hint}` : "agent waiting for input",
    };
  }
  if (ev.verdict?.verdict === "fail") {
    return {
      group: "needs-you",
      next: `captain send ${id} "<how to proceed>"`,
      why: `verifier failed: ${ev.verdict.summary}`,
    };
  }
  return undefined;
};

// Step 2: an open PR, walked through CI, the verdict and the review.
const openPrDecision = (
  id: string,
  pr: PullRequest,
  ev: Evidence
): Decision => {
  const peek = `captain peek ${id}`;
  if (pr.checks === "fail") {
    return {
      group: ev.workspace?.run === "running" ? "working" : "captain",
      next: `captain send ${id} "CI is red, fix it"`,
      why: "CI failing",
    };
  }
  if (pr.checks === "none") {
    return {
      group: "needs-you",
      next: `gh pr checks ${pr.url}`,
      why: "PR has no CI checks, and CI is part of done",
    };
  }
  if (pr.checks === "pending" || !ev.verdict) {
    return {
      group: "working",
      next: peek,
      why: ev.verdict ? "CI running" : "waiting for the verifier verdict",
    };
  }
  if (!ev.review) {
    return ev.reviewing
      ? { group: "working", next: peek, why: "under review" }
      : {
          group: "captain",
          next: `captain review ${id}`,
          why: "verified, needs the other vendor's review",
        };
  }
  if (ev.review.verdict === "fail") {
    return {
      group: "captain",
      next: `captain send ${id} "address the review in .captain/review.json"`,
      why: `review failed: ${ev.review.summary}`,
    };
  }
  return {
    group: "ready",
    next: `gh pr merge ${pr.url} --squash`,
    why: "CI green, verified, reviewed",
  };
};

// The grouping rule for a started task. The first match wins.
const activeRow = (id: string, ev: Evidence): Decision => {
  if (ev.pr?.state === "merged") {
    return { group: "merged", next: `captain done ${id}`, why: "PR merged" };
  }
  const human = waitingOnHuman(id, ev);
  if (human) {
    return human;
  }
  if (ev.pr?.state === "open") {
    return openPrDecision(id, ev.pr, ev);
  }
  if (!ev.workspace) {
    return {
      group: "captain",
      next: `captain start ${id}`,
      why: ev.pr
        ? "PR closed and no worker running"
        : "no worker running and no PR",
    };
  }
  return {
    group: "working",
    next: `captain peek ${id}`,
    why: ev.pr ? "PR closed without merge" : "no PR yet",
  };
};

export const rowOf = (task: Task, ev: Evidence, all: Task[]): Row => {
  const blockers = openBlockers(task, all);
  let decided: Decision;
  if (task.state === "done" || task.state === "dropped") {
    decided = { group: "closed", next: "", why: task.state };
  } else if (task.state === "active") {
    decided = activeRow(task.id, ev);
  } else if (blockers.length > 0) {
    decided = {
      group: "blocked",
      next: "",
      why: `blocked by ${blockers.join(", ")}`,
    };
  } else {
    decided = { group: "queued", next: `captain start ${task.id}`, why: "" };
  }
  return {
    ...decided,
    gate: ev.gate,
    harness: task.harness,
    id: task.id,
    openBlockers: blockers,
    pr: ev.pr,
    review: ev.review,
    risk: task.risk,
    run: ev.workspace?.run,
    state: task.state,
    title: task.title,
    verdict: ev.verdict,
    workspaceId: ev.workspace?.id,
  };
};

// Work in progress is every started task that isn't merged yet: each one is a
// PR you will have to review. `captain start` refuses past the limit, because
// review is the ceiling, not generation.
export const inProgress = (rows: Row[]): number =>
  rows.filter((r) => r.state === "active" && r.group !== "merged").length;

export const groupCounts = (rows: Row[]): Record<Group, number> =>
  Object.fromEntries(
    GROUPS.map((g) => [g, rows.filter((r) => r.group === g).length])
  ) as Record<Group, number>;

export const sortRows = (rows: Row[]): Row[] =>
  rows.toSorted(
    (a, b) =>
      GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) ||
      a.id.localeCompare(b.id)
  );
