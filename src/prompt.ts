import { DEFAULT_SKILLS } from "./config";
import { PLAN_RELPATH, REVIEW_RELPATH, RUBRIC_RELPATH } from "./rubric";
import type { Harness, Task } from "./task";

// The brief's opening: which task, and where its contract lives.
export const renderPrompt = (task: Pick<Task, "id" | "title">): string =>
  `Work on task ${task.id.toUpperCase()}${task.title ? `: ${task.title}` : ""}.\n\n` +
  `Read \`${RUBRIC_RELPATH}\` before planning: it is the complete authoritative ` +
  "task contract and your definition of done. Do not edit it.";

interface PromptExtras {
  // include the self-drive workflow section (every worker brief sets this;
  // there is no watcher — the agent drives its own pipeline end to end)
  workflow?: boolean;
  // the configured skills run between *implement* and the verifier/verdict
  // finish (empty/undefined → DEFAULT_SKILLS)
  skills?: string[];
  // worktree-relative path to the rubric `captain start` writes
  rubricPath?: string;
  // the injected excerpt of the project's memory file (empty → section omitted)
  memory?: string;
  // absolute path agents append end-of-run learnings to
  memoryPath?: string;
  // the data-scope guardrail (empty/undefined → section omitted)
  dataScope?: string;
  // which harness runs the brief. Only claude has AskUserQuestion; codex and
  // cursor print a blocking question and stop instead.
  harness?: Harness;
  // started in plan mode, waiting for a human to approve the plan (claude only).
  // An ungated brief must NOT tell the agent to wait for an approval that can
  // never arrive.
  gated?: boolean;
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
    // A step is either a `/skill` token or a plain-English instruction. Prose
    // renders verbatim — wrapping "If the diff touches UI, run /ui-design" in
    // "Run …." would produce an unreadable step and bury the condition.
    const skillSteps = skills.map((skill, i) =>
      skill.startsWith("/") ? `${i + 3}. Run ${skill}.` : `${i + 3}. ${skill}`
    );
    // The plan is the human's one cheap chance to redirect the run, so both
    // variants ask for the unknowns first: an ambiguity resolved at the gate
    // costs a sentence, the same ambiguity guessed wrong costs the whole run.
    const planLead =
      "Open it with a heading `## Decisions for the reviewer` and at most five bullets " +
      "covering what you are least sure of: any ambiguity in the ticket, the " +
      "assumptions you had to make, and the decisions a reviewer is most likely to " +
      "want changed. Mechanical work goes last. Never resolve an ambiguity silently. " +
      "Then name the files you will change, the order you will do the work in, and the " +
      "tests that will prove it.";
    // The plan stops being a throwaway here: it lands in the worktree next to the
    // rubric and the verdict, and one acceptance criterion grades the diff against
    // it. Both agents write it — the only difference is when they may (claude is in
    // plan mode until the gate clears, where it cannot write files at all).
    //
    // Deviations are APPENDED, never merged into the plan. `.captain/` is in the
    // repo's exclude file, so this artifact is in no commit and has no history: a
    // rewrite would silently erase what was approved, and there would be nothing
    // left for the criterion to compare the diff against.
    const planStep =
      `write the plan verbatim to \`${PLAN_RELPATH}\`, then implement it. If you end up ` +
      'deviating from it, append what changed and why under a "## Deviations" heading ' +
      "in that same file rather than rewriting the plan — the plan above it is the " +
      "record of what was approved, and a verifier grades the diff against both.";
    // Harness-aware: only claude has AskUserQuestion, and naming a tool the
    // agent cannot call while forbidding its only fallback leaves it no legal
    // move. A stopped agent is what captain reads as needing a human anyway, so
    // stopping IS the instruction for codex and cursor.
    const canAsk = (extras.harness ?? "claude") === "claude";
    const gated = canAsk && extras.gated === true;
    const blockedSteps = canAsk
      ? [
          "If you are ever blocked on a decision only a human can make, surface it via the",
          "AskUserQuestion tool and wait for the answer — never guess, and never just print the",
          "question to stdout and continue past it. Otherwise keep moving to the next step on your own.",
        ]
      : [
          "If you are ever blocked on a decision only a human can make, print the question and",
          "stop. Never guess and never continue past it — captain surfaces a stopped agent as",
          "needing input. Otherwise keep moving to the next step on your own.",
        ];
    const planSteps = gated
      ? [
          `1. Plan first (you are launched in plan mode) and present the plan for approval. ${planLead}`,
          `2. Once the plan is approved, ${planStep}`,
        ]
      : [
          `1. Plan first: write out a short plan of your approach before touching code. ${planLead}`,
          `2. Before you touch code, ${planStep} (This session has no plan-approval gate — do not stop to wait for one.)`,
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
      "Once the verdict is written, stop and wait. Captain sees the verdict on its next " +
      "`captain status`, has another vendor review the PR, and may send you review findings " +
      "or CI failures to fix: fix them, re-verify, and rewrite the verdict. Never merge the " +
      "PR or start other work yourself.\n";
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

// The brief for the cross-vendor reviewer: a different model family reads the
// PR cold and writes a pass/fail file the board reads. It never edits code, so
// a review can't quietly become a second implementation.
export const renderReviewPrompt = (
  task: Pick<Task, "id" | "title">,
  prUrl: string
): string =>
  [
    `Review the pull request for task ${task.id.toUpperCase()}${task.title ? `: ${task.title}` : ""}: ${prUrl}`,
    "",
    `You are the second reviewer, from a different model vendor than the author. Read \`${RUBRIC_RELPATH}\` (the contract) and \`${PLAN_RELPATH}\` if it exists, then the full diff (\`gh pr diff\`).`,
    "",
    "Do not edit, commit, or push anything. Your job is judgment, not implementation.",
    "",
    "Look for what would make you block the merge:",
    "- the diff does not do what the contract asks, or does more than it asks",
    "- a bug, a missing error path, a test that cannot fail, an invented API",
    "- a security or data-handling problem",
    "Ignore style nits a linter would catch.",
    "",
    `Then write \`${REVIEW_RELPATH}\` as JSON: {"verdict": "pass" | "fail", "summary": "<one line>", "findings": ["<file:line> <problem>", ...]}.`,
    "Fail only for findings that should block the merge. Also post the findings as one PR comment with `gh pr comment`.",
    "Then stop.",
  ].join("\n");
