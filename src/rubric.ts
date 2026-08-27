import { createHash } from "node:crypto";

import type { Issue } from "./types";

// The verdict file the finishing protocol tells the agent to write, relative to
// the worktree root. The watcher polls this exact path (see captain/verdict.ts).
export const VERDICT_RELPATH = ".captain/verdict.json";
export const RUBRIC_RELPATH = ".captain/rubric.md";
// The approved plan, written by the AGENT once the plan gate clears (captain
// never sees the plan text — claude presents it in plan mode, where it cannot
// write files, and captain only replies to the feed item). Git-ignored with the
// rest of `.captain/`, unlike the SDLC playbook's committed plan.md: captain's
// unit of work is a throwaway worktree, so committing it would put agent scratch
// in every PR diff. Its job is to bind implement→verify INSIDE the run.
export const PLAN_RELPATH = ".captain/plan.md";

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
  issue: Issue | undefined,
  displayId: string,
  dataScope?: string,
  source = "Linear"
): string[] => {
  let contract = `The diff implements the task **${displayId}**.`;
  if (issue?.title) {
    contract = `The diff implements: **${issue.title}** (the issue description in Issue context is the contract).`;
  } else if (issue) {
    contract = `The diff implements ${source} issue ${displayId}.`;
  }
  const criteria: string[] = [contract];
  for (const criterion of issue?.criteria ?? []) {
    if (criterion.title) {
      let text = criterion.ref
        ? `${criterion.title} (${criterion.ref}).`
        : `${criterion.title}.`;
      if (criterion.description) {
        text += `\n\n${criterion.description}`;
      }
      criteria.push(text);
    }
  }
  criteria.push(
    // The `na` condition here is MECHANICAL — the file is absent — never a
    // judgement the agent argues. That is what keeps this criterion from rotting
    // the way the test criterion did, where every agent invented its own
    // exemption. Phrased as a scan with output for the same reason the
    // data-scope criterion is: "the diff matches the plan" asserted in prose is
    // unevidencable, so it gets answered with conclusion-prose.
    `The diff does what \`${PLAN_RELPATH}\` says, or that file was updated in the same commit as the deviation. Evidence must be the plan's own steps set against the diff's files (e.g. \`git diff --stat <base>...HEAD\`), not a summary. Mark \`na\` only when \`${PLAN_RELPATH}\` does not exist.`,
    "The repo's test command passes. Add tests only where the change genuinely warrants coverage — do not add tests for trivial copy/label/config changes.",
    "The repo's typecheck and lint commands pass.",
    `A PR is open with "${displayId}" in the title and a description that matches the diff.`
  );
  if (dataScope) {
    // Phrased as a scan with output, not as a negative to be asserted. The old
    // wording ("no PII is accessed") is unevidencable from a diff, so verdicts
    // answered it with conclusion-prose; a grep over the diff is a real artifact.
    criteria.push(
      "The diff introduces no customer data, secret, credential, payment detail, or PII. Evidence must be a scan you ran over the diff (e.g. `git diff <base>...HEAD | grep -niE 'secret|token|password|api[_-]?key|bearer'`) plus its output, not an assertion."
    );
  }
  return criteria;
};

const renderParentContext = (parent: Issue["parent"]): string => {
  if (!parent) {
    return "";
  }
  const ref = parent.ref ? ` (${parent.ref})` : "";
  let context = `\n### Parent issue\n\n${parent.title}${ref}\n`;
  if (parent.description) {
    context += `\n${parent.description}\n`;
  }
  return context;
};

const renderIssueContext = (
  issue: Issue | undefined,
  displayId: string,
  source: string
): string => {
  let context = "## Issue context\n\n";
  context += `- Source: ${source}\n`;
  context += `- Identifier: ${issue?.identifier ?? displayId}\n`;
  if (issue?.title) {
    context += `- Title: ${issue.title}\n`;
  }
  if (issue?.team?.name) {
    context += `- Team: ${issue.team.name}\n`;
  }
  if (issue?.project?.name) {
    context += `- Project: ${issue.project.name}\n`;
  }
  const labels = (issue?.labels?.nodes ?? [])
    .map((label) => label.name)
    .filter((name): name is string => Boolean(name));
  if (labels.length > 0) {
    context += `- Labels: ${labels.join(", ")}\n`;
  }
  context += renderParentContext(issue?.parent);
  if (issue?.description) {
    context += `\n### Issue description (the contract)\n\n${issue.description}\n`;
  }
  return context;
};

// The per-run definition of done, written to `.captain/rubric.md` for issue
// fan-out and free-form dispatch. Mechanically derived from the source-neutral
// issue/task contract — captain makes no LLM call and does no summarising. The "How to verify" section is the fixed
// grading procedure (a fresh-context verifier sub-agent), so the verification
// standard is set by captain once, not improvised per agent.
export const renderRubric = (
  issue: Issue | undefined,
  displayId: string,
  dataScope?: string,
  source = "Linear"
): { text: string; hash: string } => {
  let body = `# Definition of done — ${displayId}\n\n`;
  body +=
    "Captain wrote this file at fan-out. Do not edit it; your verdict must cite its hash.\n\n";

  body += renderIssueContext(issue, displayId, source);

  body += "\n## Acceptance criteria\n\n";
  for (const [i, criterion] of criteriaFor(
    issue,
    displayId,
    dataScope,
    source
  ).entries()) {
    body += `${i + 1}. ${criterion.replaceAll("\n", "\n   ")}\n`;
  }

  body += "\n## How to verify\n\n";
  body += [
    "Before you may declare this ticket done:",
    "",
    `1. Spawn a verifier sub-agent with a FRESH context (e.g. the Task/Agent tool). Give it ONLY this rubric file, \`${PLAN_RELPATH}\` if it exists, and the branch diff against the base branch (plus read access to the worktree). Do not share your own reasoning or summary of the work.`,
    "2. The verifier grades every acceptance criterion above, in order, and must cite concrete evidence per criterion (file and line, or command output).",
    "3. Prefer a mechanical referee to your own reading. Where a criterion names a command, run the repo's own command — not a hand-picked subset of test files — and quote it with its exit code or summary line. CI status (`gh pr checks`) beats anything run locally; cite it once the PR is open.",
    "4. If a criterion genuinely cannot apply to this diff, mark it `na` with the reason as its evidence. Do NOT reword the criterion to something you can pass, and do not pass it on an exemption argument — `na` is the honest answer and captain surfaces it as one.",
    "5. If any criterion fails, fix the code, then re-run the verifier in another fresh context. Iterate until it passes.",
    "6. You may not write a pass verdict without a verifier run backing it.",
    "",
  ].join("\n");

  const hash = rubricHash(body);

  const schema = JSON.stringify(
    {
      criteria: [
        {
          evidence: "<file:line, or the command you ran and its output>",
          na: false,
          name: "<the criterion's number and text, copied verbatim>",
          pass: true,
        },
      ],
      issue: displayId,
      prUrl: "<the PR url, once opened>",
      rubricHash: hash,
      summary: "<one line>",
      // Left as a descriptive placeholder like every other field: parseVerdict
      // accepts an epoch as a number OR a quoted integer, so there is no type to
      // teach here and no third way to get it wrong.
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
    "One entry per acceptance criterion above, in the same order.",
    "",
    `- \`rubricHash\` must be exactly \`${hash}\` — copy it verbatim.`,
    "- `name` must be the criterion's number and text copied verbatim. Rewording a criterion to a bar you can clear reads as a pass on the criterion you were actually given — use `na`, or fail it.",
    "- `na: true` means the criterion cannot apply to this diff (put the reason in `evidence`). It is not a pass and not a failure; `pass` is ignored.",
    "",
  ].join("\n");

  // Concatenated, not joined: rubricBody splits at the exact VERDICT_HEADING
  // bytes, so nothing may sit between the body and the heading.
  return { hash, text: `${body}${VERDICT_HEADING}${tail}` };
};
