// 100% pure (lint-enforced: oxlint bans node:fs here) — the verdict/rubric
// FILE READERS live in surface.ts; callers feed this module plain data.

// The agent-side verifier's report, written to <worktree>/.captain/verdict.json
// per the finishing protocol. Captain only trusts pass/fail + hash; the
// criteria array is evidence for the human reviewing the gate.
export interface Verdict {
  issue: string;
  rubricHash: string;
  verdict: "pass" | "fail";
  criteria: { name: string; pass: boolean; evidence: string }[];
  summary: string;
  // the opened PR, when the agent includes it — wires the status merge hint
  prUrl?: string;
  ts: number;
}

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

// Pure: does this verdict count? A hash mismatch means the rubric was edited
// after the verdict (or the verdict cites a stale/foreign rubric) — ignore it
// rather than trust it. No expected hash (no rubric on disk) accepts as-is.
export const verdictCounts = (
  verdict: Verdict,
  expectedHash: string | undefined
): boolean => expectedHash === undefined || verdict.rubricHash === expectedHash;
