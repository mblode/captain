import { describe, expect, it } from "vitest";

import { rollup } from "./github";

describe("rollup", () => {
  it("is none with no checks, so a repo without CI never reads green", () => {
    expect(rollup([])).toBe("none");
  });

  it("fails on any failed check run or status", () => {
    expect(
      rollup([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: "FAILURE", status: "COMPLETED" },
      ])
    ).toBe("fail");
    expect(rollup([{ state: "ERROR" }])).toBe("fail");
  });

  it("is pending while anything still runs", () => {
    expect(
      rollup([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: "", status: "IN_PROGRESS" },
      ])
    ).toBe("pending");
    expect(rollup([{ state: "PENDING" }])).toBe("pending");
  });

  it("passes when every check completed without failing", () => {
    expect(
      rollup([
        { conclusion: "SUCCESS", status: "COMPLETED" },
        { conclusion: "SKIPPED", status: "COMPLETED" },
        { state: "SUCCESS" },
      ])
    ).toBe("pass");
  });
});
