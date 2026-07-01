import { createHash } from "node:crypto";

import type { LinearIssue } from "./types";

// The verdict file the finishing protocol tells the agent to write, relative to
// the worktree root. The watcher polls this exact path (see captain/verdict.ts).
export const VERDICT_RELPATH = ".captain/verdict.json";
export const RUBRIC_RELPATH = ".captain/rubric.md";

// The rubric's integrity hash covers everything ABOVE this heading (the criteria
// and the verification procedure). The `## Verdict` section can't be covered —
// it embeds the hash itself — so splitting here keeps render and re-check in
// agreement without a second marker.
const VERDICT_HEADING = "\n## Verdict\n";

// Deterministic short id of the rubric body — long enough that forging it takes
// more effort than just running the verifier, short enough to copy by eye.
export const rubricHash = (body: string): string =>
  createHash("sha256").update(body).digest("hex").slice(0, 16);

// The hashable prefix of a full rubric text (everything above `## Verdict`).
// Splits on the LAST `## Verdict` (the real heading is always last — the fixed
// tail contains no `\n## Verdict\n`): the embedded issue description is verbatim
// and may itself contain a `## Verdict` line, and splitting on the first would
// truncate the hashed prefix → a permanent hash mismatch. Returns the whole text
// when the heading is missing (a hand-written rubric); hashing is then over the
// full file, which is still a stable identity.
export const rubricBody = (text: string): string => {
  const i = text.lastIndexOf(VERDICT_HEADING);
  return i === -1 ? text : text.slice(0, i);
};

const criteriaFor = (
  issue: LinearIssue | undefined,
  displayId: string,
  dataScope?: string
): string[] => {
  const criteria: string[] = [
    issue?.title
      ? `The diff implements: **${issue.title}** (the issue description below is the contract).`
      : `The diff implements Linear issue ${displayId}.`,
  ];
  for (const child of issue?.children?.nodes ?? []) {
    if (child.title) {
      criteria.push(`Sub-issue ${child.identifier}: ${child.title}.`);
    }
  }
  criteria.push(
    "Tests cover the changed behaviour, and the repo's test command passes.",
    "The repo's typecheck and lint commands pass.",
    `A PR is open with "${displayId}" in the title and a description that matches the diff.`
  );
  if (dataScope) {
    criteria.push(
      "The diff stays within the stated data-scope guardrail: no customer data, secrets, credentials, payment information, or PII is accessed, logged, or committed."
    );
  }
  return criteria;
};

// The per-worktree definition of done, written to `.captain/rubric.md` at
// fan-out. Mechanically derived from the Linear issue — captain makes no LLM
// call and does no summarising. The "How to verify" section is the fixed
// grading procedure (a fresh-context verifier sub-agent), so the verification
// standard is set by captain once, not improvised per agent.
export const renderRubric = (
  issue: LinearIssue | undefined,
  displayId: string,
  dataScope?: string
): { text: string; hash: string } => {
  let body = `# Definition of done — ${displayId}\n\n`;
  body +=
    "Captain wrote this file at fan-out. Do not edit it; your verdict must cite its hash.\n\n";

  body += "## Acceptance criteria\n\n";
  for (const [i, criterion] of criteriaFor(
    issue,
    displayId,
    dataScope
  ).entries()) {
    body += `${i + 1}. ${criterion}\n`;
  }
  if (issue?.description) {
    body += `\n### Issue description (the contract)\n\n${issue.description}\n`;
  }

  body += "\n## How to verify\n\n";
  body += [
    "Before you may declare this ticket done:",
    "",
    "1. Spawn a verifier sub-agent with a FRESH context (e.g. the Task/Agent tool). Give it ONLY this rubric file and the branch diff against the base branch (plus read access to the worktree). Do not share your own reasoning or summary of the work.",
    "2. The verifier grades each acceptance criterion pass/fail and must cite concrete evidence per criterion (file and line, or command output).",
    "3. If any criterion fails, fix the code, then re-run the verifier in another fresh context. Iterate until it passes.",
    "4. You may not write a pass verdict without a verifier run backing it.",
    "",
  ].join("\n");

  const hash = rubricHash(body);

  const schema = JSON.stringify(
    {
      criteria: [
        { evidence: "<file:line or command output>", name: "…", pass: true },
      ],
      issue: displayId,
      prUrl: "<the PR url, once opened>",
      rubricHash: hash,
      summary: "<one line>",
      ts: "<epoch seconds>",
      verdict: "pass | fail",
    },
    null,
    2
  );
  const tail = [
    `\nWhen the verifier passes (or fails on something you cannot fix), write \`${VERDICT_RELPATH}\` in this worktree (it is git-ignored):`,
    "",
    "```json",
    schema,
    "```",
    "",
    `\`rubricHash\` must be exactly \`${hash}\` — copy it verbatim.`,
    "",
  ].join("\n");

  // Concatenated, not joined: rubricBody splits at the exact VERDICT_HEADING
  // bytes, so nothing may sit between the body and the heading.
  return { hash, text: `${body}${VERDICT_HEADING}${tail}` };
};
