import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { realCmux } from "./captain/control";
import { ticketFrom } from "./captain/view";
import { cmuxReachable, isFanOutInput, openIssueWorkspace } from "./cmux";
import { loadSkills } from "./config";
import { CliError } from "./errors";
import { ensureWorktree, fetchOrigin } from "./git";
import { downloadIssueImages } from "./images";
import { isIssueId, parseIssueInput, slugify } from "./issue";
import { copyCommand, launchPlanMode } from "./launch";
import { fetchLinearIssue } from "./linear";
import { ensureMemoryFile, readMemoryExcerpt } from "./memory";
import { createProgress, withPrefix } from "./progress";
import type { Progress } from "./progress";
import { renderPrompt, renderPromptExtras } from "./prompt";
import { resolveRepo } from "./repo";
import { renderRubric, RUBRIC_RELPATH } from "./rubric";
import { commandExists } from "./shell";
import type { CliOptions, DispatchOptions, WorktreeResult } from "./types";

interface PreparedIssue {
  displayId: string;
  prompt: string;
  worktree: WorktreeResult;
}

interface PrepareContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  progress: Progress;
  repoOverride?: string;
  base?: string;
  // the configured post-implementation skills, loaded once per run
  skills: string[];
}

interface DispatchArgs {
  context: PrepareContext;
  env: NodeJS.ProcessEnv;
  options: CliOptions;
  progress: Progress;
  stdout: NodeJS.WritableStream;
  tokens: string[];
}

// After a fan-out, every worktree we created should own a dedicated cmux
// workspace (matched by cwd). One that doesn't has collapsed into an existing
// window — its agent runs somewhere captain can't track as a distinct worktree.
// Surface that at the moment it happens instead of silently dropping a ticket.
// An empty workspace list is the cmux RPC being unreliable, not evidence of
// collapse — no false alarms.
export const collapsedWorktreeNotes = (
  worktreePaths: string[],
  workspaces: { cwd: string }[]
): string[] => {
  if (workspaces.length === 0) {
    return [];
  }
  const owned = (path: string): boolean =>
    workspaces.some(
      (w) => w.cwd === path || w.cwd.endsWith(`/${basename(path)}`)
    );
  return worktreePaths
    .filter((p) => !owned(p))
    .map(
      (p) =>
        `note: ${basename(p)} has no dedicated cmux workspace — its agent likely attached to an existing window. Close that window, then re-run: captain fanout ${ticketFrom(basename(p))?.toUpperCase() ?? basename(p)}`
    );
};

const readStdinTokens = (): string[] => {
  if (process.stdin.isTTY) {
    return [];
  }

  const input = readFileSync(0, "utf-8");
  const firstLine = input.split(/\r?\n/u)[0]?.trim() ?? "";
  return firstLine ? firstLine.split(/\s+/u) : [];
};

const writePromptFile = async (
  displayId: string,
  prompt: string
): Promise<string> => {
  const dir = join("/tmp", "linear-worktree", displayId);
  await mkdir(dir, { recursive: true });
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, prompt);
  return promptPath;
};

interface LaunchTarget {
  // cmux workspace name + git branch (progress label)
  label: string;
  // where the agent runs (a worktree, or the checkout itself for dispatch)
  cwd: string;
  // names the temp prompt-file dir
  displayId: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  progress: Progress;
}

const launchViaCmux = async (
  target: LaunchTarget,
  focus: boolean
): Promise<void> => {
  target.progress.step(`opening cmux workspace ${target.label}`);
  const promptPath = await writePromptFile(target.displayId, target.prompt);
  openIssueWorkspace({
    branch: target.label,
    env: target.env,
    focus,
    promptPath,
    worktreePath: target.cwd,
  });
};

// The single-target launch strategy, shared by single-issue fanout and dispatch:
// cmux if reachable, else inline plan mode. (The multi-issue loop calls
// launchViaCmux directly — a refused workspace there surfaces as a collapse note,
// not a fallback.)
const launchOrFallback = async (
  target: LaunchTarget,
  stdout: NodeJS.WritableStream
): Promise<number> => {
  const { env, progress } = target;
  if (cmuxReachable(env) && commandExists("claude", env)) {
    try {
      await launchViaCmux(target, true);
      progress.done(`opened cmux workspace ${target.label}`);
      stdout.write("follow along: captain status\n");
      return 0;
    } catch {
      // fall through to inline launch if cmux refuses the workspace
    }
  }
  progress.done();
  return launchPlanMode(target.cwd, target.prompt, env);
};

const targetOf = (
  prepared: PreparedIssue,
  progress: Progress,
  env: NodeJS.ProcessEnv
): LaunchTarget => ({
  cwd: prepared.worktree.worktreePath,
  displayId: prepared.displayId,
  env,
  label: prepared.worktree.branch,
  progress,
  prompt: prepared.prompt,
});

// Keep `.captain/` (rubric + verdict) out of every worktree's diff. Linked
// worktrees share the main checkout's `.git/info/exclude`, so one append covers
// the whole fleet; nothing is ever committed.
const excludeCaptainDir = async (repoRoot: string): Promise<void> => {
  const excludePath = join(repoRoot, ".git", "info", "exclude");
  const current = await readFile(excludePath, "utf-8").catch(() => "");
  if (current.split("\n").includes(".captain/")) {
    return;
  }
  await mkdir(dirname(excludePath), { recursive: true });
  await appendFile(
    excludePath,
    `${current.endsWith("\n") || current === "" ? "" : "\n"}.captain/\n`
  );
};

// Close the two loops around the base prompt: write the worktree's definition
// of done (`.captain/rubric.md`) and wire the per-repo fleet memory, then
// append the finishing-protocol + fleet-memory sections.
const withLoopExtras = async (
  prompt: string,
  worktreePath: string,
  repoRoot: string,
  issue: Parameters<typeof renderRubric>[0],
  displayId: string,
  env: NodeJS.ProcessEnv,
  skills: string[]
): Promise<string> => {
  const { text } = renderRubric(issue, displayId);
  await mkdir(join(worktreePath, ".captain"), { recursive: true });
  await writeFile(join(worktreePath, RUBRIC_RELPATH), text);
  await excludeCaptainDir(repoRoot);
  const memoryPath = ensureMemoryFile(repoRoot, env);
  return (
    prompt +
    renderPromptExtras({
      memory: readMemoryExcerpt(repoRoot, env),
      memoryPath,
      rubricPath: RUBRIC_RELPATH,
      skills,
      workflow: true,
    })
  );
};

const prepareIssue = async (
  token: string,
  context: PrepareContext
): Promise<PreparedIssue> => {
  const { cwd, env, progress } = context;

  const parsedIssue = parseIssueInput(token);

  progress.step("resolving repo");
  const repo = resolveRepo({
    cwd,
    env,
    repoOverride: context.repoOverride,
  });

  // Dispatch the Linear request first (async, non-blocking) so it travels the
  // network while the synchronous `git fetch origin` blocks the main thread.
  progress.step(`fetching ${parsedIssue.displayId} from Linear`);
  const issuePromise = fetchLinearIssue(parsedIssue.displayId, env);
  progress.step("git fetch origin");
  fetchOrigin(repo.repoRoot, env);
  const issue = await issuePromise;

  const slug = parsedIssue.slug || (issue?.title ? slugify(issue.title) : "");

  let prompt = renderPrompt(issue, parsedIssue.displayId);
  if (issue?.description && env.LINEAR_API_KEY) {
    progress.step("downloading screenshots");
    const screenshots = await downloadIssueImages(
      issue.description,
      parsedIssue.displayId,
      env.LINEAR_API_KEY
    );
    if (screenshots.length > 0) {
      prompt += `\nScreenshots for this ticket (view with the Read tool):\n${screenshots.join("\n")}`;
    }
  }

  progress.step("creating worktree");
  const worktree = await ensureWorktree({
    base: context.base,
    env,
    issueId: parsedIssue.issueId,
    repoRoot: repo.repoRoot,
    skipFetch: true,
    slug,
  });

  prompt = await withLoopExtras(
    prompt,
    worktree.worktreePath,
    repo.repoRoot,
    issue,
    parsedIssue.displayId,
    env,
    context.skills
  );

  return { displayId: parsedIssue.displayId, prompt, worktree };
};

const dispatch = async ({
  context,
  env,
  options,
  progress,
  stdout,
  tokens,
}: DispatchArgs): Promise<number> => {
  if (isFanOutInput(tokens, Boolean(options.print))) {
    if (!cmuxReachable(env)) {
      throw new CliError(
        "cmux is not reachable (needed for multi-issue fan-out) — is it running? run `captain doctor`"
      );
    }
    if (!commandExists("claude", env)) {
      throw new CliError(
        "claude is not on PATH — install it, then `captain doctor`"
      );
    }

    const worktreePaths: string[] = [];
    let index = 0;
    for (const token of tokens) {
      index += 1;
      const scoped = withPrefix(
        progress,
        `[${index}/${tokens.length}] ${token.toUpperCase()} · `
      );
      const prepared = await prepareIssue(token, {
        ...context,
        progress: scoped,
      });
      worktreePaths.push(prepared.worktree.worktreePath);
      await launchViaCmux(targetOf(prepared, scoped, env), false);
      progress.done(
        `opened ${prepared.worktree.branch} (${index}/${tokens.length})`
      );
    }

    stdout.write(
      `spawned ${tokens.length} workspaces — each agent drives its own pipeline to PR-ready\n`
    );
    for (const note of collapsedWorktreeNotes(
      worktreePaths,
      realCmux(env).listWorkspaces()
    )) {
      stdout.write(`  ${note}\n`);
    }
    stdout.write("follow along: captain status\n");
    return 0;
  }

  const prepared = await prepareIssue(tokens.join(" "), context);

  if (options.print) {
    const cdCommand = `cd ${prepared.worktree.worktreePath}`;
    copyCommand(cdCommand, env);
    progress.done();
    stdout.write(
      `agent prompt:\n${prepared.prompt}\n\ncopied:\n${cdCommand}\n`
    );
    return 0;
  }

  return launchOrFallback(targetOf(prepared, progress, env), stdout);
};

export const runLinearWorktree = async (
  options: CliOptions
): Promise<number> => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const tokens = options.tokens.length > 0 ? options.tokens : readStdinTokens();

  if (tokens.length === 0) {
    throw new CliError(
      "usage: captain start [--print] [--repo <path>] <issue-id|url> [more issue-ids...]",
      2
    );
  }

  const progress = createProgress(options.stderr ?? process.stderr);
  const context: PrepareContext = {
    base: options.base,
    cwd,
    env,
    progress,
    repoOverride: options.repoOverride,
    skills: loadSkills(env),
  };

  try {
    return await dispatch({ context, env, options, progress, stdout, tokens });
  } catch (error) {
    progress.done();
    throw error;
  }
};

// `captain dispatch "<task>"` — the non-Linear path: no issue fetch, no worktree.
// The agent runs in the current checkout (cwd = repoRoot), with the same
// self-drive brief, rubric and verdict gate as fanout. One dispatch per checkout
// at a time — a second clobbers the shared `.captain/` files.
export const runDispatch = async (
  options: DispatchOptions
): Promise<number> => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const task = options.task.trim();

  if (!task) {
    throw new CliError(
      'usage: captain start "<task>" [--name <slug>] [--repo <path>]',
      2
    );
  }

  const progress = createProgress(options.stderr ?? process.stderr);
  try {
    progress.step("resolving repo");
    const repo = resolveRepo({ cwd, env, repoOverride: options.repoOverride });

    const name = slugify(options.name || task);
    if (!name) {
      throw new CliError(
        "could not derive a workspace name from the task — pass --name <slug>",
        2
      );
    }

    let prompt = `Task:\n\n${task}\n`;
    prompt = await withLoopExtras(
      prompt,
      repo.repoRoot,
      repo.repoRoot,
      undefined,
      name,
      env,
      loadSkills(env)
    );

    if (options.print) {
      progress.done();
      stdout.write(`agent prompt:\n${prompt}\n`);
      return 0;
    }

    return launchOrFallback(
      {
        cwd: repo.repoRoot,
        displayId: name,
        env,
        label: name,
        progress,
        prompt,
      },
      stdout
    );
  } catch (error) {
    progress.done();
    throw error;
  }
};

// A start token is Linear work if it's a bare issue id (TIG-430) or a Linear
// URL; anything else is a free-form task. The whole list shares the first
// token's verdict — you don't mix tickets and prose in one invocation.
const isLinearToken = (token: string): boolean =>
  isIssueId(token) || /^https?:\/\/linear\.app\//iu.test(token);

// The single entry point behind `captain start`: route to the Linear worktree
// fan-out or the free-form current-dir dispatch by inspecting the first token.
// Empty tokens fall through to runLinearWorktree, which reads stdin then errors.
export const runStart = (
  options: CliOptions & { name?: string }
): Promise<number> => {
  const [first] = options.tokens;
  if (first && !isLinearToken(first)) {
    return runDispatch({
      cwd: options.cwd,
      env: options.env,
      name: options.name,
      print: options.print,
      repoOverride: options.repoOverride,
      stderr: options.stderr,
      stdout: options.stdout,
      task: options.tokens.join(" "),
    });
  }
  return runLinearWorktree(options);
};
