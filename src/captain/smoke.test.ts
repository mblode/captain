import { describe, expect, it } from "vitest";

import { parseSmoke } from "./smoke";

const check = { evidence: "exit 0", name: "S.1 Terminal", pass: true };

describe("parseSmoke", () => {
  it("reads a pass backed by passing checks", () => {
    const smoke = parseSmoke(
      JSON.stringify({
        checks: [check],
        status: "pass",
        summary: "ok",
        ts: "17",
      })
    );
    expect(smoke?.status).toBe("pass");
    expect(smoke?.ts).toBe(17);
  });

  it("reads a fail, and a running marker with no checks yet", () => {
    expect(
      parseSmoke(
        JSON.stringify({ checks: [{ ...check, pass: false }], status: "fail" })
      )?.status
    ).toBe("fail");
    expect(
      parseSmoke(JSON.stringify({ checks: [], status: "running" }))?.status
    ).toBe("running");
  });

  it("reads a pass whose checks disagree, or that has none, as a fail", () => {
    expect(
      parseSmoke(
        JSON.stringify({
          checks: [check, { ...check, pass: false }],
          status: "pass",
        })
      )?.status
    ).toBe("fail");
    expect(
      parseSmoke(JSON.stringify({ checks: [], status: "pass" }))?.status
    ).toBe("fail");
  });

  it("is null for a missing or garbage file, never a pass", () => {
    expect(parseSmoke("")).toBeNull();
    expect(parseSmoke("{not json")).toBeNull();
    expect(parseSmoke("null")).toBeNull();
    expect(
      parseSmoke(JSON.stringify({ checks: [check], status: "ok" }))
    ).toBeNull();
    expect(parseSmoke(JSON.stringify({ status: "pass" }))).toBeNull();
    expect(
      parseSmoke(JSON.stringify({ checks: [{ name: "x" }], status: "pass" }))
    ).toBeNull();
  });
});
