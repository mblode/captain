import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The thin audit trail: one JSON line per human decision or task transition,
// appended to <project>/log.jsonl. Append-only from any process (a truncated
// tail line is just a bad last line; there is no reader to corrupt), greppable
// by hand.

const LOG_KINDS = [
  "add",
  "start",
  "approve",
  "reject",
  "review",
  "done",
  "drop",
] as const;
type LogKind = (typeof LOG_KINDS)[number];

export interface LogRecord {
  ts: number;
  kind: LogKind;
  name: string;
  // Why: on a reject, what to change (also delivered to the agent); on an
  // approve, why it was safe to proceed; on a start, the harness and model.
  note?: string;
}

export const now = (): number => Math.floor(Date.now() / 1000);

const logPath = (dir: string): string => join(dir, "log.jsonl");

export const appendLog = (rec: LogRecord, dir: string): void => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(logPath(dir), `${JSON.stringify(rec)}\n`);
};

// One LogRecord per non-empty line if its shape checks out, else skipped — the
// file's own contract: it's append-only from any process, so a truncated tail
// line (or any garbage) is just dropped, never thrown. A missing file is [].
const isLogRecord = (raw: unknown): raw is LogRecord =>
  typeof raw === "object" &&
  raw !== null &&
  typeof (raw as { ts?: unknown }).ts === "number" &&
  (LOG_KINDS as readonly unknown[]).includes(
    (raw as { kind?: unknown }).kind
  ) &&
  typeof (raw as { name?: unknown }).name === "string";

// Read the full audit trail: the gap-free history `captain gain` counts from.
export const readLog = (dir: string): LogRecord[] => {
  let text: string;
  try {
    text = readFileSync(logPath(dir), "utf-8");
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
