import { DEFAULT_SKILLS } from "./config";
import type { LinearIssue, LinearRelatedIssue } from "./types";

const renderRelatedIssue = (
  tag: "parent-issue" | "sub-issue",
  issue: LinearRelatedIssue
): string => {
  let output = `<${tag} identifier="${issue.identifier}">\n`;
  output += `<id>${issue.id ?? ""}</id>\n`;
  output += `<title>${issue.title ?? ""}</title>\n`;
  if (issue.description) {
    output += `<description>\n${issue.description}\n</description>\n`;
  }
  output += `</${tag}>\n`;
  return output;
};

export const renderPrompt = (
  issue: LinearIssue | undefined,
  displayId: string
): string => {
  if (!issue) {
    return `Work on Linear issue ${displayId}.`;
  }

  let prompt = `Work on Linear issue ${issue.identifier}:\n\n`;
  prompt += `<issue identifier="${issue.identifier}">\n`;
  prompt += `<title>${issue.title ?? ""}</title>\n`;

  if (issue.description) {
    prompt += `<description>\n${issue.description}\n</description>\n`;
  }

  if (issue.team) {
    prompt += `<team name="${issue.team.name ?? ""}"/>\n`;
  }

  for (const label of issue.labels?.nodes ?? []) {
    prompt += `<label>${label.name ?? ""}</label>\n`;
  }

  if (issue.project) {
    prompt += `<project name="${issue.project.name ?? ""}"/>\n`;
  }

  if (issue.parent) {
    prompt += renderRelatedIssue("parent-issue", issue.parent);
  }

  const children = issue.children?.nodes ?? [];
  if (children.length > 0) {
    prompt += "<sub-issues>\n";
    for (const child of children) {
      prompt += renderRelatedIssue("sub-issue", child);
    }
    prompt += "</sub-issues>\n";
  }

  prompt += "</issue>\n";
  return prompt;
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
    // are data-driven.
    const skillSteps = skills.map((skill, i) => `${i + 3}. Run ${skill}.`);
    out += "\n<workflow>\n";
    out += [
      "You own this ticket end to end. Drive the whole pipeline yourself, in order,",
      "without waiting to be told to continue:",
      "",
      "1. Plan first (you are launched in plan mode) and present the plan for approval.",
      "2. Once the plan is approved, implement it.",
      ...skillSteps,
      `${skills.length + 3}. Finish with the finishing protocol below (verifier + verdict).`,
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
      `At the end of your run, append 1-3 distilled learnings to ${extras.memoryPath} ` +
      'under its "## Inbox" heading, each as `- [<TICKET> <YYYY-MM-DD>] <general rule>`, ' +
      "using a single `cat >> … <<'EOF'` command. Only write general rules you actually " +
      "VERIFIED this run (something you confirmed, not something you guessed); skip the " +
      "section entirely if nothing qualifies.\n";
    out += "</fleet-memory>\n";
  }

  return out;
};
