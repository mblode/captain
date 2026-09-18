import { describe, expect, it } from "vitest";

import {
  agentCommand,
  claudeCommand,
  codexCommand,
  formatCmuxUnreachable,
} from "./cmux";

describe("claudeCommand", () => {
  it("renders the pinned model/effort launch with no env prefix by default", () => {
    const command = claudeCommand("/tmp/p/prompt.txt", "default", "high");
    expect(command).toBe(
      `claude --model 'default' --effort 'high' --permission-mode plan --allow-dangerously-skip-permissions "$(cat '/tmp/p/prompt.txt')"`
    );
  });

  it("pins --name so the Claude session matches the ticket slug", () => {
    const command = claudeCommand(
      "/tmp/p/prompt.txt",
      "default",
      "high",
      {},
      "tst-1"
    );
    expect(command).toBe(
      `claude --name 'tst-1' --model 'default' --effort 'high' --permission-mode plan --allow-dangerously-skip-permissions "$(cat '/tmp/p/prompt.txt')"`
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

describe("codexCommand", () => {
  it("omits -m on the 'default' model sentinel (codex uses its own default)", () => {
    const command = codexCommand("/tmp/p/prompt.txt", "default", "high");
    expect(command).toBe(
      `codex -c model_reasoning_effort='high' --dangerously-bypass-approvals-and-sandbox "$(cat '/tmp/p/prompt.txt')"`
    );
  });

  it("passes -m when a concrete model is configured", () => {
    const command = codexCommand("/tmp/p/prompt.txt", "gpt-5.4", "high");
    expect(command).toContain(
      "codex -m 'gpt-5.4' -c model_reasoning_effort='high'"
    );
  });

  it("prefixes the agent env like the claude path", () => {
    const command = codexCommand("/tmp/p/prompt.txt", "default", "high", {
      VITEST_MAX_THREADS: "2",
    });
    expect(command.startsWith("env ")).toBe(true);
    expect(command).toContain("VITEST_MAX_THREADS='2'");
    expect(command).toContain(" codex -c model_reasoning_effort='high'");
  });
});

describe("agentCommand", () => {
  it("dispatches codex to codexCommand", () => {
    expect(agentCommand("codex", "/tmp/p/prompt.txt", "default", "high")).toBe(
      codexCommand("/tmp/p/prompt.txt", "default", "high")
    );
  });

  it("dispatches anything else (incl. claude) to claudeCommand", () => {
    expect(agentCommand("claude", "/tmp/p/prompt.txt", "default", "high")).toBe(
      claudeCommand("/tmp/p/prompt.txt", "default", "high")
    );
  });

  it("forwards the session name to claude and leaves codex unchanged", () => {
    expect(
      agentCommand(
        "claude",
        "/tmp/p/prompt.txt",
        "default",
        "high",
        {},
        "tig-1"
      )
    ).toBe(claudeCommand("/tmp/p/prompt.txt", "default", "high", {}, "tig-1"));
    expect(
      agentCommand("codex", "/tmp/p/prompt.txt", "default", "high", {}, "tig-1")
    ).toBe(codexCommand("/tmp/p/prompt.txt", "default", "high"));
  });
});

describe("formatCmuxUnreachable", () => {
  it("tells the driver to install only when cmux is missing from PATH", () => {
    expect(
      formatCmuxUnreachable({
        onPath: false,
        pingStderr: "",
        pingStdout: "",
      })
    ).toBe("cmux is not on PATH — run `captain install`");
  });

  it("relays ping stderr when the binary exists but the socket is down", () => {
    expect(
      formatCmuxUnreachable({
        onPath: true,
        pingStderr:
          "Error: Failed to connect to socket at /Users/me/.local/state/cmux/cmux.sock (Connection refused, errno 61)\n",
        pingStdout: "",
      })
    ).toContain("cmux.sock (Connection refused");
  });

  it("names Automation mode when cmuxOnly rejects the linear-god driver", () => {
    expect(
      formatCmuxUnreachable({
        onPath: true,
        pingStderr:
          "ERROR: Access denied - only processes started inside cmux can connect",
        pingStdout: "",
      })
    ).toMatch(/Socket Control Mode to Automation mode/u);
  });
});
