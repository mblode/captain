import { feedList, replyExitPlan } from "./control.js";
import { fmtAge, renderStatus, style, useColor } from "./format.js";
import type { Style } from "./format.js";
import { onPlanApproved } from "./pipeline.js";
import { loadState, saveState } from "./state.js";
import type { FleetState, Worktree } from "./types.js";

const now = (): number => Math.floor(Date.now() / 1000);

const styleFor = (out: NodeJS.WritableStream): Style => style(useColor(out));

// A short, friendly handle for command examples (the ticket part of the name).
const shortName = (wt: Worktree): string => {
  const m = wt.name.match(/([a-z]+-\d+)/iu);
  return m ? m[1] : wt.name;
};

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

export const status = (
  fleetId: string,
  json: boolean,
  out: NodeJS.WritableStream
): void => {
  const rows = Object.values(loadState(fleetId).worktrees);
  if (json) {
    out.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  out.write(renderStatus(fleetId, rows, styleFor(out)));
};

// Pending decisions, batched, each with the exact command to resolve it.
export const gates = (
  fleetId: string,
  json: boolean,
  out: NodeJS.WritableStream
): void => {
  const state = loadState(fleetId);
  const rows = Object.values(state.worktrees).filter(
    (w) => w.stage === "PLAN_READY" || w.stage === "BLOCKED"
  );
  if (json) {
    out.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const s = styleFor(out);
  if (rows.length === 0) {
    out.write(`${s.green("✓")} nothing needs you — the fleet is flowing.\n`);
    return;
  }
  out.write(`${s.bold(`${rows.length} pending`)} — ${fleetId}\n\n`);
  for (const wt of rows) {
    const head =
      wt.stage === "PLAN_READY"
        ? s.yellow(`◆ ${wt.name}  plan ready`)
        : s.yellow(`● ${wt.name}  blocked · ${wt.gate ?? "?"}`);
    out.write(`${head}  ${s.dim(fmtAge(wt.since))}\n`);
    if (wt.note) {
      out.write(`    ${s.dim(wt.note)}\n`);
    }
    if (wt.stage === "PLAN_READY") {
      out.write(
        `    ${s.dim("read:")}    cmux read-screen --workspace ${wt.name} --scrollback\n`
      );
      out.write(
        `    ${s.dim("approve:")} captain approve --fleet ${fleetId} --plans ${shortName(wt)}\n`
      );
      out.write(
        `    ${s.dim("reject:")}  captain reject --fleet ${fleetId} --ref ${shortName(wt)} --note "…"\n`
      );
    } else {
      out.write(
        `    ${s.dim("answer:")}  cmux send --workspace ${wt.name} "<reply>\\n"  (or focus the workspace)\n`
      );
    }
    out.write("\n");
  }
};

// Worktrees parked at the PR-ready stop point, with a copy-paste merge hint.
export const ready = (fleetId: string, out: NodeJS.WritableStream): void => {
  const s = styleFor(out);
  const rows = Object.values(loadState(fleetId).worktrees).filter(
    (w) => w.stage === "READY_TO_MERGE" || w.stage === "BABYSITTING"
  );
  if (rows.length === 0) {
    out.write(s.dim("nothing ready to merge yet.\n"));
    return;
  }
  out.write(`${s.bold(`${rows.length} ready`)} — ${fleetId}\n\n`);
  for (const wt of rows) {
    out.write(`${s.green("✓")} ${s.bold(wt.name)}\n`);
    out.write(
      `    ${wt.prUrl ? s.dim(wt.prUrl) : s.dim("(PR url pending)")}\n`
    );
    if (wt.prUrl) {
      out.write(`    ${s.dim("merge:")} gh pr merge ${wt.prUrl} --squash\n`);
    }
    out.write("\n");
  }
};

// Approve plan(s): reply to the cmux exit-plan feed item, then mark IMPLEMENTING
// so the next Stop auto-advances. `spec` = "all" or ticket names / ids.
export const approve = (
  fleetId: string,
  spec: string,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WritableStream
): void => {
  const s = styleFor(out);
  const state = loadState(fleetId);
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
    out.write(`${s.green("✓")} approved ${s.bold(wt.name)} → implementing\n`);
  }
  saveState(state);
};

// Reject a plan: reply with revision feedback and send the worktree back to PLANNING.
export const reject = (
  fleetId: string,
  ref: string,
  note: string,
  env: NodeJS.ProcessEnv,
  out: NodeJS.WritableStream
): void => {
  const s = styleFor(out);
  const state = loadState(fleetId);
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
  saveState(state);
  out.write(`${s.yellow("↩")} ${s.bold(wt.name)} back to planning: ${note}\n`);
};
