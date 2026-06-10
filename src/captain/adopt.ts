import { basename } from "node:path";

import { record } from "./commit";
import type { CmuxWorkspace } from "./control";
import { now } from "./state";
import type { FleetState, HookEvent, Worktree } from "./types";

const agentOf = (name: string): Worktree["agent"] => {
  if (/codex/iu.test(name)) {
    return "codex";
  }
  if (/claude|cc\b/iu.test(name)) {
    return "claude";
  }
  return "unknown";
};

// Adopt current cmux workspaces into the fleet (excluding the captain itself),
// and drop tracked worktrees whose workspace has vanished.
export const reconcile = (
  state: FleetState,
  workspaces: CmuxWorkspace[],
  match?: string
): void => {
  // A failed or empty `workspace.list` (the cmux RPC is unreliable from a
  // detached daemon) must NOT wipe the tracked fleet — treat it as "no data this
  // tick" and leave existing worktrees intact. The event stream re-adopts anyway.
  if (workspaces.length === 0) {
    return;
  }
  const selfId = state.captainWorkspaceId;
  const live = new Set<string>();
  for (const w of workspaces) {
    if (w.id === selfId || (match && !w.cwd.includes(match))) {
      continue;
    }
    live.add(w.id);
    const existing = state.worktrees[w.id];
    if (existing) {
      existing.cwd = w.cwd;
      existing.name = w.name;
    } else {
      state.worktrees[w.id] = {
        agent: agentOf(w.name),
        cwd: w.cwd,
        lastSeen: now(),
        name: w.name,
        since: now(),
        stage: "ADOPTED",
        workspaceId: w.id,
      };
      record(w.id, w.name, {
        event: "adopt",
        from: "ADOPTED",
        kind: "adopt",
        to: "ADOPTED",
      });
    }
  }
  state.worktrees = Object.fromEntries(
    Object.entries(state.worktrees).filter(([id]) => live.has(id))
  );
};

// Adopt an untracked worktree straight from the live event stream. The cmux RPC
// view is unreliable, so the agent.hook frames (which carry cwd + workspace_id)
// are the real source of truth. Only adopts in-scope worktrees. New worktrees
// enter as ADOPTED, so `transition` won't auto-drive them until their plan is
// approved. Returns undefined for out-of-scope frames.
export const adoptFromEvent = (
  state: FleetState,
  ev: HookEvent,
  opts: { match?: string; log?: (message: string) => void }
): Worktree | undefined => {
  if (!ev.cwd || (opts.match && !ev.cwd.includes(opts.match))) {
    return undefined;
  }
  const adoptedName = basename(ev.cwd);
  const wt: Worktree = {
    agent: agentOf(adoptedName),
    cwd: ev.cwd,
    lastSeen: now(),
    name: adoptedName,
    since: now(),
    stage: "ADOPTED",
    workspaceId: ev.workspaceId,
  };
  state.worktrees[ev.workspaceId] = wt;
  record(ev.workspaceId, adoptedName, {
    event: "adopt",
    from: "ADOPTED",
    kind: "adopt",
    to: "ADOPTED",
  });
  opts.log?.(`adopted ${adoptedName} from event stream`);
  return wt;
};
