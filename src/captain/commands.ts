import { feedList, replyExitPlan } from "./control";
import { watcherHealth } from "./daemon";
import { renderMetrics, renderStatus, style, useColor } from "./format";
import type { Style } from "./format";
import { appendHistory, readHistory } from "./history";
import { computeMetrics } from "./metrics";
import { onPlanApproved } from "./pipeline";
import { DEFAULT_FLEET, loadState, now, saveState } from "./state";
import type { FleetState, Worktree } from "./types";

const styleFor = (out: NodeJS.WritableStream): Style => style(useColor(out));

// Resolve a user-friendly target spec to worktrees. Accepts "all", or a
// comma-separated list of ticket names ("tig-430"), substrings, or workspace ids
// — so nobody has to paste a uuid.
export const resolveTargets = (
  state: FleetState,
  spec: string,
  stage: Worktree["stage"]
): { matched: Worktree[]; unknown: string[] } => {
  const pool = Object.values(state.worktrees).filter((w) => w.stage === stage);
  if (spec === "all") {
    return { matched: pool, unknown: [] };
  }
  const matched: Worktree[] = [];
  const unknown: string[] = [];
  for (const raw of spec.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) {
      continue;
    }
    const hit = pool.find(
      (w) =>
        w.workspaceId.toLowerCase() === token ||
        w.name.toLowerCase() === token ||
        w.name.toLowerCase().includes(token)
    );
    if (hit && !matched.includes(hit)) {
      matched.push(hit);
    } else if (!hit) {
      unknown.push(raw.trim());
    }
  }
  return { matched, unknown };
};

// The one read surface: a watcher-health header, then worktrees grouped with the
// few that need a decision on top — each carrying its inline resolve command.
export const status = (json: boolean, out: NodeJS.WritableStream): void => {
  const rows = Object.values(loadState(DEFAULT_FLEET).worktrees);
  if (json) {
    out.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  out.write(renderStatus(rows, styleFor(out), watcherHealth(DEFAULT_FLEET)));
};

// The measurement view: velocity, autonomy, intervention rate, and per-stage
// timings — derived purely from the audit log + live state.
export const metrics = (json: boolean, out: NodeJS.WritableStream): void => {
  const state = loadState(DEFAULT_FLEET);
  const m = computeMetrics(
    readHistory(DEFAULT_FLEET),
    Object.values(state.worktrees),
    now()
  );
  if (json) {
    out.write(`${JSON.stringify(m, null, 2)}\n`);
    return;
  }
  out.write(renderMetrics(m, styleFor(out)));
};

// Approve plan(s): reply to the cmux exit-plan feed item, then mark IMPLEMENTING
// so the next Stop auto-advances. `spec` = "all" or ticket names / ids.
export const approve = (
  spec: string,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WritableStream
): void => {
  const s = styleFor(out);
  const state = loadState(DEFAULT_FLEET);
  const { matched, unknown } = resolveTargets(state, spec, "PLAN_READY");
  for (const u of unknown) {
    out.write(s.yellow(`  no PLAN_READY worktree matches "${u}"\n`));
  }
  if (matched.length === 0) {
    out.write(s.dim("nothing to approve.\n"));
    return;
  }
  const feed = feedList(env);
  for (const wt of matched) {
    const item = feed.find((f) => f.cwd === wt.cwd);
    if (item) {
      replyExitPlan(item.id, true, env);
    }
    wt.stage = onPlanApproved();
    wt.gate = undefined;
    wt.note = undefined;
    wt.since = now();
    appendHistory(DEFAULT_FLEET, {
      event: "approve",
      from: "PLAN_READY",
      kind: "approve",
      name: wt.name,
      seq: 0,
      to: wt.stage,
      ts: now(),
      workspaceId: wt.workspaceId,
    });
    out.write(`${s.green("✓")} approved ${s.bold(wt.name)} → implementing\n`);
  }
  saveState(state);
};

// Reject a plan: reply with revision feedback and send the worktree back to PLANNING.
export const reject = (
  ref: string,
  note: string,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WritableStream
): void => {
  const s = styleFor(out);
  const state = loadState(DEFAULT_FLEET);
  const { matched } = resolveTargets(state, ref, "PLAN_READY");
  const [wt] = matched;
  if (!wt) {
    out.write(s.yellow(`no PLAN_READY worktree matches "${ref}"\n`));
    return;
  }
  const item = feedList(env).find((f) => f.cwd === wt.cwd);
  if (item) {
    replyExitPlan(item.id, false, env);
  }
  wt.stage = "PLANNING";
  wt.gate = undefined;
  wt.note = note;
  wt.since = now();
  appendHistory(DEFAULT_FLEET, {
    event: "reject",
    from: "PLAN_READY",
    kind: "reject",
    name: wt.name,
    seq: 0,
    to: "PLANNING",
    ts: now(),
    workspaceId: wt.workspaceId,
  });
  saveState(state);
  out.write(`${s.yellow("↩")} ${s.bold(wt.name)} back to planning: ${note}\n`);
};
