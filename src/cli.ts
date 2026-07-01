#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Command, Option } from "commander";

import { approve, gain, reject, status } from "./captain/commands";
import { install } from "./captain/doctor";
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
  $ captain install                      install the /captain + pipeline skills, then check setup
  $ captain start TIG-430 TIG-431        Linear issues → worktrees + agents, self-driving
  $ captain start "tidy the README"      a free-form task in the current dir (no Linear)
  $ captain status                       one view: NEEDS YOU / IN FLIGHT / READY
  $ captain status --summary             compact: counts + only what needs you
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
  .option("--json", "emit JSON: { started: [...] }")
  .option(
    "--repo-path <path>",
    "force the git repo (filesystem path) this start runs against"
  )
  // Back-compat alias for the old name; hidden so help only shows --repo-path.
  // (status's --repo is a label FILTER, not a path — different meaning, hence
  // the rename to keep the two unambiguous for an unattended driver.)
  .addOption(new Option("--repo <path>", "alias for --repo-path").hideHelp())
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
        json?: boolean;
        repoPath?: string;
        repo?: string;
        name?: string;
        base?: string;
      }
    ) => {
      process.exitCode = await runStart({
        base: options.base,
        json: Boolean(options.json),
        name: options.name,
        print: Boolean(options.print),
        // --repo-path is canonical; --repo is the hidden legacy alias.
        repoOverride: options.repoPath ?? options.repo,
        tokens: input,
      });
    }
  );

program
  .command("install")
  .description(
    "install the /captain + pipeline skills the fleet needs, then check setup"
  )
  .action(() => {
    process.exitCode = install(process.stdout);
  });

program
  .command("status")
  .description(
    "the one view: NEEDS YOU / IN FLIGHT / READY, with resolve commands"
  )
  .option("--json", "emit JSON")
  .option(
    "--repo <name>",
    "filter to one repo by LABEL, e.g. linkiq (not a path; cf. start --repo-path)"
  )
  .option("--needs", "only the NEEDS YOU group")
  .option("--ready", "only the READY group")
  .option(
    "--summary",
    "compact: group counts + NEEDS YOU detail only (a cheap poll)"
  )
  .option(
    "--watch",
    "live foreground view: re-render every --interval seconds (Ctrl-C to exit). Stateless — every tick re-derives the fleet fresh, no daemon"
  )
  .option(
    "--interval <seconds>",
    "--watch poll interval in seconds (default 5)",
    "5"
  )
  .action(
    (options: {
      json?: boolean;
      repo?: string;
      needs?: boolean;
      ready?: boolean;
      summary?: boolean;
      watch?: boolean;
      interval?: string;
    }) => {
      status(
        {
          ...options,
          interval: options.interval
            ? Number.parseFloat(options.interval)
            : undefined,
        },
        process.stdout
      );
    }
  );

program
  .command("gain")
  .alias("audit")
  .description(
    "fleet telemetry, derived live: decisions ledger + fleet/verdict snapshot"
  )
  .option("--json", "emit JSON")
  .option(
    "--since <when>",
    "window the decision metrics: 7d / 24h / an ISO date"
  )
  .option("--git", "also approximate merged-PR counts per repo via gh (opt-in)")
  .action((options: { json?: boolean; since?: string; git?: boolean }) => {
    gain(options, process.stdout);
  });

program
  .command("approve")
  .description("approve plan(s): all, or comma-separated ticket names")
  .argument("<refs>", 'ticket name(s), comma-separated, or "all"')
  .option("--json", "emit JSON: { approved, unknown }")
  .action((refs: string, options: { json?: boolean }) => {
    approve(refs, process.stdout, undefined, { json: options.json });
  });

program
  .command("reject")
  .description("send a plan back to planning with feedback")
  .argument("<refs>", 'ticket name(s), comma-separated, or "all"')
  .requiredOption("--note <text>", "what to change")
  .option(
    "--json",
    "emit JSON: { rejected, undelivered, note } or { ambiguous, unknown }"
  )
  .action((ref: string, options: { note: string; json?: boolean }) => {
    reject(ref, options.note, process.stdout, undefined, {
      json: options.json,
    });
  });

// The JSON contract on failure: when the command was invoked with --json, the
// ONE value on stdout must be {error:{type,message}} — never prose on stderr
// (that would leave a driver's JSON.parse with nothing). We read --json off
// argv since the parsed options aren't in scope here.
const wantsJson = (): boolean => process.argv.includes("--json");

const main = async (): Promise<void> => {
  try {
    await program.parseAsync();
  } catch (error) {
    const json = wantsJson();
    const s = style(useColor(process.stderr));
    if (error instanceof CliError) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ error: { message: error.message, type: error.errorType ?? "ERROR" } })}\n`
        );
      } else {
        process.stderr.write(`${msg.err(s, error.message)}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    // An unexpected failure: one readable line, never a raw stack — unless
    // CAPTAIN_DEBUG=1 asks for it.
    const detail = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ error: { message: detail, type: "UNEXPECTED" } })}\n`
      );
    } else {
      process.stderr.write(`${msg.err(s, `unexpected error: ${detail}`)}\n`);
    }
    if (process.env.CAPTAIN_DEBUG) {
      process.stderr.write(`${error instanceof Error ? error.stack : ""}\n`);
    } else if (!json) {
      process.stderr.write(
        `${msg.hint(s, "set CAPTAIN_DEBUG=1 for the stack")}\n`
      );
    }
    process.exitCode = 1;
  }
};

main();
