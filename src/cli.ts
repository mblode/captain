#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import { approve, reject, status } from "./captain/commands";
import { msg, style, useColor } from "./captain/format";
import { notifyLoop } from "./captain/notify";
import { CliError } from "./errors";
import { runLinearWorktree } from "./runner";

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")
) as { version: string };

const program = new Command();

program
  .name("captain")
  .description("Dispatch a fleet of cmux worktrees and surface what needs you")
  .version(packageJson.version)
  .addHelpText(
    "after",
    `
Workflow:
  $ captain fanout TIG-430 TIG-431       worktrees + agents, each self-driving to PR-ready
  $ captain status                       one view: NEEDS YOU / IN FLIGHT / READY
  $ captain status --repo linkiq         one repo's worktrees only
  $ captain approve --plans tig-430      approve plan(s)  (or a repo, or: all)
  $ captain reject --ref tig-430 --note "…"   send a plan back with feedback
  $ captain notify                       optional foreground toaster (Ctrl-C stops)

Each agent's brief carries the whole pipeline (plan → implement → /simplify →
/pr-reviewer → /pr-creator → /pr-babysitter → verifier verdict); Captain keeps
no state — status is derived live from cmux and the worktrees. You only make
the gated decisions: approve plans, answer questions, merge.
Plain output when piped; NO_COLOR=1 disables colour on a TTY too.`
  );

// Inherited: create a worktree + cmux workspace per Linear issue (fan-out).
program
  .command("fanout")
  .description("create git worktrees for Linear issues and launch agents")
  .option(
    "--print",
    "create the worktree and print the prompt without launching"
  )
  .option("--repo <path>", "force the git repo for this command")
  .option(
    "--base <ref>",
    "branch new worktrees off this ref (e.g. a prerequisite ticket's branch) instead of origin's default"
  )
  .argument("[input...]", "Linear issue ID, URL, or multiple bare issue IDs")
  .action(
    async (
      input: string[],
      options: { print?: boolean; repo?: string; base?: string }
    ) => {
      process.exitCode = await runLinearWorktree({
        base: options.base,
        print: Boolean(options.print),
        repoOverride: options.repo,
        tokens: input,
      });
    }
  );

program
  .command("status")
  .description(
    "the one view: NEEDS YOU / IN FLIGHT / READY, with resolve commands"
  )
  .option("--json", "emit JSON")
  .option("--repo <name>", "only one repo's worktrees, e.g. linkiq")
  .option("--needs", "only the NEEDS YOU group")
  .option("--ready", "only the READY group")
  .action(
    (options: {
      json?: boolean;
      repo?: string;
      needs?: boolean;
      ready?: boolean;
    }) => {
      status(options, process.stdout);
    }
  );

program
  .command("approve")
  .description("approve plan(s): all, or comma-separated ticket names")
  .requiredOption("--plans <refs>", 'ticket names, or "all"')
  .action((options: { plans: string }) => {
    approve(options.plans, process.stdout);
  });

program
  .command("reject")
  .description("send a plan back to planning with feedback")
  .requiredOption("--ref <ticket>", "the worktree's ticket name")
  .requiredOption("--note <text>", "what to change")
  .action((options: { note: string; ref: string }) => {
    reject(options.ref, options.note, process.stdout);
  });

program
  .command("notify")
  .description(
    "foreground poller: toast on new gates, verdicts, and quiet worktrees"
  )
  .option("--once", "run a single poll pass and exit")
  .action((options: { once?: boolean }) => {
    notifyLoop({
      env: process.env,
      log: (m) => process.stderr.write(`[captain] ${m}\n`),
      once: options.once,
    });
  });

const main = async (): Promise<void> => {
  try {
    await program.parseAsync();
  } catch (error) {
    const s = style(useColor(process.stderr));
    if (error instanceof CliError) {
      process.stderr.write(`${msg.err(s, error.message)}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    // An unexpected failure: one readable line, never a raw stack — unless
    // CAPTAIN_DEBUG=1 asks for it.
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${msg.err(s, `unexpected error: ${detail}`)}\n`);
    if (process.env.CAPTAIN_DEBUG) {
      process.stderr.write(`${error instanceof Error ? error.stack : ""}\n`);
    } else {
      process.stderr.write(
        `${msg.hint(s, "set CAPTAIN_DEBUG=1 for the stack")}\n`
      );
    }
    process.exitCode = 1;
  }
};

main();
