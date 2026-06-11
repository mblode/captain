#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import { approve, reject, status } from "./captain/commands";
import { doctor } from "./captain/doctor";
import { msg, style, useColor } from "./captain/format";
import { CliError } from "./errors";
import { runStart } from "./runner";

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
  $ captain doctor                       check prerequisites before your first start
  $ captain start TIG-430 TIG-431        Linear issues → worktrees + agents, self-driving
  $ captain start "tidy the README"      a free-form task in the current dir (no Linear)
  $ captain status                       one view: NEEDS YOU / IN FLIGHT / READY
  $ captain status --repo linkiq         one repo's worktrees only
  $ captain approve tig-430              approve plan(s)  (or a repo, or: all)
  $ captain reject tig-430 --note "…"    send a plan back with feedback

start routes on its first argument: a Linear issue id/URL fans out worktrees;
anything else is a free-form task run in the current checkout. Each agent's brief
carries the whole pipeline (plan → implement → the configured skills → verifier
verdict); Captain keeps no state — status is derived live from cmux and the
worktrees. You only make the gated decisions: approve plans, answer questions,
merge. Configure the skills in ~/.config/captain/config.json (.skills) or with
CAPTAIN_SKILLS=/simplify,/pr-creator.
Plain output when piped; NO_COLOR=1 disables colour on a TTY too.`
  );

// Start agents on work. A Linear issue id/URL fans out worktrees (one per
// issue); anything else is a free-form task run in the current checkout. Both
// hand the agent the same self-drive brief.
program
  .command("start")
  .description(
    "start agents: Linear issue id(s)/URL → worktrees, or a free-form task"
  )
  .argument(
    "[input...]",
    "Linear issue id(s)/URL, or a free-form task description"
  )
  .option("--print", "write the brief without launching")
  .option("--repo <path>", "force the git repo for this command")
  .option(
    "--name <slug>",
    "free-form task only: workspace label (default: a slug of the task)"
  )
  .option(
    "--base <ref>",
    "Linear only: branch new worktrees off this ref instead of origin's default"
  )
  .action(
    async (
      input: string[],
      options: {
        print?: boolean;
        repo?: string;
        name?: string;
        base?: string;
      }
    ) => {
      process.exitCode = await runStart({
        base: options.base,
        name: options.name,
        print: Boolean(options.print),
        repoOverride: options.repo,
        tokens: input,
      });
    }
  );

program
  .command("doctor")
  .description("check prerequisites: node, git, claude, cmux, key, skills")
  .action(() => {
    process.exitCode = doctor(process.stdout);
  });

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
  .argument("<refs>", 'ticket name(s), comma-separated, or "all"')
  .action((refs: string) => {
    approve(refs, process.stdout);
  });

program
  .command("reject")
  .description("send a plan back to planning with feedback")
  .argument("<ref>", "the worktree's ticket name")
  .requiredOption("--note <text>", "what to change")
  .action((ref: string, options: { note: string }) => {
    reject(ref, options.note, process.stdout);
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
