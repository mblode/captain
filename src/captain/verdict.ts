import type { Stage, Transition, Verdict, Worktree } from "./types";

// 100% pure (lint-enforced: oxlint bans node:fs here) — the verdict/rubric
// FILE READERS live in sweeps.ts, the watcher feeds this module plain data.

// The verdict only matters once a PR exists: PR_OPEN (just created) and
// BABYSITTING (being kept green). Earlier stages can't be "done"; the human
// gates idle by design.
export const VERDICT_STAGES = new Set<Stage>(["PR_OPEN", "BABYSITTING"]);

const isCriterion = (c: unknown): boolean =>
  typeof c === "object" &&
  c !== null &&
  typeof (c as { name?: unknown }).name === "string" &&
  typeof (c as { pass?: unknown }).pass === "boolean";

// Pure: validate the agent-written verdict file's shape. Anything malformed is
// null — a garbage verdict must read as "no verdict yet", never as a pass.
export const parseVerdict = (text: string): Verdict | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const v = raw as Partial<Verdict>;
  if (
    (v.verdict !== "pass" && v.verdict !== "fail") ||
    typeof v.rubricHash !== "string" ||
    typeof v.summary !== "string" ||
    !Array.isArray(v.criteria) ||
    !v.criteria.every(isCriterion)
  ) {
    return null;
  }
  return {
    criteria: v.criteria,
    issue: typeof v.issue === "string" ? v.issue : "",
    prUrl: typeof v.prUrl === "string" ? v.prUrl : undefined,
    rubricHash: v.rubricHash,
    summary: v.summary,
    ts: typeof v.ts === "number" ? v.ts : 0,
    verdict: v.verdict,
  };
};

// Pure: should this verdict move the worktree, and where? The sibling of
// checkHalt — the watcher feeds it data and executes the returned Transition.
//   pass (hash ok)  → READY_TO_MERGE, parked on the pr-ready human gate
//   fail            → BLOCKED, needs-input, with the verifier's summary
//   null / wrong hash / wrong stage / already gated → null (no change)
// A hash mismatch means the rubric was edited after the verdict (or the verdict
// cites a stale/foreign rubric) — ignore it rather than trust it.
export const checkVerdict = (
  wt: Worktree,
  verdict: Verdict | null,
  expectedHash?: string
): Transition | null => {
  if (!(verdict && VERDICT_STAGES.has(wt.stage)) || wt.gate) {
    return null;
  }
  if (expectedHash !== undefined && verdict.rubricHash !== expectedHash) {
    return null;
  }
  if (verdict.verdict === "pass") {
    return {
      gate: "pr-ready",
      nextStage: "READY_TO_MERGE",
      notify: `verified PR-ready: ${verdict.summary}`,
    };
  }
  return {
    gate: "needs-input",
    nextStage: "BLOCKED",
    notify: `verifier failed: ${verdict.summary}`,
  };
};
