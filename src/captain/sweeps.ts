import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RUBRIC_RELPATH,
  rubricBody,
  rubricHash,
  VERDICT_RELPATH,
} from "../rubric";
import { commit } from "./commit";
import type { WatchOptions } from "./commit";
import { checkHalt } from "./pipeline";
import { now } from "./state";
import type { FleetState, Verdict, Worktree } from "./types";
import { checkVerdict, parseVerdict, VERDICT_STAGES } from "./verdict";

// The verdict FILE READERS live here (not in verdict.ts) so verdict.ts stays
// 100% pure — its no-I/O contract is lint-enforced (oxlint.config.ts bans
// node:fs imports there).

// Thin fs edge: the agent-written verdict at <cwd>/.captain/verdict.json.
// Missing or unreadable → null (no verdict yet).
export const readVerdict = (cwd: string): Verdict | null => {
  try {
    return parseVerdict(readFileSync(join(cwd, VERDICT_RELPATH), "utf-8"));
  } catch {
    return null;
  }
};

// Thin fs edge: recompute the hash a legitimate verdict must cite, from the
// rubric file as it exists NOW — so editing the criteria after the fact breaks
// the match. Undefined when no rubric was written (an adopted worktree): there
// is nothing to check against, so the verdict's hash is accepted as-is.
export const expectedRubricHash = (cwd: string): string | undefined => {
  try {
    return rubricHash(
      rubricBody(readFileSync(join(cwd, RUBRIC_RELPATH), "utf-8"))
    );
  } catch {
    return undefined;
  }
};

// Surface an agent-written verdict: a verified pass parks the pr-ready gate
// (wiring READY_TO_MERGE), a fail escalates to BLOCKED with the verifier's
// summary. checkVerdict is pure and idempotent (null once a gate is set), so
// calling this from both the Stop path and the reconcile sweep never
// double-fires. Returns true when the verdict moved the worktree — the caller
// skips the normal advance for that event.
export const applyVerdict = (
  state: FleetState,
  wt: Worktree,
  opts: WatchOptions,
  seq = 0
): boolean => {
  if (!VERDICT_STAGES.has(wt.stage) || wt.gate) {
    return false;
  }
  const verdict = readVerdict(wt.cwd);
  const result = verdict
    ? checkVerdict(wt, verdict, expectedRubricHash(wt.cwd))
    : null;
  if (!(verdict && result)) {
    return false;
  }
  commit(
    state,
    wt,
    result,
    {
      event: "verdict",
      kind: "verdict",
      log: `${verdict.verdict === "pass" ? "✓" : "⚑"} ${wt.name}: ${result.notify}`,
      notice:
        verdict.verdict === "pass"
          ? { body: `${wt.name}: ${verdict.summary}`, kind: "pr-ready" }
          : { body: `${wt.name}: ${result.notify}`, kind: "needs-you" },
      seq,
      set: {
        note: verdict.summary,
        prUrl: verdict.prUrl ?? wt.prUrl,
        verdict: verdict.verdict,
      },
    },
    opts
  );
  return true;
};

// Reconcile-tick sweep: a verdict written after the final Stop (or under a
// manually-driven agent that emits no events) still surfaces within one tick.
export const sweepVerdicts = (state: FleetState, opts: WatchOptions): void => {
  for (const wt of Object.values(state.worktrees)) {
    if (wt.workspaceId === state.captainWorkspaceId) {
      continue;
    }
    applyVerdict(state, wt, opts);
  }
};

// Sweep every live worktree for a hung loop (a silently-stalled agent emits no
// events, so handleEvent never fires for it). Routes a stall into the same human
// BLOCKED gate path as any other escalation. Once a worktree is BLOCKED it's no
// longer HALTABLE, so checkHalt returns null next sweep — no double-notify.
export const sweepHalts = (
  state: FleetState,
  opts: WatchOptions,
  stallSecs: number
): void => {
  for (const wt of Object.values(state.worktrees)) {
    if (wt.workspaceId === state.captainWorkspaceId) {
      continue;
    }
    const result = checkHalt(wt, now(), stallSecs);
    if (!result) {
      continue;
    }
    // result.notify is the bare reason; the status row already shows the name,
    // so keep the note clean and only prefix the name for the (context-free)
    // toast.
    commit(
      state,
      wt,
      result,
      {
        event: "halt",
        kind: "gate",
        log: `⚑ ${result.notify}`,
        notice: { body: `${wt.name}: ${result.notify}`, kind: "needs-you" },
        set: { note: result.notify },
      },
      opts
    );
  }
};
