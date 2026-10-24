import { describe, expect, it } from "vitest";

import { pendingGate, screenGate, screenPlanApprovable } from "./gate";

const PLAN_SCREEN = [
  "Here is the plan.",
  "Would you like to proceed?",
  "❯ 1. Yes, and bypass permissions",
  "  2. Yes, manually approve edits",
  "  3. No, keep planning",
].join("\n");

describe("pendingGate", () => {
  const items = [
    {
      cwd: "/r",
      id: "a",
      kind: "exitPlan",
      request_id: "ra",
      session: "s-a",
      status: "",
    },
    {
      cwd: "/r",
      id: "b",
      kind: "exitPlan",
      request_id: "rb",
      session: "s-b",
      status: "",
    },
  ];

  it("matches by session when one is known, so shared workers don't swap gates", () => {
    expect(pendingGate(items, "/r", "s-a")?.replyId).toBe("ra");
    expect(pendingGate(items, "/r", "s-c")).toBeUndefined();
  });

  it("falls back to the newest gate for the cwd without a session", () => {
    expect(pendingGate(items, "/private/r/")?.replyId).toBe("rb");
  });
});

describe("screenGate", () => {
  it("reads a plan menu the feed has forgotten", () => {
    expect(screenGate(PLAN_SCREEN)).toMatchObject({
      kind: "plan",
      onScreen: true,
    });
  });

  it("reads a question menu with its bordered text as the hint", () => {
    const screen =
      "│ Which table should I migrate?\n❯ 1. users\nEnter to select · Esc to cancel";
    expect(screenGate(screen)).toMatchObject({
      hint: "Which table should I migrate?",
      kind: "question",
    });
  });

  it("ignores a menu that has scrolled out of the last 25 lines", () => {
    const screen = `${PLAN_SCREEN}\n${"working…\n".repeat(30)}`;
    expect(screenGate(screen)).toBeUndefined();
  });
});

describe("screenPlanApprovable", () => {
  it("allows Enter only when the bypass approval is highlighted", () => {
    expect(screenPlanApprovable(PLAN_SCREEN)).toBe(true);
    expect(
      screenPlanApprovable(
        PLAN_SCREEN.replace("❯ 1.", "  1.").replace("  3.", "❯ 3.")
      )
    ).toBe(false);
  });
});
