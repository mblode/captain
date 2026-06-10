import { basename } from "node:path";

import { run, runRequired } from "../shell";

// Thin wrappers over the cmux CLI for the captain's "hands". Each reuses the
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

// The injectable seam between the watcher and cmux. The watcher modules take a
// CmuxPort via WatchOptions instead of importing spawn wrappers directly, so the
// tests drive the REAL orchestration code with an in-memory fake — one seam, no
// mocking library. `realCmux(env)` folds the env in once at the entrypoint
// (watch()/cli), keeping every call site free of env threading.
export interface CmuxPort {
  listWorkspaces(): CmuxWorkspace[];
  send(workspaceId: string, text: string): void;
  readScreen(workspaceId: string, lines?: number): string;
  notify(title: string, body: string): void;
  feedList(): CmuxFeedItem[];
  replyExitPlan(id: string, approve: boolean): void;
  runState(workspaceId: string): RunState;
}

// What a tag row's title says → our RunState. Anything else parses as "unknown"
// so the caller falls back to the legacy screen scrape.
const TOP_STATES: Record<string, RunState> = {
  idle: "idle",
  "needs input": "needs-input",
  running: "running",
};

// The default port: spawnSync against the real cmux CLI.
export const realCmux = (env: NodeJS.ProcessEnv): CmuxPort => ({
  // Pending blocks across the fleet (questions / plan approvals / permissions).
  feedList: (): CmuxFeedItem[] => {
    const raw = run("cmux", ["rpc", "feed.list"], { env });
    if (raw.status !== 0) {
      return [];
    }
    const parsed = JSON.parse(raw.stdout) as {
      items?: {
        id: string;
        cwd?: string;
        kind?: string;
        status?: string;
        question_prompt?: string | null;
        text?: string | null;
        resolved_at?: string | null;
      }[];
    };
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
    const parsed = JSON.parse(raw.stdout) as {
      workspaces?: {
        id: string;
        ref: string;
        description?: string | null;
        current_directory?: string | null;
      }[];
    };
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

  readScreen: (workspaceId: string, lines = 40): string => {
    const result = run(
      "cmux",
      ["read-screen", "--workspace", workspaceId, "--lines", String(lines)],
      { env }
    );
    return result.stdout;
  },

  replyExitPlan: (id: string, approve: boolean): void => {
    runRequired(
      "cmux",
      ["rpc", "feed.exit_plan.reply", JSON.stringify({ approve, id })],
      { env }
    );
  },

  // Per-workspace agent run state from `cmux top`'s status tag row:
  //   <cpu>\t<mem>\t<procs>\ttag\tworkspace:<UUID>:tag:claude_code\tworkspace:N\tRunning
  // (TSV columns: cpu, mem, procs, kind, ref, parent_ref, title — verified live
  // on 0.64.14). `--all` because the watcher is a detached daemon with no
  // "current window"; without it top scopes to one window and other windows'
  // workspaces would all read "unknown". Any failure → "unknown" so driving
  // falls back to the screen scrape instead of stalling on a flaky `top`.
  runState: (workspaceId: string): RunState => {
    if (!workspaceId) {
      return "unknown";
    }
    const raw = run("cmux", ["top", "--all", "--flat", "--format", "tsv"], {
      env,
    });
    if (raw.status !== 0) {
      return "unknown";
    }
    const needle = workspaceId.toLowerCase();
    for (const line of raw.stdout.split("\n")) {
      const cols = line.split("\t");
      if (cols[3] === "tag" && cols[4]?.toLowerCase().includes(needle)) {
        return TOP_STATES[cols[6]?.trim().toLowerCase() ?? ""] ?? "unknown";
      }
    }
    return "unknown";
  },

  // `send` types text into a workspace's focused surface; \n submits.
  send: (workspaceId: string, text: string): void => {
    runRequired("cmux", ["send", "--workspace", workspaceId, `${text}\n`], {
      env,
    });
  },
});
