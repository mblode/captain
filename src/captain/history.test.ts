import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendHistory, historyPath, readHistory } from "./history";
import * as state from "./state";
import type { HistoryRecord } from "./types";

const FLEET = "default";

const rec = (over: Partial<HistoryRecord> = {}): HistoryRecord => ({
  event: "Stop",
  from: "IMPLEMENTING",
  kind: "advance",
  name: "tig-1",
  seq: 1,
  to: "SIMPLIFY",
  ts: 100,
  workspaceId: "ws-1",
  ...over,
});

describe("history", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "captain-hist-"));
    vi.spyOn(state, "fleetDir").mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips appended records in order", () => {
    appendHistory(FLEET, rec({ seq: 1 }));
    appendHistory(FLEET, rec({ kind: "gate", seq: 2, to: "BLOCKED" }));
    const out = readHistory(FLEET);
    expect(out.map((r) => r.seq)).toEqual([1, 2]);
    expect(out[1]).toMatchObject({ kind: "gate", to: "BLOCKED" });
  });

  it("returns [] when no log exists yet", () => {
    expect(readHistory(FLEET)).toEqual([]);
  });

  it("skips a malformed/truncated tail line", () => {
    appendHistory(FLEET, rec({ seq: 1 }));
    // Simulate a crash mid-append leaving a partial JSON line.
    writeFileSync(historyPath(FLEET), `${'{"oops": '}`, { flag: "a" });
    const out = readHistory(FLEET);
    expect(out).toHaveLength(1);
    expect(out[0].seq).toBe(1);
  });
});
