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
export interface CmuxFeedItem {
  id: string;
  cwd: string;
  kind: string;
  status: string;
}

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
}

// The default port: spawnSync against the real cmux CLI.
export const realCmux = (env: NodeJS.ProcessEnv): CmuxPort => ({
  // Pending blocks across the fleet (questions / plan approvals / permissions).
  feedList: (): CmuxFeedItem[] => {
    const raw = run("cmux", ["rpc", "feed.list"], { env });
    if (raw.status !== 0) {
      return [];
    }
    const parsed = JSON.parse(raw.stdout) as {
      items?: { id: string; cwd?: string; kind?: string; status?: string }[];
    };
    return (parsed.items ?? []).map((i) => ({
      cwd: i.cwd ?? "",
      id: i.id,
      kind: i.kind ?? "",
      status: i.status ?? "",
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

  // `send` types text into a workspace's focused surface; \n submits.
  send: (workspaceId: string, text: string): void => {
    runRequired("cmux", ["send", "--workspace", workspaceId, `${text}\n`], {
      env,
    });
  },
});
