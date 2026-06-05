import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fleetDir } from "./state";
import type { HistoryRecord } from "./types";

// The append-only audit log: one JSON record per line. Append is the only write,
// so it never races the state.json temp+rename and can't be left half-written.
export const historyPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "history.jsonl");

export const appendHistory = (fleetId: string, rec: HistoryRecord): void => {
  const dir = fleetDir(fleetId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(historyPath(fleetId), `${JSON.stringify(rec)}\n`);
};

// Parse the log line-by-line, skipping anything malformed — a truncated tail
// line (mid-append crash) must never break a read, mirroring events.ts.
export const readHistory = (fleetId: string): HistoryRecord[] => {
  const path = historyPath(fleetId);
  if (!existsSync(path)) {
    return [];
  }
  const out: HistoryRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed) as HistoryRecord);
    } catch {
      // skip a malformed/truncated line
    }
  }
  return out;
};
