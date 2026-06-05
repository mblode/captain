import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendIntent, intentsPath, readIntentsFrom } from "./intents";
import * as state from "./state";
import type { Intent } from "./types";

const FLEET = "default";

const intent = (over: Partial<Intent> = {}): Intent => ({
  kind: "approve",
  ts: 100,
  workspaceId: "ws-1",
  ...over,
});

describe("intents", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "captain-intents-"));
    vi.spyOn(state, "fleetDir").mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns nothing (and an unchanged offset) when no log exists", () => {
    expect(readIntentsFrom(FLEET, 0)).toEqual({ intents: [], offset: 0 });
  });

  it("reads appended intents and advances the cursor past them", () => {
    appendIntent(FLEET, intent({ workspaceId: "ws-a" }));
    appendIntent(
      FLEET,
      intent({ kind: "reject", note: "redo", workspaceId: "ws-b" })
    );
    const first = readIntentsFrom(FLEET, 0);
    expect(first.intents.map((i) => i.workspaceId)).toEqual(["ws-a", "ws-b"]);
    expect(first.intents[1]).toMatchObject({ kind: "reject", note: "redo" });
    expect(first.offset).toBeGreaterThan(0);
    // A re-read from the new offset yields nothing — each intent is consumed once.
    expect(readIntentsFrom(FLEET, first.offset)).toEqual({
      intents: [],
      offset: first.offset,
    });
  });

  it("only consumes intents appended after the cursor", () => {
    appendIntent(FLEET, intent({ workspaceId: "ws-a" }));
    const { offset } = readIntentsFrom(FLEET, 0);
    appendIntent(FLEET, intent({ workspaceId: "ws-b" }));
    const next = readIntentsFrom(FLEET, offset);
    expect(next.intents.map((i) => i.workspaceId)).toEqual(["ws-b"]);
  });

  it("leaves a partial trailing line unconsumed until it is complete", () => {
    appendIntent(FLEET, intent({ workspaceId: "ws-a" }));
    const { offset } = readIntentsFrom(FLEET, 0);
    // A write still in flight: no trailing newline yet.
    writeFileSync(
      intentsPath(FLEET),
      '{"kind":"approve","ts":2,"workspaceId":"ws-b"',
      {
        flag: "a",
      }
    );
    expect(readIntentsFrom(FLEET, offset)).toEqual({ intents: [], offset });
    // Once the line is finished, it reads cleanly.
    writeFileSync(intentsPath(FLEET), "}\n", { flag: "a" });
    const done = readIntentsFrom(FLEET, offset);
    expect(done.intents.map((i) => i.workspaceId)).toEqual(["ws-b"]);
  });

  it("skips a malformed line without wedging the cursor", () => {
    writeFileSync(intentsPath(FLEET), "not json\n", { flag: "a" });
    appendIntent(FLEET, intent({ workspaceId: "ws-good" }));
    const out = readIntentsFrom(FLEET, 0);
    expect(out.intents.map((i) => i.workspaceId)).toEqual(["ws-good"]);
  });
});
