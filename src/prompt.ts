import { DEFAULT_SKILLS } from "./config";
import type { Issue } from "./types";

export const renderPrompt = (
  issue: Issue | undefined,
  displayId: string,
  // the issue source, for the brief's opening line (Linear or donebear). The
  // rest of the context is source-agnostic — every source maps into the neutral
  // Issue shape upstream (linear.ts / donebear.ts).
  source = "Linear"
): string => {
  const identifier = issue?.identifier ?? displayId;
  const title = issue?.title ? `: ${issue.title}` : "";
  return (
    `Work on ${source} issue ${identifier}${title}.\n\n` +
    "Read `.captain/rubric.md` before planning; it is the complete authoritative " +
    "issue contract and definition of done."
  );
};

export interface PromptExtras {
  // include the self-drive workflow section (fan-out briefs set this; Captain
  // has no watcher — the agent drives its own pipeline end to end)
  workflow?: boolean;
  // the configured skills run between *implement* and the verifier/verdict
  // finish (empty/undefined → DEFAULT_SKILLS)
  skills?: string[];
  // worktree-relative path to the rubric written at fan-out
  rubricPath?: string;
  // the injected excerpt of the per-repo memory file (empty → section omitted)
  memory?: string;
  // absolute path agents append end-of-run learnings to
  memoryPath?: string;
  // the data-scope guardrail (empty/undefined → section omitted)
  dataScope?: string;
  // which agent the brief launches on. claude (default) is gated: it starts in
  // plan mode and waits for plan approval. codex has no plan mode/gate, so its
  // plan step must NOT tell it to wait for an approval that can never arrive.
  agent?: string;
}

// The sections appended after the issue context: the self-drive workflow (the
// agent owns the whole SDLC — captain only dispatches and surfaces), the
// finishing protocol (the rubric is the definition of done; a fresh-context
// verifier must pass before the verdict is written) and the fleet memory
// (consult before re-deriving; append only what this run verified). Pure and
// additive — with no extras the prompt is byte-identical to renderPrompt.
export const renderPromptExtras = (extras: PromptExtras): string => {
  let out = "";

  if (extras.workflow) {
    const skills =
      extras.skills && extras.skills.length > 0
        ? extras.skills
        : DEFAULT_SKILLS;
    // Fixed scaffold: plan + implement are steps 1-2, the configured skills run
    // next (one numbered step each), then the verifier/verdict finish. Captain's
    // status derives from the plan gate and verdict, so only the middle steps
    // are data-driven. The plan step's wording is agent-aware: telling codex to
    // wait for a plan approval would stall it forever (no gate exists).
    const skillSteps = skills.map((skill, i) => `${i + 3}. Run ${skill}.`);
    const planSteps =
      extras.agent === "codex"
        ? [
            "1. Plan first: write out a short plan of your approach before touching code.",
            "2. Implement the plan. (This session has no plan-approval gate — do not stop to wait for one.)",
          ]
        : [
            "1. Plan first (you are launched in plan mode) and present the plan for approval.",
            "2. Once the plan is approved, implement it.",
          ];
    out += "\n<workflow>\n";
    out += [
      "You own this ticket end to end. Drive the whole pipeline yourself, in order,",
      "without waiting to be told to continue:",
      "",
      ...planSteps,
      ...skillSteps,
      `${skills.length + 3}. Finish with the finishing protocol below (verifier + verdict).`,
      "",
      "You share this machine with the rest of the fleet. Bound the parallelism of every",
      "heavy command you run: pass `--maxWorkers=2` (or the repo's equivalent) to jest/vitest",
      "suites, and never launch more than one full test suite or typecheck at a time —",
      "uncapped worker pools across concurrent agents have exhausted system memory and",
      "gotten the whole fleet killed.",
      "",
      "If you are ever blocked on a decision only a human can make, surface it via the",
      "AskUserQuestion tool and wait for the answer — never guess, and never just print the",
      "question to stdout and continue past it. Otherwise keep moving to the next step on your own.",
    ].join("\n");
    out += "\n</workflow>\n";
  }

  if (extras.dataScope) {
    out += "\n<data-scope>\n";
    out += `${extras.dataScope}\n`;
    out += "</data-scope>\n";
  }

  if (extras.rubricPath) {
    out += "\n<finishing-protocol>\n";
    out += `${extras.rubricPath} in this worktree is your definition of done — do not edit it.\n`;
    out +=
      'Before declaring the ticket done, follow its "How to verify" section: spawn a ' +
      "fresh-context verifier sub-agent to grade the diff against the acceptance criteria, " +
      "fix and re-verify until it passes, then write the verdict file exactly as the " +
      'rubric\'s "Verdict" section specifies. Captain will not mark this worktree ' +
      "PR-ready without a passing verdict.\n";
    out +=
      "Once the verdict is written your work on this ticket is complete — stop and wait; the " +
      "captain driver sees the verdict on its next `captain status` and owns the merge decision. " +
      "Do not merge or open further work yourself.\n";
    out += "</finishing-protocol>\n";
  }

  if (extras.memoryPath) {
    out += "\n<fleet-memory>\n";
    if (extras.memory) {
      out += `Learnings from previous runs on this repo — consult these before re-deriving repo facts:\n\n${extras.memory}\n\n`;
    }
    out +=
      `At the end of your run, append zero or one learning to ${extras.memoryPath} under ` +
      'its "## Inbox" heading as `- [<TICKET> <YYYY-MM-DD>] <general rule>`. The whole ' +
      "bullet must be at most 200 characters. Write one only for either (a) the root cause " +
      "of a verifier failure that an eventual pass confirmed, or (b) a repo command or " +
      "environment trap you directly confirmed. Before appending, use a non-printing " +
      `fixed-string search (\`grep -Fq\`) against ${extras.memoryPath}; skip the write if ` +
      "the exact general-rule text already appears. Do not print or read the whole file into " +
      "context. Otherwise write nothing; ordinary implementation facts do not qualify.\n";
    out += "</fleet-memory>\n";
  }

  return out;
};
