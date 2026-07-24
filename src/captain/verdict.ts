// 100% pure (lint-enforced: oxlint bans node:fs here) — the verdict/rubric
// FILE READERS live in surface.ts; callers feed this module plain data.

// The agent-side verifier's report, written to <worktree>/.captain/verdict.json
// per the finishing protocol. Captain only trusts pass/fail + hash; the
// criteria array is evidence for the human reviewing the gate.
export interface Verdict {
  issue: string;
  rubricHash: string;
  verdict: "pass" | "fail";
  criteria: {
    name: string;
    pass: boolean;
    evidence: string;
    // "cannot apply to this diff" (reason in `evidence`) — a third state, so an
    // inapplicable criterion has an honest answer instead of being argued into a
    // pass. Neither a pass nor a failure: gain never tallies it.
    na?: boolean;
  }[];
  summary: string;
  // the opened PR, when the agent includes it — wires the status merge hint
  prUrl?: string;
  ts: number;
}

const isCriterion = (c: unknown): boolean =>
  typeof c === "object" &&
  c !== null &&
  typeof (c as { name?: unknown }).name === "string" &&
  typeof (c as { pass?: unknown }).pass === "boolean" &&
  typeof (c as { evidence?: unknown }).evidence === "string" &&
  ((c as { na?: unknown }).na === undefined ||
    typeof (c as { na?: unknown }).na === "boolean");

// Agents write `ts` as a JSON string about as often as a number (the rubric's
// schema example modelled it as one for months, so most verdicts on disk carry
// `"1784854700"`). A quoted integer is unambiguous, so accept it rather than
// silently scoring it 0 — gain's launch→verdict latency drops every 0 sample.
const epochSeconds = (raw: unknown): number => {
  if (typeof raw === "number") {
    return raw;
  }
  const text = typeof raw === "string" ? raw.trim() : "";
  return /^\d+$/u.test(text) ? Number(text) : 0;
};

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
    ts: epochSeconds(v.ts),
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
