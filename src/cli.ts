#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Command } from "commander";

import { approve, audit, reject, status } from "./captain/commands";
import {
  ensureDaemon,
  stopDaemon,
  watcherHealth,
  watchLogPath,
} from "./captain/daemon";
import { DEFAULT_FLEET, loadState } from "./captain/state";
import { watch } from "./captain/watch";
import { CliError } from "./errors";
import { runLinearWorktree } from "./runner";

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
  $ captain fanout TIG-430 TIG-431     worktrees + agents, and starts the watcher
  $ captain status                     one view: NEEDS YOU / IN FLIGHT / READY
  $ captain audit                      the governance trail of every decision
  $ captain approve --plans tig-430    approve plan(s)  (or: --plans all)
  $ captain reject  --ref tig-430 --note "…"            send a plan back
  $ captain restart                    bounce the watcher (e.g. after a rebuild)
  $ captain stop                       stop the watcher

fanout starts a background watcher that reacts to cmux agent events live,
auto-advances each worktree (simplify → review → PR → babysit) and stops at
PR-ready. You only make the gated decisions: approve plans, answer questions,
merge. Everything runs on one fleet; status shows how to resolve each gate.`
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

// The live daemon. Normally auto-started by `fanout`; exposed for a manual restart.
program
  .command("watch")
  .description("live: hold the cmux event stream open and drive the fleet")
  .action(() => {
    watch({
      env: process.env,
      log: (m) => process.stderr.write(`[captain] ${m}\n`),
    });
  });

program
  .command("status")
  .description(
    "the one view: NEEDS YOU / IN FLIGHT / READY, with resolve commands"
  )
  .option("--json", "emit JSON")
  .action((options: { json?: boolean }) => {
    status(Boolean(options.json), process.stdout);
  });

program
  .command("audit")
  .description("the governance trail: every advance, gate, and human decision")
  .option("--json", "emit JSON")
  .option("--since <dur>", "only events within a window, e.g. 2h or 1d")
  .option("--ref <ticket>", "only events for one worktree (ticket name or id)")
  .action((options: { json?: boolean; since?: string; ref?: string }) => {
    audit(options, process.stdout);
  });

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
  .command("stop")
  .description("stop the background watcher")
  .action(() => {
    const pid = stopDaemon(DEFAULT_FLEET);
    process.stdout.write(
      pid ? `stopped watcher (pid ${pid})\n` : "no watcher was running\n"
    );
  });

// Bounce the watcher in one move (session bug #9: recovering a dead daemon used
// to mean a manual relaunch + a hand-repointed pidfile). A dead/missing watcher
// just skips the stop; the new one reuses the persisted match scope.
program
  .command("restart")
  .description("restart the background watcher (e.g. after a rebuild)")
  .action(async () => {
    const stopped = stopDaemon(DEFAULT_FLEET);
    if (stopped) {
      process.stdout.write(`stopped watcher (pid ${stopped})\n`);
    }
    const { started } = await ensureDaemon(
      DEFAULT_FLEET,
      process.env,
      loadState(DEFAULT_FLEET).match
    );
    if (!started) {
      process.stderr.write(
        `watcher: could not start — check ${watchLogPath(DEFAULT_FLEET)}\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`watcher: ${watcherHealth(DEFAULT_FLEET)}\n`);
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
