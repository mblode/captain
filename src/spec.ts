import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { realCmux } from "./captain/control";
import { appendLog, now } from "./captain/log";
import { changeStateDir } from "./captain/surface";
import { cmuxReachable, openIssueWorkspace } from "./cmux";
import { loadAgent, loadDataScope, loadSkills, normalizeAgent } from "./config";
import { CliError, EXIT } from "./errors";
import { mainRepoRoot, repoLabel } from "./git";
import { ensureMemoryFile, readMemoryExcerpt } from "./memory";
import {
  CHANGES_DIR,
  isOpenspecChange,
  listOpenspecChanges,
  openspecHome,
  readOpenspecChange,
} from "./openspec";
import { renderPrompt, renderPromptExtras } from "./prompt";
import { resolveRepo } from "./repo";
import { renderRubric } from "./rubric";
import type { SharedBranch } from "./rubric";
import { excludeCaptainDir } from "./runner";
import { commandExists, run } from "./shell";

export interface SpecOptions {
  ids: string[];
  // launch every active change that has no live agent yet
  all?: boolean;
  agent?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  json?: boolean;
  print?: boolean;
  // print the repo's OpenSpec home and exit
  root?: boolean;
  repoOverride?: string;
  stdout?: NodeJS.WritableStream;
}

// Shared-branch runs finish by pushing to the branch, so the PR steps of the
// skill pipeline have nothing to act on.
const PR_STEP = /\/pr-(creator|babysitter)\b/u;

const gitOut = (
  repoRoot: string,
  args: string[],
  env: NodeJS.ProcessEnv
): string => {
  const result = run("git", ["-C", repoRoot, ...args], { env });
  return result.status === 0 ? result.stdout.trim() : "";
};

// The branch every agent commits to: whatever the checkout is on now.
const currentBranch = (repoRoot: string, env: NodeJS.ProcessEnv): string => {
  const branch = gitOut(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  if (!branch || branch === "HEAD") {
    throw new CliError(
      `${repoRoot} is not on a branch — check out the branch the agents should push to, then retry`
    );
  }
  return branch;
};

// Where each requested change lives: the user's home first, the repo's own
// `openspec/changes/` (a team change) as the fallback. `--all` is the user's
// queue, so it lists the home only.
const requestedChanges = (
  home: string,
  repoRoot: string,
  options: SpecOptions
): Map<string, string> => {
  const requested = options.all ? listOpenspecChanges(home) : options.ids;
  if (requested.length === 0) {
    throw new CliError(
      options.all
        ? `no active OpenSpec changes in ${join(home, CHANGES_DIR)}`
        : "usage: captain spec <change-id…> | --all",
      EXIT.USAGE,
      "USAGE"
    );
  }
  const roots = new Map<string, string>();
  for (const id of requested) {
    const root = [home, repoRoot].find((r) => isOpenspecChange(r, id));
    if (root) {
      roots.set(id, root);
    }
  }
  const unknown = requested.filter((id) => !roots.has(id));
  if (unknown.length > 0) {
    const known = listOpenspecChanges(home);
    throw new CliError(
      `no OpenSpec change ${unknown.join(", ")} in ${join(home, CHANGES_DIR)} or ${join(repoRoot, CHANGES_DIR)} (each needs a proposal.md). Active: ${known.join(", ") || "none"}`,
      EXIT.USAGE,
      "USAGE"
    );
  }
  return roots;
};

const requireLauncher = (agent: string, env: NodeJS.ProcessEnv): void => {
  if (!cmuxReachable(env)) {
    throw new CliError(
      "cmux is not reachable — start the cmux app",
      EXIT.GENERIC,
      "CMUX_UNREACHABLE"
    );
  }
  if (!commandExists(agent, env)) {
    throw new CliError(`${agent} is not on PATH`);
  }
};

// Changes whose agent is still running in this checkout. They are left alone,
// which is what lets --all start only the new ones.
const liveChanges = (
  repoRoot: string,
  env: NodeJS.ProcessEnv
): Set<string | undefined> => {
  const port = realCmux(env);
  const runs = port.runStates();
  return new Set(
    port
      .listWorkspaces()
      .filter((w) => w.cwd === repoRoot && w.id.toLowerCase() in runs)
      .map((w) => w.description)
  );
};

interface Brief {
  agent: string;
  env: NodeJS.ProcessEnv;
  id: string;
  issue: ReturnType<typeof readOpenspecChange>;
  prompt: string;
  repoRoot: string;
  rubricPath: string;
  shared: SharedBranch;
  dataScope: string;
}

// Write the change's state files and open its cmux workspace.
const launchChange = async (brief: Brief): Promise<void> => {
  const { agent, env, id, repoRoot, shared } = brief;
  const absState = join(repoRoot, shared.stateDir);
  await mkdir(absState, { recursive: true });
  // A relaunch is a fresh run: the last run's plan, verdict and smoke test no
  // longer apply.
  for (const file of ["verdict.json", "plan.md", "smoke.json"]) {
    await rm(join(absState, file), { force: true });
  }
  const { text } = renderRubric(
    brief.issue,
    id,
    brief.dataScope,
    "OpenSpec",
    shared
  );
  await writeFile(join(repoRoot, brief.rubricPath), text);
  const promptPath = join(absState, "prompt.txt");
  await writeFile(promptPath, brief.prompt);
  const sessionId = agent === "claude" ? randomUUID() : undefined;
  await writeFile(join(absState, "session"), sessionId ?? "");

  openIssueWorkspace({
    agent,
    branch: id,
    description: id,
    env,
    focus: false,
    promptPath,
    sessionId,
    worktreePath: repoRoot,
  });
};

// `captain spec <change…>`: one agent per OpenSpec change, all in this
// checkout on its current branch — no worktrees. Each change's captain files
// live in `.captain/changes/<id>/`; the workspace description carries the
// change id and claude gets a fixed session id, which is how status tells
// agents in the same directory apart.
export const runSpec = async (options: SpecOptions): Promise<number> => {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const { repoRoot } = resolveRepo({
    cwd: options.cwd ?? process.cwd(),
    env,
    repoOverride: options.repoOverride,
  });
  const home = openspecHome(mainRepoRoot(repoRoot, env), env);
  if (options.root) {
    stdout.write(`${home}\n`);
    return 0;
  }
  const agent =
    options.agent === undefined
      ? loadAgent(env)
      : normalizeAgent(options.agent);
  const requested = requestedChanges(home, repoRoot, options);
  if (!options.print) {
    requireLauncher(agent, env);
  }

  const branch = currentBranch(repoRoot, env);
  const baseSha = gitOut(repoRoot, ["rev-parse", "HEAD"], env);
  const repo = repoLabel(repoRoot, env);
  const dataScope = loadDataScope(env);
  const skills = loadSkills(env).filter((skill) => !PR_STEP.test(skill));
  const memoryPath = ensureMemoryFile(repoRoot, env);
  const memory = readMemoryExcerpt(repoRoot, env);
  await excludeCaptainDir(repoRoot, env);
  const live = options.print ? new Set() : liveChanges(repoRoot, env);

  const started: { change: string; name: string; cwd: string }[] = [];
  const skipped: string[] = [];
  for (const [id, root] of requested) {
    if (live.has(id)) {
      skipped.push(id);
      continue;
    }
    const issue = readOpenspecChange(root, id);
    const shared: SharedBranch = {
      baseSha,
      branch,
      stateDir: changeStateDir(id),
    };
    const rubricPath = `${shared.stateDir}/rubric.md`;
    const prompt =
      renderPrompt(issue, id, "OpenSpec change", rubricPath) +
      renderPromptExtras({
        agent,
        dataScope,
        memory,
        memoryPath,
        openspec: { external: root === home, home: root },
        rubricPath,
        shared,
        sharedId: id,
        skills,
        workflow: true,
      });

    if (options.print) {
      stdout.write(
        options.json
          ? `${JSON.stringify({ change: id, cwd: repoRoot, prompt })}\n`
          : `agent prompt for ${id}:\n${prompt}\n`
      );
      continue;
    }

    await launchChange({
      agent,
      dataScope,
      env,
      id,
      issue,
      prompt,
      repoRoot,
      rubricPath,
      shared,
    });
    const name = repo ? `${repo}-${id}` : id;
    try {
      appendLog({ kind: "launch", name, ts: now() }, env);
    } catch {
      // best-effort ledger, same as the worktree launch path
    }
    started.push({ change: id, cwd: repoRoot, name });
  }

  if (options.print) {
    return 0;
  }
  if (options.json) {
    stdout.write(`${JSON.stringify({ branch, skipped, started })}\n`);
    return 0;
  }
  for (const entry of started) {
    stdout.write(`started ${entry.change} on ${branch}\n`);
  }
  for (const id of skipped) {
    stdout.write(`skipped ${id}: its agent is already running\n`);
  }
  stdout.write("follow along: captain status\n");
  return 0;
};
