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

export const listWorkspaces = (env: NodeJS.ProcessEnv): CmuxWorkspace[] => {
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
};

// `send` types text into a workspace's focused surface; \n submits.
export const send = (
  workspaceId: string,
  text: string,
  env: NodeJS.ProcessEnv
): void => {
  runRequired("cmux", ["send", "--workspace", workspaceId, `${text}\n`], {
    env,
  });
};

export const readScreen = (
  workspaceId: string,
  env: NodeJS.ProcessEnv,
  lines = 40
): string => {
  const result = run(
    "cmux",
    ["read-screen", "--workspace", workspaceId, "--lines", String(lines)],
    { env }
  );
  return result.stdout;
};

export const notify = (
  title: string,
  body: string,
  env: NodeJS.ProcessEnv
): void => {
  run("cmux", ["notify", "--title", title, "--body", body], { env });
};

// Pending blocks across the fleet (questions / plan approvals / permissions).
export const feedList = (
  env: NodeJS.ProcessEnv
): { id: string; cwd: string; kind: string; status: string }[] => {
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
};

export const replyExitPlan = (
  id: string,
  approve: boolean,
  env: NodeJS.ProcessEnv
): void => {
  runRequired(
    "cmux",
    ["rpc", "feed.exit_plan.reply", JSON.stringify({ approve, id })],
    { env }
  );
};
