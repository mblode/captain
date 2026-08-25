import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderRubric } from "../rubric";
import type { Issue } from "../types";
// The fs readers live in surface.ts so verdict.ts stays pure.
import { readRubricFacts, readVerdict } from "./surface";
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

  // The rubric's schema example modelled `ts` as a string for months, so most
  // verdicts on disk carry a quoted integer. Scoring those 0 silently dropped
  // them from gain's launch→verdict latency.
  it("accepts an epoch written as a quoted integer", () => {
    const v = parseVerdict(
      JSON.stringify({ ...verdict(), ts: "1784854700" as unknown as number })
    );
    expect(v?.ts).toBe(1_784_854_700);
  });

  it("scores an unparseable epoch 0 rather than guessing", () => {
    for (const ts of ["", "later", "17e9", null, {}]) {
      const v = parseVerdict(
        JSON.stringify({ ...verdict(), ts: ts as unknown as number })
      );
      expect(v?.ts).toBe(0);
    }
  });

  // `na` is the escape hatch for a criterion that cannot apply to a diff. Without
  // it the only representable answers were pass and fail, so agents argued
  // inapplicable criteria into passes.
  it("carries a not-applicable criterion through as a third state", () => {
    const v = parseVerdict(
      JSON.stringify(
        verdict({
          criteria: [
            {
              evidence: "docs-only diff; the repo has no doc tests",
              na: true,
              name: "2. The repo's test command passes.",
              pass: false,
            },
          ],
        })
      )
    );
    expect(v?.criteria[0]?.na).toBe(true);
    expect(v?.criteria[0]?.pass).toBe(false);
  });

  it("rejects a non-boolean na rather than coercing it", () => {
    expect(
      parseVerdict(
        JSON.stringify(
          verdict({
            criteria: [
              {
                evidence: "e",
                na: "yes" as unknown as boolean,
                name: "n",
                pass: true,
              },
            ],
          })
        )
      )
    ).toBeNull();
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
    // A criterion missing (or with a non-string) `evidence` is malformed → null.
    expect(
      parseVerdict(
        JSON.stringify({
          ...verdict(),
          criteria: [{ name: "implements", pass: true }],
        })
      )
    ).toBeNull();
    expect(
      parseVerdict(
        JSON.stringify({
          ...verdict(),
          criteria: [{ evidence: 42, name: "implements", pass: true }],
        })
      )
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
    expect(v && verdictCounts(v, readRubricFacts(cwd).hash)).toBe(true);
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
    expect(v && verdictCounts(v, readRubricFacts(cwd).hash)).toBe(false);
  });

  it("a missing verdict file reads as no verdict", () => {
    const { cwd } = worktreeWithRubric();
    expect(readVerdict(cwd)).toBeNull();
  });

  it("a missing rubric leaves the hash unchecked", () => {
    const cwd = mkdtempSync(join(tmpdir(), "captain-verdict-"));
    cleanup.push(cwd);
    expect(readRubricFacts(cwd).hash).toBeUndefined();
  });
});

// Driven through the REAL renderRubric, never hand-built text: memory.ts's
// headingAt bug survived for months precisely because every fixture was
// hand-written with no preamble around the thing being matched.
describe("readRubricFacts title", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const path of cleanup.splice(0)) {
      await rm(path, { force: true, recursive: true });
    }
  });

  const worktreeFor = (issue?: Issue): string => {
    const cwd = mkdtempSync(join(tmpdir(), "captain-rubric-"));
    cleanup.push(cwd);
    mkdirSync(join(cwd, ".captain"));
    writeFileSync(
      join(cwd, ".captain", "rubric.md"),
      renderRubric(issue, "TIG-430").text
    );
    return cwd;
  };

  it("reads the ticket title a real rubric carries", () => {
    const cwd = worktreeFor({
      criteria: [],
      description: "body",
      identifier: "TIG-430",
      title: "LinkCoach hedges the Pulse recommendation",
    });
    expect(readRubricFacts(cwd).title).toBe(
      "LinkCoach hedges the Pulse recommendation"
    );
  });

  // The rubric embeds the issue description VERBATIM below the context block, so
  // a rubric can hold two "- Title:" lines. Today the context block comes first
  // and first-match wins; this pins that, so reordering the rubric (or matching
  // without the ^ anchor, which would also catch an indented or suffixed line)
  // fails here instead of silently retitling every row.
  it("ignores a '- Title:' line inside the issue description", () => {
    const cwd = worktreeFor({
      criteria: [],
      description: "Repro steps:\n- Title: not the ticket title\n- open /app",
      identifier: "TIG-430",
      title: "The real one",
    });
    expect(readRubricFacts(cwd).title).toBe("The real one");
  });

  it("has no title for a free-form dispatch", () => {
    expect(readRubricFacts(worktreeFor()).title).toBeUndefined();
  });
});
