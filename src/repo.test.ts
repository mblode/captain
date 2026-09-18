import { describe, expect, it } from "vitest";

import { refuseDriverIssueCwd } from "./repo";

describe("refuseDriverIssueCwd", () => {
  it("throws DRIVER_CWD when cwd is a steering desk and --repo-path is absent", () => {
    let caught: unknown;
    try {
      refuseDriverIssueCwd("/Users/me/Code/mblode/linear-god");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      errorType: "DRIVER_CWD",
      exitCode: 2,
    });
    expect(String(caught)).toMatch(/pass --repo-path/u);
  });

  it("allows the same cwd when --repo-path is set", () => {
    expect(() =>
      refuseDriverIssueCwd(
        "/Users/me/Code/mblode/linear-god",
        "/code/frontyard"
      )
    ).not.toThrow();
  });

  it("allows a product checkout without --repo-path", () => {
    expect(() =>
      refuseDriverIssueCwd("/Users/me/Code/linktree/frontyard")
    ).not.toThrow();
  });
});
