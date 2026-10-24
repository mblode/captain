import { DEFAULT_SKILLS } from "./config";
import {
  PLAN_RELPATH,
  REVIEW_RELPATH,
  RUBRIC_RELPATH,
  statePaths,
} from "./rubric";
import type { Shared } from "./rubric";
import type { Harness, Task } from "./task";

// The brief's opening: which task, and where its contract lives.
export const renderPrompt = (
  task: Pick<Task, "id" | "title">,
  rubricPath = RUBRIC_RELPATH
): string =>
  `Work on task ${task.id.toUpperCase()}${task.title ? `: ${task.title}` : ""}.\n\n` +
  `Read \`${rubricPath}\` before planning: it is the complete authoritative ` +
  "task contract and your definition of done. Do not edit it.";

// Shared-checkout runs finish by pushing to the branch, so the PR steps of the
// skill pipeline have nothing to act on.
const PR_STEP = /\/pr-(creator|babysitter)\b/u;

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
  // the run shares the repo's checkout and branch with other workers (see
  // sharedSection), and `id` tags its commits
  shared?: Shared;
  id?: string;
  // the OpenSpec home the task's change lives in, when it came from one: the
  // worker ticks its boxes there and archives it after the smoke test passes
  openspecHome?: string;
}

// How a worker shares one checkout and one branch with the rest of the fleet.
// The index is shared too, so a plain `git commit` would sweep up whatever
// another worker staged; `git commit -- <paths>` commits only the named paths.
const sharedSection = (
  shared: Shared,
  id: string,
  home: string | undefined
): string => {
  const changeLines = home
    ? [
        `- Tick the boxes in \`${home}/openspec/changes/${id}/tasks.md\` as you finish each one. That`,
        "  file lives outside this repo and is never committed. Run every `openspec` command from",
        `  \`${home}\` (\`cd\` there first).`,
      ]
    : [];
  return [
    "",
    "<shared-branch>",
    `There is no worktree and no new branch. You work directly on \`${shared.branch}\` in this`,
    "checkout, alongside other workers on other tasks in the same file tree.",
    "",
    "- Never create, switch, or reset branches. Never run `git stash`, `git reset`,",
    "  `git checkout -- .`, `git clean`, or `git add -A`/`git add .`: they touch other workers' files.",
    "- Touch only the files your task needs. A failing check in an untouched file is not",
    "  proof of another worker's mistake. Compare with clean HEAD when check policy allows,",
    "  report the evidence, and leave other workers' changes alone.",
    `- Commit only your own paths: \`git add <new files>\` then \`git commit -m "[${id}] <summary>" -- <paths>\`.`,
    `  Every commit message starts with \`[${id}]\`; the verifier finds your work by that tag.`,
    `- Push after each commit when authorized: \`git push origin ${shared.branch}\`. If rejected,`,
    "  fetch and inspect the remote changes. Coordinate with other workers before one merge",
    `  of \`origin/${shared.branch}\` into a clean checkout; never rebase, autostash or force-push.`,
    "  If the checkout is dirty or the merge conflicts, surface the blocker. If git reports an",
    "  `index.lock`, wait a few seconds and retry: another worker is committing.",
    `- Never stage or commit an \`openspec/\` path${home ? ` or anything under \`${home}\`` : ""}, or anything under \`.captain/\`.`,
    ...changeLines,
    "</shared-branch>",
    "",
  ].join("\n");
};

// What a shared-checkout run does after its passing verdict: done means
// verified in production, not merged. The worker waits on the human merge
// (captain never merges and runs no daemon, so the wait is the worker's own
// background poll), watches the deploy, runs the smoke checks, and archives its
// OpenSpec change only on a pass, outside the repo, so nothing is committed.
const productionSteps = (
  shared: Shared,
  id: string,
  home: string | undefined
): string => {
  const { smoke } = statePaths(shared);
  const archive = home
    ? `6. On a pass, run \`openspec archive ${id} --yes\` from \`${home}\`. It changes files outside this repo: commit nothing. On a fail, do not archive and do not revert: stop for the human.`
    : "6. On a fail, do not revert: stop for the human.";
  return [
    "A passing verdict is not done: done means verified in production. After the verdict, keep going:",
    `1. Wait for the human merge. Never merge, and never open further work yourself. Poll in the background (a backgrounded shell loop, not a foreground sleep) until a merged PR's head contains your last \`[${id}]\` commit. On a long-lived shared branch the newest merged PR can be an older one, and a squash or rebase merge rewrites your commits, so test the PR's head, never the merge SHA: \`until read -r n st head sha < <(gh pr view ${shared.branch} --json number,state,headRefOid,mergeCommit -q '[.number, .state, .headRefOid, .mergeCommit.oid] | @tsv' 2>/dev/null) && { [ "$st" = CLOSED ] || { [ "$st" = MERGED ] && git fetch -q origin "refs/pull/$n/head" && git merge-base --is-ancestor <your last [${id}] commit> "$head"; }; }; do sleep 120; done; echo "$st $sha"\`. On \`MERGED\`, the SHA it prints is the merge SHA. On \`CLOSED\`, the PR was closed without merging: stop.`,
    `2. Write \`${smoke}\` with \`"status": "running"\` and the merge SHA, in the rubric's "Smoke test" shape, so \`captain status\` shows the task as shipping.`,
    "3. Watch the deploy: poll `gh api repos/{owner}/{repo}/commits/<merge sha>/statuses` until every `watch/*` context is `success`, or follow the repo's documented deploy check (AGENTS.md, README). A failed deploy is a failed smoke test.",
    `4. Run every check in the rubric's "Smoke test" section in production (terminal and browser, as listed), read-only unless a step names a reversible write, and inside the data scope.`,
    `5. Rewrite \`${smoke}\` with \`"status": "pass"\` or \`"fail"\` and the evidence for every check.`,
    archive,
    "Then stop.",
  ].join("\n");
};

// The sections appended after the issue context: the self-drive workflow (the
// agent owns the whole SDLC — captain only dispatches and surfaces), the
// finishing protocol (the rubric is the definition of done; a fresh-context
// verifier must pass before the verdict is written) and the fleet memory
// (consult before re-deriving; append only what this run verified). Pure and
// additive — with no extras the prompt is byte-identical to renderPrompt.
export const renderPromptExtras = (extras: PromptExtras): string => {
  let out = "";

  if (extras.workflow) {
    const configured =
      extras.skills && extras.skills.length > 0
        ? extras.skills
        : DEFAULT_SKILLS;
    const skills = extras.shared
      ? configured.filter((skill) => !PR_STEP.test(skill))
      : configured;
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
    const canAsk = (extras.harness ?? "claude") === "claude";
    const gated = canAsk && extras.gated === true;
    // Both variants put the unknowns first. Behind the gate the plan is the
    // human's one cheap chance to redirect the run: an ambiguity resolved there
    // costs a sentence, the same ambiguity guessed wrong costs the whole run.
    // Ungated, nobody reads the plan before the work starts, so each unknown
    // records the choice made: the reviewer can still see and reverse it, and
    // the agent keeps moving instead of stalling on a decision it can defend.
    const planTail =
      "Mechanical work goes last. Then name the files you will change, the order you " +
      "will do the work in, and the tests that will prove it.";
    const planLead = gated
      ? "Open it with a heading `## Decisions for the reviewer` and at most five bullets " +
        "covering what you are least sure of: any ambiguity in the ticket, the " +
        "assumptions you had to make, and the decisions a reviewer is most likely to " +
        `want changed. Never resolve an ambiguity silently. ${planTail}`
      : "Open it with a heading `## Decisions for the reviewer` and at most five bullets, " +
        "one per thing you are least sure of: the ambiguity or assumption, the option you " +
        "chose, and why. Choose the option the ticket and the codebase support best; only " +
        "ask a human when no option is defensible. Never resolve an ambiguity silently. " +
        `${planTail} Keep it short: nobody approves it before you start.`;
    const planPath = statePaths(extras.shared).plan;
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
      `write the plan verbatim to \`${planPath}\`, then implement it. If you end up ` +
      'deviating from it, append what changed and why under a "## Deviations" heading ' +
      "in that same file rather than rewriting the plan — the plan above it is the " +
      "record of what was approved, and a verifier grades the diff against both.";
    // Harness-aware: only claude has AskUserQuestion, and naming a tool the
    // agent cannot call while forbidding its only fallback leaves it no legal
    // move. A stopped agent is what captain reads as needing a human anyway, so
    // stopping IS the instruction for codex and cursor.
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
      "Before implementation, resolve the applicable skills from the installed skill catalog.",
      "If a required skill is missing, surface that blocker instead of inventing its instructions.",
      "For browser QA, check the dev port with `lsof -i :<port>`, load the target route, and",
      "confirm authentication before changing code. Request any needed sign-in code up front.",
      "",
      "Load only the references needed for the current step. Give subagents a bounded",
      "question, relevant paths and a done condition, not the whole conversation.",
      "Keep command logs in files and report relevant excerpts with exit codes.",
      "Reuse evidence for unchanged inputs; follow the user's and repository's policy",
      "on when tests may run. Required CI and current-revision gates still apply.",
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

  if (extras.shared && extras.id) {
    out += sharedSection(extras.shared, extras.id, extras.openspecHome);
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
      "fix defects within scope and re-verify changed evidence, then write the verdict file exactly as the " +
      'rubric\'s "Verdict" section specifies. Captain will not mark this ' +
      `${extras.shared ? "task" : "worktree PR-"}ready without a passing verdict.\n`;
    out +=
      "If a criterion is blocked by external state or conflicts with the task's scope, " +
      "record the failing evidence and surface the blocker. Do not repeat an unchanged " +
      "verifier run or widen the task to manufacture a pass.\n";
    out +=
      extras.shared && extras.id
        ? `${productionSteps(extras.shared, extras.id, extras.openspecHome)}\n`
        : "Once the verdict is written, stop and wait. Captain sees the verdict on its next " +
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
