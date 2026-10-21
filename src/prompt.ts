import { DEFAULT_SKILLS } from "./config";
import { RUBRIC_RELPATH, statePaths } from "./rubric";
import type { SharedBranch } from "./rubric";
import type { Issue } from "./types";

export const renderPrompt = (
  issue: Issue | undefined,
  displayId: string,
  // the issue source, for the brief's opening line (Linear or donebear). The
  // rest of the context is source-agnostic — every source maps into the neutral
  // Issue shape upstream (linear.ts / donebear.ts).
  source = "Linear",
  rubricPath = RUBRIC_RELPATH
): string => {
  const identifier = issue?.identifier ?? displayId;
  const title = issue?.title ? `: ${issue.title}` : "";
  return (
    `Work on ${source} issue ${identifier}${title}.\n\n` +
    `Read \`${rubricPath}\` before planning: it is the complete authoritative ` +
    "issue contract and your definition of done. Do not edit it."
  );
};

interface PromptExtras {
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
  // an OpenSpec change run in the shared checkout: per-change plan path, and
  // commit-and-push to the branch instead of a PR
  shared?: SharedBranch;
  // the OpenSpec change id, for commit tags and its tasks.md
  sharedId?: string;
  // where the change lives: the dir holding its `openspec/` (run `openspec`
  // there), and whether that is the user's home outside the repo (external) or
  // the repo's own team copy
  openspec?: { home: string; external: boolean };
}

type OpenspecPlace = NonNullable<PromptExtras["openspec"]>;

// How an agent shares one checkout and one branch with the rest of the fleet.
// The index is shared too, so a plain `git commit` would sweep up whatever
// another agent staged; `git commit -- <paths>` commits only the named paths.
const sharedBranchSection = (
  shared: SharedBranch,
  id: string,
  place: OpenspecPlace | undefined
): string => {
  const tasks = place
    ? `${place.home}/openspec/changes/${id}/tasks.md`
    : `openspec/changes/${id}/tasks.md`;
  const changeLines = place?.external
    ? [
        `- Tick the boxes in \`${tasks}\` as you finish each task. That file lives outside this`,
        "  repo and is never committed. Run every `openspec` command from",
        `  \`${place.home}\` (\`cd\` there first).`,
      ]
    : [
        `- \`openspec/changes/${id}/\` is the team's copy in this repo: read it, but do not edit,`,
        "  tick or archive it.",
      ];
  return [
    "",
    "<shared-branch>",
    `There is no worktree and no new branch. You work directly on \`${shared.branch}\` in this`,
    "checkout, alongside other agents working on other changes in the same file tree.",
    "",
    "- Never create, switch, or reset branches. Never run `git stash`, `git reset`,",
    "  `git checkout -- .`, `git clean`, or `git add -A`/`git add .` — they touch other agents' work.",
    "- Touch only the files your change needs. A failing test or lint error in a file you did",
    "  not touch belongs to another agent in flight: leave it, and say so in your verdict evidence.",
    `- Commit only your own paths: \`git add <new files>\` then \`git commit -m "[${id}] <summary>" -- <paths>\`.`,
    `  Every commit message starts with \`[${id}]\`; the verifier finds your work by that tag.`,
    `- Push after each commit: \`git push origin ${shared.branch}\`. If the push is rejected, run`,
    `  \`git pull --rebase --autostash origin ${shared.branch}\` and push again. If git reports an`,
    "  `index.lock`, wait a few seconds and retry — another agent is committing.",
    `- Never stage or commit an \`openspec/\` path${place?.external ? ` or anything under \`${place.home}\`` : ""}: OpenSpec`,
    "  files are never part of a commit.",
    ...changeLines,
    "</shared-branch>",
    "",
  ].join("\n");
};

// What a shared-branch run does after its passing verdict: done means verified
// in production, not merged. The worker waits on the human merge (captain never
// merges and runs no daemon, so the wait is the worker's own background poll),
// watches the deploy, runs the rubric's smoke checks, and archives the change
// only on a pass — outside the repo, so nothing is committed.
const productionSteps = (
  shared: SharedBranch,
  id: string,
  place: OpenspecPlace | undefined
): string => {
  const { smoke } = statePaths(shared);
  const archive = place?.external
    ? `6. On a pass, run \`openspec archive ${id} --yes\` from \`${place.home}\`. It changes files outside this repo: commit nothing. On a fail, do not archive and do not revert: stop for the human.`
    : "6. On a pass, leave the change folder alone (it is the team's copy). On a fail, do not revert: stop for the human.";
  return [
    "A passing verdict is not done: done means verified in production. After the verdict, keep going:",
    `1. Wait for the human merge. Never merge yourself. Poll in the background (a backgrounded shell loop, not a foreground sleep): \`until gh pr view ${shared.branch} --json state -q .state 2>/dev/null | grep -qE 'MERGED|CLOSED'; do sleep 120; done\`. If the PR closed without merging, stop. Otherwise read the merge SHA: \`gh pr view ${shared.branch} --json mergeCommit -q .mergeCommit.oid\`.`,
    `2. Write \`${smoke}\` with \`"status": "running"\` and the merge SHA, in the rubric's "Smoke test" shape, so \`captain status\` shows the change as SHIPPING.`,
    "3. Watch the deploy: poll `gh api repos/{owner}/{repo}/commits/<merge sha>/statuses` until every `watch/*` context is `success`, or follow the repo's documented deploy check (AGENTS.md, README). A failed deploy is a failed smoke test.",
    `4. Run the rubric's "Smoke test" checks in production: a terminal check and a browser check, read-only unless a step names a reversible write, and inside the data scope.`,
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
      `write the plan verbatim to \`${statePaths(extras.shared).plan}\`, then implement it. If you end up ` +
      'deviating from it, append what changed and why under a "## Deviations" heading ' +
      "in that same file rather than rewriting the plan — the plan above it is the " +
      "record of what was approved, and a verifier grades the diff against both.";
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
            `2. Before you touch code, ${planStep} (This session has no plan-approval gate — do not stop to wait for one.)`,
          ]
        : [
            `1. Plan first (you are launched in plan mode) and present the plan for approval. ${planLead}`,
            `2. Once the plan is approved, ${planStep}`,
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

  if (extras.shared && extras.sharedId) {
    out += sharedBranchSection(extras.shared, extras.sharedId, extras.openspec);
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
      'rubric\'s "Verdict" section specifies. Captain will not mark this ' +
      `${extras.shared ? "change " : "worktree PR-"}ready without a passing verdict.\n`;
    out +=
      extras.shared && extras.sharedId
        ? `${productionSteps(extras.shared, extras.sharedId, extras.openspec)}\n`
        : "Once the verdict is written your work on this ticket is complete — stop and wait; the " +
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
