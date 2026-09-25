#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { Command, CommanderError } from "commander";

import { realCmux } from "./captain/control";
import { install } from "./captain/doctor";
import {
  add,
  approve,
  close,
  gain,
  init,
  peek,
  reject,
  review,
  send,
  start,
  status,
} from "./commands";
import type { Deps } from "./commands";
import { CliError, EXIT } from "./errors";
import { msg, style, useColor } from "./format";
import { realGithub } from "./github";

// The bin runs under whatever node is first in PATH, and repo pins are often
// older than ES2023's toSorted. Patch it rather than ban it.
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
// and this binary runs under whatever node is first in PATH.
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
) as { version: string };

const deps: Deps = {
  color: useColor(process.stdout),
  env: process.env,
  ports: () => ({
    cmux: realCmux(process.env),
    github: realGithub(process.env),
  }),
  stdout: process.stdout,
};

const program = new Command();

// MUST be called before any .command(): subcommands copy inherited settings at
// creation time. Without it commander's own parse failures bypass the JSON
// error contract below.
program.exitOverride();

program
  .name("captain")
  .description(
    "One chat, a task list, and full coding harnesses in cmux worktrees"
  )
  .version(packageJson.version)
  .option(
    "--project <name>",
    "which project (default: $CAPTAIN_PROJECT, or the only one)"
  )
  .addHelpText(
    "after",
    `
The /captain chat runs these for you. By hand:
  $ captain init rebuild --repo ~/code/app       a project: task list + repo + WIP limit
  $ captain add "rebuild billing settings"       a task from a message
  $ captain add TIG-430                          a task from a Linear or Done Bear ticket
  $ captain start t-1 --harness codex            worktree + cmux workspace + agent
  $ captain status                               the board: what needs you, what's ready
  $ captain status --all-projects                every project's board at once
  $ captain approve t-2 --note "..."             release a plan (escalate tasks)
  $ captain send t-1 "use the existing helper"   steer a worker
  $ captain peek t-1                             the worker's screen
  $ captain review t-1                           the other vendor reviews the PR
  $ captain done t-1                             close it once merged

Tasks live in ~/captain/<project>/tasks/*.md: plain files the chat maintains.
Status is derived live from cmux, git, GitHub and each worktree's .captain/.`
  );

const common = (): { project?: string } => ({
  project: program.opts<{ project?: string }>().project,
});

program
  .command("init")
  .description("create a project: a task folder tied to one repo")
  .argument("<name>", "project name")
  .requiredOption("--repo <path>", "the product repo worktrees branch from")
  .option("--wip <n>", "max tasks in progress at once (default 4)")
  .option(
    "--bootstrap <cmd>",
    "shell command run in each new worktree before the agent"
  )
  .option("--json", "emit JSON")
  .action(
    (
      name: string,
      o: { repo: string; wip?: string; bootstrap?: string; json?: boolean }
    ) => {
      init(
        {
          bootstrap: o.bootstrap,
          json: o.json,
          name,
          repo: o.repo,
          wip: o.wip ? Number.parseInt(o.wip, 10) : undefined,
        },
        deps
      );
    }
  );

program
  .command("add")
  .description("add a task from a message or a ticket")
  .argument("<input...>", "a message, or a Linear/Done Bear id or URL")
  .option("--title <text>", "override the title")
  .option("--risk <level>", "low (default) or escalate (plan approval first)")
  .option("--harness <name>", "claude, codex (default) or cursor")
  .option("--model <id>", "pin a model for this task")
  .option("--effort <level>", "pin an effort for this task")
  .option("--blocked-by <ids>", "comma-separated task ids")
  .option("--json", "emit JSON")
  .action(
    async (
      input: string[],
      o: {
        title?: string;
        risk?: string;
        harness?: string;
        model?: string;
        effort?: string;
        blockedBy?: string;
        json?: boolean;
      }
    ) => {
      await add(input.join(" "), { ...common(), ...o }, deps);
    }
  );

program
  .command("start")
  .description("start task(s): worktree, brief, and a harness in cmux")
  .argument("<ids...>", "task ids")
  .option("--harness <name>", "claude, codex or cursor (overrides the task)")
  .option("--model <id>", "model (overrides the task)")
  .option("--effort <level>", "effort (overrides the task)")
  .option("--force", "start even if blocked or over the WIP limit")
  .option("--print", "print the brief without launching anything")
  .option("--json", "emit JSON")
  .action(
    async (
      ids: string[],
      o: {
        harness?: string;
        model?: string;
        effort?: string;
        force?: boolean;
        print?: boolean;
        json?: boolean;
      }
    ) => {
      await start(ids, { ...common(), ...o }, deps);
    }
  );

program
  .command("status")
  .description("the board, derived live")
  .argument("[ids...]", "only these tasks")
  .option("--all", "include closed tasks")
  .option(
    "--all-projects",
    "every project's board, each row tagged with its project"
  )
  .option("--json", "emit JSON")
  .action(
    (
      ids: string[],
      o: { all?: boolean; allProjects?: boolean; json?: boolean }
    ) => {
      status(ids, { ...common(), ...o }, deps);
    }
  );

program
  .command("approve")
  .description("approve a task's plan")
  .argument("<id>", "task id")
  .option("--note <text>", "why it is safe to proceed (goes in the log)")
  .option("--json", "emit JSON")
  .action((id: string, o: { note?: string; json?: boolean }) => {
    approve(id, { ...common(), ...o }, deps);
  });

program
  .command("reject")
  .description("send a task's plan back with feedback")
  .argument("<id>", "task id")
  .requiredOption("--note <text>", "what to change")
  .option("--json", "emit JSON")
  .action((id: string, o: { note: string; json?: boolean }) => {
    reject(id, { ...common(), ...o }, deps);
  });

program
  .command("send")
  .description("type a message into a task's worker")
  .argument("<id>", "task id")
  .argument("<message...>", "what to say")
  .option("--json", "emit JSON")
  .action((id: string, message: string[], o: { json?: boolean }) => {
    send(id, message.join(" "), { ...common(), ...o }, deps);
  });

program
  .command("peek")
  .description("show the end of a task's worker screen")
  .argument("<id>", "task id")
  .option("--lines <n>", "how many lines (default 40)")
  .option("--json", "emit JSON")
  .action((id: string, o: { lines?: string; json?: boolean }) => {
    peek(
      id,
      {
        ...common(),
        json: o.json,
        lines: o.lines ? Number.parseInt(o.lines, 10) : undefined,
      },
      deps
    );
  });

program
  .command("review")
  .description("have the other vendor review a task's PR")
  .argument("<id>", "task id")
  .option("--harness <name>", "reviewer harness (default: the other vendor)")
  .option("--model <id>", "reviewer model")
  .option("--effort <level>", "reviewer effort (default high)")
  .option("--json", "emit JSON")
  .action(
    async (
      id: string,
      o: { harness?: string; model?: string; effort?: string; json?: boolean }
    ) => {
      await review(id, { ...common(), ...o }, deps);
    }
  );

program
  .command("done")
  .description("close a merged task")
  .argument("<id>", "task id")
  .option("--note <text>", "anything worth keeping")
  .option("--json", "emit JSON")
  .action((id: string, o: { note?: string; json?: boolean }) => {
    close(id, "done", { ...common(), ...o }, deps);
  });

program
  .command("drop")
  .description("close an abandoned task")
  .argument("<id>", "task id")
  .option("--note <text>", "why")
  .option("--json", "emit JSON")
  .action((id: string, o: { note?: string; json?: boolean }) => {
    close(id, "dropped", { ...common(), ...o }, deps);
  });

program
  .command("gain")
  .description("the weekly numbers: flow, decisions, cycle time")
  .option("--since <when>", "7d / 24h / an ISO date")
  .option("--all-projects", "every project's numbers, plus a total")
  .option("--json", "emit JSON")
  .action((o: { since?: string; allProjects?: boolean; json?: boolean }) => {
    gain({ ...common(), ...o }, deps);
  });

program
  .command("install")
  .description("install the /captain and pipeline skills, then check setup")
  .action(() => {
    process.exitCode = install(process.stdout);
  });

// The JSON contract on failure: with --json, stdout carries exactly one value,
// {error:{type,message}}, never prose on stderr.
const wantsJson = (): boolean => process.argv.includes("--json");

const isCommanderOutput = (code: string): boolean =>
  code === "commander.helpDisplayed" ||
  code === "commander.help" ||
  code === "commander.version";

const fail = (type: string, message: string, exitCode: number): void => {
  if (wantsJson()) {
    process.stdout.write(`${JSON.stringify({ error: { message, type } })}\n`);
  } else {
    process.stderr.write(
      `${msg.err(style(useColor(process.stderr)), message)}\n`
    );
  }
  process.exitCode = exitCode;
};

const main = async (): Promise<void> => {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (isCommanderOutput(error.code)) {
        process.exitCode = error.exitCode;
      } else if (wantsJson()) {
        // commander already printed its hint to stderr
        process.stdout.write(
          `${JSON.stringify({ error: { message: error.message, type: error.code } })}\n`
        );
        process.exitCode = EXIT.USAGE;
      } else {
        process.exitCode = EXIT.USAGE;
      }
      return;
    }
    if (error instanceof CliError) {
      fail(error.errorType ?? "ERROR", error.message, error.exitCode);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    fail("UNEXPECTED", `unexpected error: ${detail}`, 1);
    if (process.env.CAPTAIN_DEBUG) {
      process.stderr.write(`${error instanceof Error ? error.stack : ""}\n`);
    }
  }
};

main();
