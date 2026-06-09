import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderRubric } from "../rubric";
import type { Stage, Verdict, Worktree } from "./types";
import {
  checkVerdict,
  expectedRubricHash,
  parseVerdict,
  readVerdict,
} from "./verdict";

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  criteria: [{ evidence: "src/x.ts:10", name: "implements", pass: true }],
  issue: "TIG-430",
  rubricHash: "abc123",
  summary: "all criteria pass",
  ts: 1_700_000_000,
  verdict: "pass",
  ...over,
});

const wt = (over: Partial<Worktree> = {}): Worktree => ({
  agent: "claude",
  cwd: "/wt/tig-430",
  name: "tig-430",
  retries: 0,
  since: 0,
  stage: "BABYSITTING",
  workspaceId: "ws-1",
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

describe("checkVerdict", () => {
  it("parks the pr-ready gate on a verified pass", () => {
    const t = checkVerdict(wt(), verdict(), "abc123");
    expect(t).toEqual({
      gate: "pr-ready",
      nextStage: "READY_TO_MERGE",
      notify: "verified PR-ready: all criteria pass",
    });
  });

  it("escalates a fail to BLOCKED with the verifier's summary", () => {
    const t = checkVerdict(
      wt(),
      verdict({ summary: "tests missing", verdict: "fail" }),
      "abc123"
    );
    expect(t?.nextStage).toBe("BLOCKED");
    expect(t?.gate).toBe("needs-input");
    expect(t?.notify).toContain("tests missing");
  });

  it("ignores a verdict citing the wrong rubric hash (stale or tampered)", () => {
    expect(checkVerdict(wt(), verdict(), "other-hash")).toBeNull();
  });

  it("accepts the verdict's hash when no rubric exists to check against", () => {
    expect(checkVerdict(wt(), verdict())?.nextStage).toBe("READY_TO_MERGE");
  });

  it("does nothing without a verdict", () => {
    expect(checkVerdict(wt(), null, "abc123")).toBeNull();
  });

  it("only fires in the PR stages", () => {
    const earlier: Stage[] = [
      "ADOPTED",
      "PLANNING",
      "PLAN_READY",
      "IMPLEMENTING",
      "SIMPLIFY",
      "REVIEW",
      "READY_TO_MERGE",
      "BLOCKED",
    ];
    for (const stage of earlier) {
      expect(checkVerdict(wt({ stage }), verdict(), "abc123")).toBeNull();
    }
    expect(
      checkVerdict(wt({ stage: "PR_OPEN" }), verdict(), "abc123")
    ).not.toBeNull();
  });

  it("never re-fires once a gate is parked (idempotent on re-checks)", () => {
    expect(
      checkVerdict(wt({ gate: "pr-ready" }), verdict(), "abc123")
    ).toBeNull();
  });
});

describe("the fs round trip (rubric on disk → verdict → gate)", () => {
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

  it("a verdict citing the on-disk rubric's hash opens the pr-ready gate", () => {
    const { cwd, hash } = worktreeWithRubric();
    writeFileSync(
      join(cwd, ".captain", "verdict.json"),
      JSON.stringify(verdict({ rubricHash: hash }))
    );
    const t = checkVerdict(
      wt({ cwd }),
      readVerdict(cwd),
      expectedRubricHash(cwd)
    );
    expect(t?.nextStage).toBe("READY_TO_MERGE");
    expect(t?.gate).toBe("pr-ready");
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
    expect(
      checkVerdict(wt({ cwd }), readVerdict(cwd), expectedRubricHash(cwd))
    ).toBeNull();
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
