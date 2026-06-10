import { basename } from "node:path";

import { record } from "./commit";
import { repoLabel } from "./control";
import type { CmuxWorkspace } from "./control";
import { ticketFrom } from "./format";
import { inScope, now, scopesOf } from "./state";
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

// Stable identity for a new worktree, derived once at adoption: repo label from
// git (fail-soft), ticket from the worktree dir or the workspace name, and a
// `${repo}-${ticket}` display name when both exist — so two worktrees of one
// repo can never share a bare repo-root label like "chat", and every entry is
// addressable by ticket. `fallback` is the pre-existing naming (basename(cwd)
// for events, the workspace description for the RPC list).
const identity = (
  cwd: string,
  fallback: string
): Pick<Worktree, "name" | "repo" | "ticket"> => {
  const repo = repoLabel(cwd);
  const ticket = ticketFrom(basename(cwd)) ?? ticketFrom(fallback);
  const name = repo && ticket ? `${repo}-${ticket}` : fallback;
  return { name, repo, ticket };
};

// Adopt current cmux workspaces into the fleet (excluding the captain itself),
// and drop tracked worktrees whose workspace has vanished. Scope comes from the
// state itself (boot match + any later `scope` intents), so an extension takes
// effect on the very next tick.
export const reconcile = (
  state: FleetState,
  workspaces: CmuxWorkspace[]
): void => {
  // A failed or empty `workspace.list` (the cmux RPC is unreliable from a
  // detached daemon) must NOT wipe the tracked fleet — treat it as "no data this
  // tick" and leave existing worktrees intact. The event stream re-adopts anyway.
  if (workspaces.length === 0) {
    return;
  }
  const scopes = scopesOf(state);
  const selfId = state.captainWorkspaceId;
  const live = new Set<string>();
  for (const w of workspaces) {
    if (w.id === selfId || !inScope(w.cwd, scopes)) {
      continue;
    }
    live.add(w.id);
    const existing = state.worktrees[w.id];
    if (existing) {
      // Refresh the join key only. The name is identity — set once at adoption,
      // never re-labelled mid-flight (it's what --ref/audit/intents resolve by).
      existing.cwd = w.cwd;
    } else {
      const id = identity(w.cwd, w.name);
      state.worktrees[w.id] = {
        agent: agentOf(w.name),
        cwd: w.cwd,
        lastSeen: now(),
        since: now(),
        stage: "ADOPTED",
        workspaceId: w.id,
        ...id,
      };
      record(w.id, id.name, {
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
  opts: { log?: (message: string) => void }
): Worktree | undefined => {
  if (!ev.cwd || !inScope(ev.cwd, scopesOf(state))) {
    return undefined;
  }
  const fallback = basename(ev.cwd);
  const id = identity(ev.cwd, fallback);
  const wt: Worktree = {
    agent: agentOf(fallback),
    cwd: ev.cwd,
    lastSeen: now(),
    since: now(),
    stage: "ADOPTED",
    workspaceId: ev.workspaceId,
    ...id,
  };
  state.worktrees[ev.workspaceId] = wt;
  record(ev.workspaceId, id.name, {
    event: "adopt",
    from: "ADOPTED",
    kind: "adopt",
    to: "ADOPTED",
  });
  opts.log?.(`adopted ${id.name} from event stream`);
  return wt;
};
