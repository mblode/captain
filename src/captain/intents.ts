import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fleetDir } from "./state";
import type { Intent } from "./types";

// The append-only intent log: one JSON record per line. `approve`/`reject` run in
// a separate process from the watcher, so they must never write state.json (that
// would race the watcher's live saves). Instead they append here — append is the
// only write, atomic and lock-free — and the watcher, the sole writer of
// state.json, drains and applies each intent exactly once via a byte-offset cursor.
export const intentsPath = (fleetId: string): string =>
  join(fleetDir(fleetId), "intents.jsonl");

export const appendIntent = (fleetId: string, intent: Intent): void => {
  const dir = fleetDir(fleetId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(intentsPath(fleetId), `${JSON.stringify(intent)}\n`);
};

// Read intents appended since `offset` bytes. Returns the parsed intents plus the
// new offset (end of the last COMPLETE line). A partial trailing line — a write
// still in flight — is left unconsumed so the next drain picks it up whole, and a
// malformed line is skipped, mirroring the resilience of readHistory/events.ts.
export const readIntentsFrom = (
  fleetId: string,
  offset: number
): { intents: Intent[]; offset: number } => {
  let buf: Buffer;
  try {
    buf = readFileSync(intentsPath(fleetId));
  } catch {
    // no log yet (or truncated to before the offset): nothing new to apply.
    return { intents: [], offset };
  }
  if (offset >= buf.length) {
    return { intents: [], offset };
  }
  const text = buf.subarray(offset).toString("utf-8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    // only a partial line so far — wait for it to be finished.
    return { intents: [], offset };
  }
  const complete = text.slice(0, lastNewline);
  const intents: Intent[] = [];
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      intents.push(JSON.parse(trimmed) as Intent);
    } catch {
      // skip a malformed line rather than wedging the cursor.
    }
  }
  // advance the cursor past every complete line (the trailing newline included).
  return { intents, offset: offset + Buffer.byteLength(complete, "utf-8") + 1 };
};
