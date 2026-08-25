import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoLabel } from "../git";
import {
  RUBRIC_RELPATH,
  rubricBody,
  rubricHash,
  VERDICT_RELPATH,
} from "../rubric";
import type { CmuxPort } from "./control";
import { parseVerdict } from "./verdict";
import type { Verdict } from "./verdict";
import { pickAgentWorkspaces, rowOf, withHandles } from "./view";
import type { FleetRow } from "./view";

// The stateless read surface: the fleet view derived live from cmux + the
// filesystem on every call. There is no state.json — the cmux feed/run-state
// and the per-worktree .captain/ files ARE the state, so nothing can desync
// and no daemon has to own a write lock.

// Thin fs edge: the agent-written verdict at <cwd>/.captain/verdict.json.
// Missing or unreadable → null (no verdict yet).
export const readVerdict = (cwd: string): Verdict | null => {
  try {
    return parseVerdict(readFileSync(join(cwd, VERDICT_RELPATH), "utf-8"));
  } catch {
    return null;
  }
};

// The ticket title `rubric.ts` writes into the rubric's issue-context block.
// Matched at LINE START (`m` flag), never with indexOf: the rubric embeds the
// issue *description* verbatim below this, so an unanchored match can return a
// line the issue's author wrote. Same lesson as `headingAt` in memory.ts.
const TITLE_LINE = /^- Title: (.+)$/mu;

// Thin fs edge: ONE read of the rubric, two facts derived from it.
//
//   hash  — what a legitimate verdict must cite, recomputed from the file as it
//           exists NOW, so editing the criteria after the fact breaks the match.
//           Undefined when no rubric was written: nothing to check against, so
//           the verdict's hash is accepted as-is.
//   title — the ticket's subject, so a row reads as more than `linkiq-tig-1229`.
//           Undefined for a free-form dispatch (no issue, no title line).
//
// Both undefined when the file is missing or unreadable. Kept as one function
// because two exported readers of the same file would drift and double the I/O
// on every status/gain call, once per worktree.
export const readRubricFacts = (
  cwd: string
): { hash?: string; title?: string } => {
  let text: string;
  try {
    text = readFileSync(join(cwd, RUBRIC_RELPATH), "utf-8");
  } catch {
    return {};
  }
  return {
    hash: rubricHash(rubricBody(text)),
    title: TITLE_LINE.exec(text)?.[1].trim() || undefined,
  };
};

// A captain-managed worktree is exactly one with a `.captain/` dir (fanout
// writes the rubric there) — a stateless membership marker that survives any
// restart and needs no adoption bookkeeping.
const isManaged = (cwd: string): boolean =>
  Boolean(cwd) && existsSync(join(cwd, ".captain"));

// The whole fleet, one row per captain-managed cmux workspace. Everything is
// gathered fresh: workspace list + feed + run states are one cmux call each,
// verdict/rubric are two small file reads per worktree.
export const fleetRows = (
  port: CmuxPort,
  env: NodeJS.ProcessEnv = process.env
): FleetRow[] => {
  const feed = port.feedList();
  const runs = port.runStates();
  // Build each row, then a second pass (withHandles) assigns the unambiguous
  // command handle now that the whole pool — and any cross-repo ticket
  // collision — is known.
  return withHandles(
    pickAgentWorkspaces(
      port.listWorkspaces().filter((w) => isManaged(w.cwd)),
      runs
    ).map((w) => {
      const rubric = readRubricFacts(w.cwd);
      return rowOf({
        cwd: w.cwd,
        expectedHash: rubric.hash,
        fallbackName: w.name,
        feed,
        repo: repoLabel(w.cwd, env),
        run: runs[w.id.toLowerCase()] ?? "unknown",
        title: rubric.title,
        verdict: readVerdict(w.cwd),
        workspaceId: w.id,
      });
    })
  );
};
