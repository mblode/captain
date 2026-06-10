import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ensureDaemon } from "./captain/daemon";
import { DEFAULT_FLEET, loadState } from "./captain/state";
import { cmuxReachable, isFanOutInput, openIssueWorkspace } from "./cmux";
import { CliError } from "./errors";
import { ensureWorktree, fetchOrigin } from "./git";
import { downloadIssueImages } from "./images";
import { parseIssueInput, slugify } from "./issue";
import { copyCommand, launchPlanMode } from "./launch";
import { fetchLinearIssue } from "./linear";
import { ensureMemoryFile, readMemoryExcerpt } from "./memory";
import { createProgress, withPrefix } from "./progress";
import type { Progress } from "./progress";
import { renderPrompt, renderPromptExtras } from "./prompt";
import { resolveRepo } from "./repo";
import { renderRubric, RUBRIC_RELPATH } from "./rubric";
import { commandExists } from "./shell";
import type { CliOptions, WorktreeResult } from "./types";

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
}

interface DispatchArgs {
  context: PrepareContext;
  env: NodeJS.ProcessEnv;
  options: CliOptions;
  progress: Progress;
  stdout: NodeJS.WritableStream;
  tokens: string[];
}

// The longest path all inputs share, segment by segment.
const commonDirPrefix = (paths: string[]): string => {
  if (paths.length === 0) {
    return "";
  }
  const split = paths.map((p) => p.split("/"));
  const [first] = split;
  let i = 0;
  while (i < first.length && split.every((parts) => parts[i] === first[i])) {
    i += 1;
  }
  return first.slice(0, i).join("/");
};

// The shared parent directory of the fanned-out worktrees, handed to the watcher
// as its `match`. Scoping to the parent (not the leaf) keeps a single-issue fanout
// in the same scope as a batch one. Disjoint trees share no parent → undefined
// ("don't narrow").
export const worktreeMatch = (paths: string[]): string | undefined =>
  commonDirPrefix(paths.map(dirname)) || undefined;

const watcherNote = (pid: number, started: boolean): string => {
  if (started) {
    return `started (pid ${pid})`;
  }
  return pid ? `already running (pid ${pid})` : "could not start";
};

// Make sure exactly one watcher is running, scoped to these worktrees. The match
// is passed to the watcher (which owns state.json) rather than written here.
// Set CAPTAIN_NO_WATCH=1 to create the worktrees without auto-driving them.
const armWatcher = async (
  worktreePaths: string[],
  env: NodeJS.ProcessEnv,
  stdout: NodeJS.WritableStream
): Promise<void> => {
  if (env.CAPTAIN_NO_WATCH) {
    return;
  }
  const match = worktreeMatch(worktreePaths);
  const { pid, started } = await ensureDaemon(DEFAULT_FLEET, env, match);
  stdout.write(`watcher: ${watcherNote(pid, started)} · captain status\n`);

  // A watcher already running keeps its original scope (it reads match once at
  // boot). If these worktrees fall outside it, it won't adopt them — say so
  // rather than silently dropping them.
  if (!started && pid) {
    const scope = loadState(DEFAULT_FLEET).match;
    const covered = worktreePaths.every((p) => !scope || p.includes(scope));
    if (!covered) {
      stdout.write(
        "  note: outside the running watcher's scope — `captain stop` then re-run to track these\n"
      );
    }
  }
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

const launchViaCmux = async (
  prepared: PreparedIssue,
  env: NodeJS.ProcessEnv,
  focus: boolean,
  progress: Progress
): Promise<void> => {
  progress.step(`opening cmux workspace ${prepared.worktree.branch}`);
  const promptPath = await writePromptFile(prepared.displayId, prepared.prompt);
  openIssueWorkspace({
    branch: prepared.worktree.branch,
    env,
    focus,
    promptPath,
    worktreePath: prepared.worktree.worktreePath,
  });
};

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
  env: NodeJS.ProcessEnv
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
    env
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
        "cmux is not reachable (needed for multi-issue fan-out)"
      );
    }
    if (!commandExists("claude", env)) {
      throw new CliError("claude is not on PATH");
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
      await launchViaCmux(prepared, env, false, scoped);
      progress.done(
        `opened ${prepared.worktree.branch} (${index}/${tokens.length})`
      );
    }

    stdout.write(
      `spawned ${tokens.length} workspaces - each running claude in plan mode from its worktree\n`
    );
    await armWatcher(worktreePaths, env, stdout);
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

  if (cmuxReachable(env) && commandExists("claude", env)) {
    try {
      await launchViaCmux(prepared, env, true, progress);
      progress.done(`opened cmux workspace ${prepared.worktree.branch}`);
      await armWatcher([prepared.worktree.worktreePath], env, stdout);
      return 0;
    } catch {
      // fall through to inline launch if cmux refuses the workspace
    }
  }

  progress.done();
  return launchPlanMode(prepared.worktree.worktreePath, prepared.prompt, env);
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
      "usage: linear-worktree [--print] [--repo <path>] <issue-id|url> [more issue-ids...]",
      2
    );
  }

  const progress = createProgress(options.stderr ?? process.stderr);
  const context: PrepareContext = {
    cwd,
    env,
    progress,
    repoOverride: options.repoOverride,
  };

  try {
    return await dispatch({ context, env, options, progress, stdout, tokens });
  } catch (error) {
    progress.done();
    throw error;
  }
};
