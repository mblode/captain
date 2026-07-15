import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { captainHome } from "../home";

// The thin audit trail: one JSON line per human decision or launch,
// appended to ~/.claude/captain/log.jsonl. Append-only from any process (a
// truncated tail line is just a bad last line; there is no reader to corrupt),
// greppable by hand — captain keeps no other history.

export interface LogRecord {
  ts: number;
  kind: "approve" | "reject" | "launch";
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

// One LogRecord per non-empty line if its shape checks out, else skipped — the
// file's own contract: it's append-only from any process, so a truncated tail
// line (or any garbage) is just dropped, never thrown. A missing file is [].
const isLogRecord = (raw: unknown): raw is LogRecord =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { ts?: unknown }).ts === "number" &&
  ((raw as { kind?: unknown }).kind === "approve" ||
    (raw as { kind?: unknown }).kind === "reject" ||
    (raw as { kind?: unknown }).kind === "launch") &&
  typeof (raw as { name?: unknown }).name === "string";

// Read the full audit trail. This is captain's ONE gap-free history: every
// approve/reject — and every launch, the other half of gain's launch→decision
// latency join — was appended here, so ledger metrics are true history (the
// fleet/verdict signals, by contrast, are a live snapshot — see gain.ts).
export const readLog = (env: NodeJS.ProcessEnv = process.env): LogRecord[] => {
  let text: string;
  try {
    text = readFileSync(logPath(env), "utf-8");
  } catch {
    return [];
  }
  const records: LogRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const raw: unknown = JSON.parse(line);
      if (isLogRecord(raw)) {
        records.push(raw);
      }
    } catch {
      // a bad line (e.g. a partial write) is skipped, never fatal
    }
  }
  return records;
};
