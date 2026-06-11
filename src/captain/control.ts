import { basename, dirname, isAbsolute, resolve } from "node:path";

import { run, runRequired } from "../shell";

// Short repo label for a worktree path: a linked worktree's --git-common-dir
// resolves to the main checkout's .git, whose parent dir name is the repo
// ("linkiq"). Fail-soft: any git failure (not a repo, fake test path) →
// undefined, so the view never breaks on it.
export const repoLabel = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined => {
  const raw = run("git", ["-C", cwd, "rev-parse", "--git-common-dir"], { env });
  const common = raw.stdout.trim();
  if (raw.status !== 0 || !common) {
    return undefined;
  }
  const gitDir = isAbsolute(common) ? common : resolve(cwd, common);
  return basename(dirname(gitDir)) || undefined;
};

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

// A `cmux top` tag row's ref: workspace:<UUID>:tag:claude_code
const TAG_REF = /^workspace:([^:]+):tag:/iu;

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

  replyExitPlan: (id: string, approve: boolean): void => {
    runRequired(
      "cmux",
      ["rpc", "feed.exit_plan.reply", JSON.stringify({ approve, id })],
      { env }
    );
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
      if (ref) {
        states[ref[1].toLowerCase()] =
          TOP_STATES[cols[6]?.trim().toLowerCase() ?? ""] ?? "unknown";
      }
    }
    return states;
  },

  // `send` types text into a workspace's focused surface; \n submits.
  send: (workspaceId: string, text: string): void => {
    runRequired("cmux", ["send", "--workspace", workspaceId, `${text}\n`], {
      env,
    });
  },
});
