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
