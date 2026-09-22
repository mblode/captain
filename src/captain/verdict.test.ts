import { describe, expect, it } from "vitest";

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
