import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The thin audit trail: one JSON line per human decision or notification,
// appended to ~/.claude/captain/log.jsonl. Append-only from any process (a
// truncated tail line is just a bad last line; there is no reader to corrupt),
// greppable by hand — captain keeps no other history.

export interface LogRecord {
  ts: number;
  kind: "approve" | "reject" | "gate" | "ready" | "quiet";
  name: string;
  note?: string;
}

export const now = (): number => Math.floor(Date.now() / 1000);

// CAPTAIN_HOME overrides for tests, the same way CAPTAIN_MEMORY_DIR guards
// the fleet memory.
export const captainHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CAPTAIN_HOME ?? join(homedir(), ".claude", "captain");

export const logPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(captainHome(env), "log.jsonl");

export const appendLog = (
  rec: LogRecord,
  env: NodeJS.ProcessEnv = process.env
): void => {
  mkdirSync(captainHome(env), { recursive: true });
  appendFileSync(logPath(env), `${JSON.stringify(rec)}\n`);
};
