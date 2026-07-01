import { basename } from "node:path";

import { cmuxReachable } from "../cmux";
import { CliError, EXIT } from "../errors";
import { run, runRequired } from "../shell";

// Thin wrappers over the cmux CLI for captain's "hands". Each reuses the
// shared spawn helpers so behaviour matches the rest of the tool.

export interface CmuxWorkspace {
  id: string;
  ref: string;
  name: string;
  cwd: string;
}

// One pending block from the fleet feed (question / plan approval / permission).
// Field names mirror the feed.list wire payload (cmux 0.64.14).
export interface CmuxFeedItem {
  id: string;
  cwd: string;
  kind: string;
  status: string;
  // kind:"question" — the prompt the agent is blocked on
  question_prompt?: string;
  // text-bearing kinds (userPrompt / notification)
  text?: string;
  // ISO timestamp once the item is answered/expired; absent while pending —
  // the wire's "unresolved" marker (status alone reads "expired" after the fact)
  resolved_at?: string;
}

// The cmux-native run state of a workspace's agent process. This comes from
// `cmux top`'s per-workspace status TAG (process accounting), NOT the workspace
// status glyph — the "never trust cmux's built-in status" rule is about the
// latter (it desyncs); the tag tracks the live agent process. "unknown" = top
// failed or no tag row for that workspace.
export type RunState = "running" | "needs-input" | "idle" | "unknown";

// The injectable seam between captain and cmux. status/approve/reject/notify
// take a CmuxPort instead of importing spawn wrappers directly, so the tests
// drive the REAL code with an in-memory fake — one seam, no mocking library.
// `realCmux(env)` folds the env in once at the entrypoint, keeping every call
// site free of env threading.
export interface CmuxPort {
  // Is the cmux daemon up? Probed BEFORE building a fleet view so a dead cmux
  // reads as an error, not an empty (= "all done") fleet. The list/feed/runState
  // calls all fail soft to []/{}, which is indistinguishable from a quiet fleet
  // — this is the one signal that tells them apart.
  reachable(): boolean;
  listWorkspaces(): CmuxWorkspace[];
  send(workspaceId: string, text: string): void;
  notify(title: string, body: string): void;
  feedList(): CmuxFeedItem[];
  replyExitPlan(id: string, approve: boolean): void;
  // every workspace's agent run state, keyed by workspace id (one `cmux top`)
  runStates(): Record<string, RunState>;
}

// What a tag row's title says → our RunState.
const TOP_STATES: Record<string, RunState> = {
  idle: "idle",
  "needs input": "needs-input",
  running: "running",
};

// A `cmux top` tag row's ref: workspace:<UUID>:tag:claude_code — capture both
// the workspace id and the tag NAME (a workspace can carry more than one tag row).
const TAG_REF = /^workspace:([^:]+):tag:(.+)$/iu;

// Parse cmux RPC stdout, falling back on garbage. The RPC is unreliable: a
// status-0 response with malformed stdout must read as "no data this tick", not
// a thrown exception (every reader downstream — status, notify — depends on it).
const safeJson = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

// The default port: spawnSync against the real cmux CLI.
export const realCmux = (env: NodeJS.ProcessEnv): CmuxPort => ({
  // Pending blocks across the fleet (questions / plan approvals / permissions).
  feedList: (): CmuxFeedItem[] => {
    const raw = run("cmux", ["rpc", "feed.list"], { env });
    if (raw.status !== 0) {
      return [];
    }
    const parsed = safeJson(
      raw.stdout,
      {} as {
        items?: {
          id: string;
          cwd?: string;
          kind?: string;
          status?: string;
          question_prompt?: string | null;
          text?: string | null;
          resolved_at?: string | null;
        }[];
      }
    );
    return (parsed.items ?? []).map((i) => ({
      cwd: i.cwd ?? "",
      id: i.id,
      kind: i.kind ?? "",
      question_prompt: i.question_prompt ?? undefined,
      resolved_at: i.resolved_at ?? undefined,
      status: i.status ?? "",
      text: i.text ?? undefined,
    }));
  },

  listWorkspaces: (): CmuxWorkspace[] => {
    const raw = run("cmux", ["rpc", "workspace.list"], { env });
    if (raw.status !== 0) {
      return [];
    }
    const parsed = safeJson(
      raw.stdout,
      {} as {
        workspaces?: {
          id: string;
          ref: string;
          description?: string | null;
          current_directory?: string | null;
        }[];
      }
    );
    return (parsed.workspaces ?? []).map((w) => {
      const cwd = w.current_directory ?? "";
      return {
        cwd,
        id: w.id,
        name: w.description || (cwd ? basename(cwd) : w.ref),
        ref: w.ref,
      };
    });
  },

  notify: (title: string, body: string): void => {
    run("cmux", ["notify", "--title", title, "--body", body], { env });
  },

  // Is cmux up? Reuses the shared reachability probe (commandExists + `ping`).
  reachable: (): boolean => cmuxReachable(env),

  replyExitPlan: (id: string, approve: boolean): void => {
    try {
      runRequired(
        "cmux",
        ["rpc", "feed.exit_plan.reply", JSON.stringify({ approve, id })],
        { env }
      );
    } catch (error) {
      throw new CliError(
        `failed to reply to the plan gate via cmux: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.CMUX_UNREACHABLE,
        "CMUX_UNREACHABLE"
      );
    }
  },

  // Every workspace's agent run state from `cmux top`'s status tag rows:
  //   <cpu>\t<mem>\t<procs>\ttag\tworkspace:<UUID>:tag:claude_code\tworkspace:N\tRunning
  // (TSV columns: cpu, mem, procs, kind, ref, parent_ref, title — verified live
  // on 0.64.14). `--all` because captain runs outside any window; without it
  // top scopes to one window. Any failure → {} so every lookup reads "unknown".
  runStates: (): Record<string, RunState> => {
    const raw = run("cmux", ["top", "--all", "--flat", "--format", "tsv"], {
      env,
    });
    if (raw.status !== 0) {
      return {};
    }
    const states: Record<string, RunState> = {};
    for (const line of raw.stdout.split("\n")) {
      const cols = line.split("\t");
      const ref = cols[3] === "tag" ? cols[4]?.match(TAG_REF) : null;
      if (!ref) {
        continue;
      }
      const id = ref[1].toLowerCase();
      const state =
        TOP_STATES[cols[6]?.trim().toLowerCase() ?? ""] ?? "unknown";
      // The agent's own `claude_code` tag is authoritative — it always wins,
      // regardless of row order. Any other tag row only fills a workspace we
      // haven't seen yet, so a stray second tag can't clobber the agent's state.
      if (ref[2].toLowerCase() === "claude_code" || !(id in states)) {
        states[id] = state;
      }
    }
    return states;
  },

  // `send` types text into a workspace's focused surface; \n submits.
  send: (workspaceId: string, text: string): void => {
    try {
      runRequired("cmux", ["send", "--workspace", workspaceId, `${text}\n`], {
        env,
      });
    } catch (error) {
      throw new CliError(
        `failed to send to workspace ${workspaceId} via cmux: ${error instanceof Error ? error.message : String(error)}`,
        EXIT.CMUX_UNREACHABLE,
        "CMUX_UNREACHABLE"
      );
    }
  },
});
