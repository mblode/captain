import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderRubric } from "../rubric";
// The fs readers live in surface.ts so verdict.ts stays pure.
import { expectedRubricHash, readVerdict } from "./surface";
import { parseVerdict, verdictCounts } from "./verdict";
import type { Verdict } from "./verdict";

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  criteria: [{ evidence: "src/x.ts:10", name: "implements", pass: true }],
  issue: "TIG-430",
  rubricHash: "abc123",
  summary: "all criteria pass",
  ts: 1_700_000_000,
  verdict: "pass",
  ...over,
});

describe("parseVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const v = parseVerdict(JSON.stringify(verdict()));
    expect(v?.verdict).toBe("pass");
    expect(v?.summary).toBe("all criteria pass");
  });

  it("carries the optional prUrl through", () => {
    const v = parseVerdict(
      JSON.stringify(verdict({ prUrl: "https://github.com/x/y/pull/1" }))
    );
    expect(v?.prUrl).toBe("https://github.com/x/y/pull/1");
  });

  it("rejects garbage, non-objects, and missing fields", () => {
    expect(parseVerdict("not json {{{")).toBeNull();
    expect(parseVerdict('"a string"')).toBeNull();
    expect(parseVerdict("null")).toBeNull();
    // A malformed verdict must read as "no verdict", never as a pass.
    expect(
      parseVerdict(JSON.stringify({ ...verdict(), verdict: "PASS" }))
    ).toBeNull();
    expect(
      parseVerdict(JSON.stringify({ ...verdict(), rubricHash: 42 }))
    ).toBeNull();
    const { summary: _omitted, ...noSummary } = verdict();
    expect(parseVerdict(JSON.stringify(noSummary))).toBeNull();
    expect(
      parseVerdict(JSON.stringify({ ...verdict(), criteria: [{ name: 1 }] }))
    ).toBeNull();
  });
});

describe("verdictCounts", () => {
  it("accepts a matching hash and rejects a stale/tampered one", () => {
    expect(verdictCounts(verdict(), "abc123")).toBe(true);
    expect(verdictCounts(verdict(), "other-hash")).toBe(false);
  });

  it("accepts as-is when no rubric exists to check against", () => {
    expect(verdictCounts(verdict())).toBe(true);
  });
});

describe("the fs round trip (rubric on disk → verdict → hash check)", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const path of cleanup.splice(0)) {
      await rm(path, { force: true, recursive: true });
    }
  });

  const worktreeWithRubric = (): { cwd: string; hash: string } => {
    const cwd = mkdtempSync(join(tmpdir(), "captain-verdict-"));
    cleanup.push(cwd);
    const { hash, text } = renderRubric(undefined, "TIG-430");
    mkdirSync(join(cwd, ".captain"));
    writeFileSync(join(cwd, ".captain", "rubric.md"), text);
    return { cwd, hash };
  };

  it("a verdict citing the on-disk rubric's hash counts", () => {
    const { cwd, hash } = worktreeWithRubric();
    writeFileSync(
      join(cwd, ".captain", "verdict.json"),
      JSON.stringify(verdict({ rubricHash: hash }))
    );
    const v = readVerdict(cwd);
    expect(v).not.toBeNull();
    expect(v && verdictCounts(v, expectedRubricHash(cwd))).toBe(true);
  });

  it("editing the rubric after the verdict voids it", () => {
    const { cwd, hash } = worktreeWithRubric();
    writeFileSync(
      join(cwd, ".captain", "verdict.json"),
      JSON.stringify(verdict({ rubricHash: hash }))
    );
    writeFileSync(
      join(cwd, ".captain", "rubric.md"),
      "# Definition of done — TIG-430\n\nweakened criteria\n"
    );
    const v = readVerdict(cwd);
    expect(v && verdictCounts(v, expectedRubricHash(cwd))).toBe(false);
  });

  it("a missing verdict file reads as no verdict", () => {
    const { cwd } = worktreeWithRubric();
    expect(readVerdict(cwd)).toBeNull();
  });

  it("a missing rubric leaves the hash unchecked", () => {
    const cwd = mkdtempSync(join(tmpdir(), "captain-verdict-"));
    cleanup.push(cwd);
    expect(expectedRubricHash(cwd)).toBeUndefined();
  });
});
