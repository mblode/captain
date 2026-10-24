import { describe, expect, it } from "vitest";

import { formatCmuxUnreachable, harnessCommand } from "./cmux";
import type { LaunchSpec } from "./cmux";

const spec = (over: Partial<LaunchSpec> = {}): LaunchSpec => ({
  bin: "claude",
  effort: "high",
  env: {},
  gated: false,
  harness: "claude",
  model: "default",
  promptPath: "/tmp/p/brief.md",
  ...over,
});

describe("harnessCommand", () => {
  it("starts a gated claude task in plan mode, bypass reachable after approval", () => {
    expect(harnessCommand(spec({ gated: true, name: "t-1-billing" }))).toBe(
      `claude --name 't-1-billing' --effort 'high' --permission-mode plan --allow-dangerously-skip-permissions "$(cat '/tmp/p/brief.md')"`
    );
  });

  it("runs an ungated claude task unattended from the start", () => {
    const command = harnessCommand(spec());
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).not.toContain("--permission-mode plan");
  });

  it("passes a concrete model and omits the 'default' sentinel", () => {
    expect(harnessCommand(spec({ model: "claude-opus-5-5[1m]" }))).toContain(
      "--model 'claude-opus-5-5[1m]'"
    );
    expect(harnessCommand(spec())).not.toContain("--model");
  });

  it("launches codex with -m, reasoning effort and no sandbox", () => {
    expect(
      harnessCommand(
        spec({
          bin: "codex",
          effort: "medium",
          harness: "codex",
          model: "gpt-6-sol",
        })
      )
    ).toBe(
      `codex -m 'gpt-6-sol' -c model_reasoning_effort='medium' --dangerously-bypass-approvals-and-sandbox "$(cat '/tmp/p/brief.md')"`
    );
  });

  it("launches the Cursor CLI with --force and no effort flag", () => {
    const command = harnessCommand(
      spec({ bin: "agent", harness: "cursor", model: "grok-4.7-fast" })
    );
    expect(command).toBe(
      `agent --model 'grok-4.7-fast' --force "$(cat '/tmp/p/brief.md')"`
    );
  });

  it("prefixes the agent env, shell-quoted, so every tool inherits it", () => {
    const command = harnessCommand(
      spec({
        env: {
          CAPTAIN_SLOT: "2",
          NODE_OPTIONS: "--max-old-space-size=3072 --x",
        },
      })
    );
    expect(command.startsWith("env ")).toBe(true);
    expect(command).toContain("CAPTAIN_SLOT='2'");
    expect(command).toContain("NODE_OPTIONS='--max-old-space-size=3072 --x'");
  });

  it("runs the project bootstrap first and only starts the agent if it passes", () => {
    const command = harnessCommand(spec({ bootstrap: "npm ci" }));
    expect(command.startsWith("(npm ci) && ")).toBe(true);
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

  it("names Automation mode when cmuxOnly rejects a chat outside cmux", () => {
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
