import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import type { HookEvent } from "./types.js";

const AGENT_EVENT = "agent.hook.";

interface RawFrame {
  name?: string;
  seq?: number;
  payload?: {
    hook_event_name?: string;
    workspace_id?: string;
    cwd?: string;
  };
}

const toHookEvent = (frame: RawFrame): HookEvent | null => {
  if (!frame.name?.startsWith(AGENT_EVENT)) {
    return null;
  }
  const p = frame.payload;
  if (!(p?.hook_event_name && p.workspace_id)) {
    return null;
  }
  return {
    cwd: p.cwd ?? "",
    hookEventName: p.hook_event_name,
    seq: frame.seq ?? 0,
    workspaceId: p.workspace_id,
  };
};

// Hold the live agent event stream open and call `onEvent` per agent.hook frame
// as it arrives. --reconnect resumes forever; --cursor-file persists the seq so a
// watcher restart resumes with no missed events. Returns the child for shutdown.
export const streamAgentEvents = (
  cursorFile: string,
  env: NodeJS.ProcessEnv,
  onEvent: (event: HookEvent) => void
): ChildProcess => {
  const child = spawn(
    "cmux",
    [
      "events",
      "--category",
      "agent",
      "--reconnect",
      "--cursor-file",
      cursorFile,
      "--no-heartbeat",
      "--no-ack",
    ],
    { env, stdio: ["ignore", "pipe", "ignore"] }
  );

  if (!child.stdout) {
    return child;
  }

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }
    let frame: RawFrame;
    try {
      frame = JSON.parse(trimmed) as RawFrame;
    } catch {
      return;
    }
    const event = toHookEvent(frame);
    if (event) {
      onEvent(event);
    }
  });

  return child;
};
