import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { captainHome } from "../home";

// The thin audit trail: one JSON line per human decision or notification,
// appended to ~/.claude/captain/log.jsonl. Append-only from any process (a
// truncated tail line is just a bad last line; there is no reader to corrupt),
// greppable by hand — captain keeps no other history.

export interface LogRecord {
  ts: number;
  kind: "approve" | "reject";
  name: string;
  note?: string;
}

export const now = (): number => Math.floor(Date.now() / 1000);

export const logPath = (env: NodeJS.ProcessEnv = process.env): string =>
  join(captainHome(env), "log.jsonl");

export const appendLog = (
  rec: LogRecord,
  env: NodeJS.ProcessEnv = process.env
): void => {
  mkdirSync(captainHome(env), { recursive: true });
  appendFileSync(logPath(env), `${JSON.stringify(rec)}\n`);
};
