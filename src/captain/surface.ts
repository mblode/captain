import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RUBRIC_RELPATH,
  rubricBody,
  rubricHash,
  VERDICT_RELPATH,
} from "../rubric";
import { repoLabel } from "./control";
import type { CmuxPort } from "./control";
import { parseVerdict } from "./verdict";
import type { Verdict } from "./verdict";
import { rowOf } from "./view";
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

// Thin fs edge: recompute the hash a legitimate verdict must cite, from the
// rubric file as it exists NOW — so editing the criteria after the fact breaks
// the match. Undefined when no rubric was written: nothing to check against,
// so the verdict's hash is accepted as-is.
export const expectedRubricHash = (cwd: string): string | undefined => {
  try {
    return rubricHash(
      rubricBody(readFileSync(join(cwd, RUBRIC_RELPATH), "utf-8"))
    );
  } catch {
    return undefined;
  }
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
  return port
    .listWorkspaces()
    .filter((w) => isManaged(w.cwd))
    .map((w) =>
      rowOf({
        cwd: w.cwd,
        expectedHash: expectedRubricHash(w.cwd),
        fallbackName: w.name,
        feed,
        repo: repoLabel(w.cwd, env),
        run: runs[w.id.toLowerCase()] ?? "unknown",
        verdict: readVerdict(w.cwd),
        workspaceId: w.id,
      })
    );
};
