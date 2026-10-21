// 100% pure (lint-enforced: oxlint bans node:fs here) — the smoke.json READER
// lives in surface.ts; callers feed this module plain data.

import { epochSeconds } from "./verdict";

// The worker's production check after the merge, written to the change's
// `smoke.json` per the brief. `running` from the moment the merge lands, then
// `pass` or `fail` once the checks ran. Captain trusts only `status`; the
// checks are evidence for the human.
export interface Smoke {
  status: "running" | "pass" | "fail";
  checks: {
    name: string;
    pass: boolean;
    evidence: string;
    kind?: string;
    // invented by the worker because tasks.md had no `## Smoke test`
    derived?: boolean;
  }[];
  mergeSha?: string;
  summary: string;
  ts: number;
}

const STATUSES = new Set(["running", "pass", "fail"]);

const isCheck = (c: unknown): boolean =>
  typeof c === "object" &&
  c !== null &&
  typeof (c as { name?: unknown }).name === "string" &&
  typeof (c as { pass?: unknown }).pass === "boolean" &&
  typeof (c as { evidence?: unknown }).evidence === "string";

// Pure: validate the worker-written smoke file. Anything malformed is null, so
// a garbage file reads as "no smoke result yet", never as a pass. A `pass`
// that has no checks, or any failing one, is read as a `fail`: the claim and
// its own evidence disagree, and that needs a human.
export const parseSmoke = (text: string): Smoke | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const s = raw as Partial<Smoke>;
  if (
    !STATUSES.has(s.status as string) ||
    !Array.isArray(s.checks) ||
    !s.checks.every(isCheck)
  ) {
    return null;
  }
  const unbacked =
    s.status === "pass" &&
    (s.checks.length === 0 || s.checks.some((c) => !c.pass));
  return {
    checks: s.checks,
    mergeSha: typeof s.mergeSha === "string" ? s.mergeSha : undefined,
    status: unbacked ? "fail" : (s.status as Smoke["status"]),
    summary: typeof s.summary === "string" ? s.summary : "",
    ts: epochSeconds(s.ts),
  };
};
