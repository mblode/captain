import { describe, expect, it } from "vitest";

import { claudeCommand } from "./cmux";

describe("claudeCommand", () => {
  it("renders the pinned model/effort launch with no env prefix by default", () => {
    const command = claudeCommand("/tmp/p/prompt.txt", "default", "high");
    expect(command).toBe(
      `claude --model 'default' --effort 'high' --permission-mode plan --allow-dangerously-skip-permissions "$(cat '/tmp/p/prompt.txt')"`
    );
  });

  it("prefixes the agent env so every tool the agent runs inherits it", () => {
    const command = claudeCommand("/tmp/p/prompt.txt", "default", "high", {
      NODE_OPTIONS: "--max-old-space-size=3072",
      VITEST_MAX_THREADS: "2",
    });
    expect(command.startsWith("env ")).toBe(true);
    expect(command).toContain("NODE_OPTIONS='--max-old-space-size=3072'");
    expect(command).toContain("VITEST_MAX_THREADS='2'");
    expect(command).toContain(" claude --model 'default'");
  });

  it("shell-quotes env values that carry spaces or metacharacters", () => {
    const command = claudeCommand("/tmp/p/prompt.txt", "default", "high", {
      NODE_OPTIONS: "--max-old-space-size=3072 --no-warnings",
    });
    expect(command).toContain(
      "NODE_OPTIONS='--max-old-space-size=3072 --no-warnings'"
    );
  });
});
