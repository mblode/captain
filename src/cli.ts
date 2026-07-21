#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { Command, Option } from "commander";

import { approve, gain, reject, status } from "./captain/commands";
import { install } from "./captain/doctor";
import { msg, style, useColor } from "./captain/format";
import { CliError } from "./errors";
import { withImplicitStart } from "./route";
import { runStart } from "./runner";

// The bin runs under whatever node is first in PATH, and fnm repo pins are
// often 18 — which lacks ES2023's toSorted. Patch it rather than ban it: the
// codebase targets node >=24 and lints toward toSorted (unicorn/no-array-sort).
// Safe below the imports: nothing calls toSorted at module-eval time.
/* eslint-disable no-extend-native, unicorn/consistent-function-scoping, unicorn/no-array-sort -- toSorted polyfill for node <20 */
if (typeof Array.prototype.toSorted !== "function") {
  Array.prototype.toSorted = function toSorted<T>(
    this: T[],
    compare?: (a: T, b: T) => number
  ): T[] {
    return [...this].sort(compare);
  };
}
/* eslint-enable no-extend-native, unicorn/consistent-function-scoping, unicorn/no-array-sort */

// new URL over import.meta.dirname: the latter is undefined before node 20.11,
// and this binary regularly runs under whatever node is first in PATH.
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
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
  $ captain TIG-430 TIG-431              Linear issues → worktrees + agents (bare = start)
  $ captain start TIG-430 TIG-431        the same, explicit
  $ captain "tidy the README"            a free-form task in the current dir (no Linear)
  $ captain TIG-430 --agent codex        launch codex instead of Claude Code (best-effort)
  $ captain status                       one view: NEEDS YOU / IN FLIGHT / READY
  $ captain status TIG-430 --json        one ticket/workspace, compact JSON
  $ captain status --summary             compact: counts + only what needs you
  $ captain status --summary --json      compact poll + reusable snapshot token
  $ captain status --repo linkiq         one repo's worktrees only
  $ captain approve tig-430              approve plan(s)  (or a repo, or: all)
  $ captain reject tig-430 --note "…"    send a plan back with feedback

A bare first argument (a Linear issue id/URL, or a free-form task) is treated as
"captain start …"; start then routes on it: a Linear id/URL fans out worktrees,
anything else is a free-form task run in the current checkout. Each agent's brief
carries the whole pipeline (plan → implement → the configured skills → verifier
verdict); Captain keeps no state — status is derived live from cmux and the
worktrees. You only make the gated decisions: approve plans, answer questions,
merge. Configure the skills in ~/.config/captain/config.json (.skills) or with
CAPTAIN_SKILLS=/tidy,/pr-creator; pick the agent with --agent / CAPTAIN_AGENT.
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
  .option(
    "--print",
    "prepare the task and print its brief without launching (not a dry-run)"
  )
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
  .option(
    "--agent <name>",
    "which agent to launch: claude (default) or codex (best-effort: no plan gate)"
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
        agent?: string;
      }
    ) => {
      process.exitCode = await runStart({
        agent: options.agent,
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
  .argument(
    "[refs...]",
    "ticket/workspace refs to show (space- or comma-separated)"
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
    "--since <snapshot>",
    "with --summary --json: return only changed:false when unchanged"
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
    (
      refs: string[],
      options: {
        json?: boolean;
        repo?: string;
        needs?: boolean;
        ready?: boolean;
        summary?: boolean;
        since?: string;
        watch?: boolean;
        interval?: string;
      }
    ) => {
      status(
        {
          ...options,
          interval: options.interval
            ? Number.parseFloat(options.interval)
            : undefined,
          refs: refs.length > 0 ? refs.join(",") : undefined,
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

// Every registered subcommand name + alias (plus commander's implicit `help`),
// read from the registry itself so the implicit-start splice can never swallow
// a subcommand added later.
const knownCommands = (): ReadonlySet<string> =>
  new Set([
    "help",
    ...program.commands.flatMap((c) => [c.name(), ...c.aliases()]),
  ]);

const main = async (): Promise<void> => {
  try {
    await program.parseAsync(withImplicitStart(process.argv, knownCommands()));
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
