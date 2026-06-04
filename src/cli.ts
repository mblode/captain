#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import { approve, gates, ready, reject, status } from "./captain/commands.js";
import { watch } from "./captain/watch.js";
import { CliError } from "./errors.js";
import { runLinearWorktree } from "./runner.js";

const packageJson = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")
) as { version: string };

const program = new Command();

program
  .name("captain")
  .description("Drive a fleet of cmux worktrees through the SDLC, live")
  .version(packageJson.version)
  .addHelpText(
    "after",
    `
Workflow:
  $ captain fanout TIG-430 TIG-431          worktree + plan-mode agent per issue
  $ CMUX_CAPTAIN=1 captain watch --fleet qa --match frontyard
                                              live daemon — run in its own workspace
  $ captain status  --fleet qa              glanceable fleet view
  $ captain gates   --fleet qa              pending decisions + how to resolve each
  $ captain approve --fleet qa --plans tig-430,tig-431      (or: --plans all)
  $ captain ready   --fleet qa              PR-ready worktrees to merge

The watcher reacts to cmux agent events live, auto-advances each worktree
(simplify → review → PR → babysit) and stops at PR-ready. You only make the
gated decisions: approve plans, answer questions, merge.`
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
  .argument("[input...]", "Linear issue ID, URL, or multiple bare issue IDs")
  .action(
    async (input: string[], options: { print?: boolean; repo?: string }) => {
      process.exitCode = await runLinearWorktree({
        print: Boolean(options.print),
        repoOverride: options.repo,
        tokens: input,
      });
    }
  );

// The live daemon — run this in its own cmux workspace.
program
  .command("watch")
  .description("live: hold the cmux event stream open and drive the fleet")
  .requiredOption(
    "--fleet <id>",
    "fleet id (namespaces state under ~/.claude/captain)"
  )
  .option("--match <substring>", "only track worktrees whose cwd contains this")
  .action((options: { fleet: string; match?: string }) => {
    watch({
      env: process.env,
      fleetId: options.fleet,
      log: (m) => process.stderr.write(`[captain] ${m}\n`),
      match: options.match,
    });
  });

program
  .command("status")
  .description("render the fleet table")
  .requiredOption("--fleet <id>", "fleet id")
  .option("--json", "emit JSON")
  .action((options: { fleet: string; json?: boolean }) => {
    status(options.fleet, Boolean(options.json), process.stdout);
  });

program
  .command("gates")
  .description("pending decisions (plans / blocks), batched")
  .requiredOption("--fleet <id>", "fleet id")
  .option("--json", "emit JSON")
  .action((options: { fleet: string; json?: boolean }) => {
    gates(options.fleet, Boolean(options.json), process.stdout);
  });

program
  .command("ready")
  .description("worktrees parked at PR-ready, awaiting your merge")
  .requiredOption("--fleet <id>", "fleet id")
  .action((options: { fleet: string }) => {
    ready(options.fleet, process.stdout);
  });

program
  .command("approve")
  .description("approve plan(s): all, or comma-separated workspace ids")
  .requiredOption("--fleet <id>", "fleet id")
  .requiredOption("--plans <refs>", 'workspace ids, or "all"')
  .action((options: { fleet: string; plans: string }) => {
    approve(options.fleet, options.plans, process.env, process.stdout);
  });

program
  .command("reject")
  .description("send a plan back to planning with feedback")
  .requiredOption("--fleet <id>", "fleet id")
  .requiredOption("--ref <workspaceId>", "the worktree's workspace id")
  .requiredOption("--note <text>", "what to change")
  .action((options: { fleet: string; note: string; ref: string }) => {
    reject(
      options.fleet,
      options.ref,
      options.note,
      process.env,
      process.stdout
    );
  });

const main = async (): Promise<void> => {
  try {
    await program.parseAsync();
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
};

main();
