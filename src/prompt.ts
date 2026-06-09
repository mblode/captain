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
  // worktree-relative path to the rubric written at fan-out
  rubricPath?: string;
  // the injected excerpt of the per-repo memory file (empty → section omitted)
  memory?: string;
  // absolute path agents append end-of-run learnings to
  memoryPath?: string;
}

// The two loop-closing sections appended after the issue context: the finishing
// protocol (the rubric is the definition of done; a fresh-context verifier must
// pass before the verdict is written) and the fleet memory (consult before
// re-deriving; append only what this run verified). Pure and additive — with no
// extras the fan-out prompt is byte-identical to the plain renderPrompt output.
export const renderPromptExtras = (extras: PromptExtras): string => {
  let out = "";

  if (extras.rubricPath) {
    out += "\n<finishing-protocol>\n";
    out += `${extras.rubricPath} in this worktree is your definition of done — do not edit it.\n`;
    out +=
      'Before declaring the ticket done, follow its "How to verify" section: spawn a ' +
      "fresh-context verifier sub-agent to grade the diff against the acceptance criteria, " +
      "fix and re-verify until it passes, then write the verdict file exactly as the " +
      'rubric\'s "Verdict" section specifies. Captain will not mark this worktree ' +
      "PR-ready without a passing verdict.\n";
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
