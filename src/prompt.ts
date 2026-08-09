import { DEFAULT_SKILLS } from "./config";
import { RUBRIC_RELPATH } from "./rubric";
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
    `Read \`${RUBRIC_RELPATH}\` before planning: it is the complete authoritative ` +
    "issue contract and your definition of done. Do not edit it."
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
    // The plan is the human's one cheap chance to redirect the run, so both
    // variants ask for the unknowns first: an ambiguity resolved at the gate
    // costs a sentence, the same ambiguity guessed wrong costs the whole run.
    const planLead =
      "Lead it with what you are least sure of: any ambiguity in the ticket, the " +
      "assumptions you had to make, and the decisions a reviewer is most likely to " +
      "want changed. Mechanical work goes last. Never resolve an ambiguity silently.";
    // Agent-aware, same as the plan steps: codex has no AskUserQuestion, and
    // naming a tool it cannot call while forbidding its only fallback leaves it
    // no legal move. A stopped codex agent is what captain reads as needing a
    // human anyway, so stopping IS the instruction there.
    const blockedSteps =
      extras.agent === "codex"
        ? [
            "If you are ever blocked on a decision only a human can make, print the question and",
            "stop. Never guess and never continue past it — captain surfaces a stopped agent as",
            "needing input. Otherwise keep moving to the next step on your own.",
          ]
        : [
            "If you are ever blocked on a decision only a human can make, surface it via the",
            "AskUserQuestion tool and wait for the answer — never guess, and never just print the",
            "question to stdout and continue past it. Otherwise keep moving to the next step on your own.",
          ];
    const planSteps =
      extras.agent === "codex"
        ? [
            `1. Plan first: write out a short plan of your approach before touching code. ${planLead}`,
            "2. Implement the plan. (This session has no plan-approval gate — do not stop to wait for one.)",
          ]
        : [
            `1. Plan first (you are launched in plan mode) and present the plan for approval. ${planLead}`,
            "2. Once the plan is approved, implement it.",
          ];
    // Claude Code ≥2.1.224 can SendMessage other local sessions (roster answers
    // to the --name captain pins at launch). Optional breakage warnings only —
    // never a coordination/approval channel; codex has no equivalent tool.
    const peerWarnSteps =
      extras.agent === "codex"
        ? []
        : [
            "",
            "If you land a change that breaks another in-flight captain worktree on this",
            "machine, you may SendMessage that session (address it by its ticket slug) a",
            "short warning. Do not wait on peers, do not use messaging for approval or",
            "steering, and do not block your own pipeline on a reply.",
          ];
    out += "\n<workflow>\n";
    out += [
      "You own this ticket end to end: drive every step yourself, in order. The only",
      "stops are the ones named in this brief — nobody will tell you to continue.",
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
      ...peerWarnSteps,
      "",
      ...blockedSteps,
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
    out +=
      `Before declaring the ticket done, follow ${extras.rubricPath}'s "How to verify" section: spawn a ` +
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
    // One test ("would this change what the next agent DOES here?") plus the one
    // failure mode worth naming. The previous wording spent a paragraph on a
    // two-branch eligibility test and a mandated `grep -Fq` dedupe; measured over
    // 685 real bullets the dedupe never fired (every bullet is fresh prose, so
    // fixed-string matching cannot see a paraphrase) and 45% of output was still
    // "X lives in Y" topography. The length cap is the constraint that pays.
    out +=
      `At the end of your run you may append ONE learning to ${extras.memoryPath} under its ` +
      '"## Inbox" heading, as `- [<TICKET> <YYYY-MM-DD>] <rule>`, at most 200 characters. ' +
      "Append only something that would change what the next agent DOES in this repo: a " +
      "command or environment trap you hit, or the root cause of a verifier failure. Where " +
      'code lives is not a learning — "X is implemented in Y" helps nobody. If nothing ' +
      "qualifies, or the rules above already cover it, write nothing. Append without reading " +
      "the file into context.\n";
    out += "</fleet-memory>\n";
  }

  return out;
};
