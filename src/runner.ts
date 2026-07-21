import { readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { realCmux } from "./captain/control";
import type { CmuxPort, CmuxWorkspace } from "./captain/control";
import { appendLog, now } from "./captain/log";
import { identityOf, ticketFrom } from "./captain/view";
import { cmuxReachable, isFanOutInput, openIssueWorkspace } from "./cmux";
import { loadAgent, loadDataScope, loadSkills, normalizeAgent } from "./config";
import { CliError, EXIT } from "./errors";
import {
  ensureWorktree,
  existingIssueWorktree,
  fetchOrigin,
  gitCommonDir,
  repoLabel,
  worktreePathFor,
} from "./git";
import { downloadIssueImages, worktreeTmpDir } from "./images";
import { slugify } from "./issue";
import { copyCommand, launchPlanMode } from "./launch";
import { ensureMemoryFile, readMemoryExcerpt } from "./memory";
import { createProgress, withPrefix } from "./progress";
import type { Progress } from "./progress";
import { renderPrompt, renderPromptExtras } from "./prompt";
import { resolveRepo } from "./repo";
import { renderRubric, RUBRIC_RELPATH } from "./rubric";
import { commandExists } from "./shell";
import { isIssueToken, sourceFor } from "./source";
import type {
  CliOptions,
  DispatchOptions,
  Issue,
  WorktreeResult,
} from "./types";

interface PreparedIssue {
  displayId: string;
  prompt: string;
  worktree: WorktreeResult;
}

interface PreparedIssueData {
  displayId: string;
  issue: Issue;
  issueId: string;
  prompt: string;
  slug: string;
  source: string;
}

interface IssueSeed {
  credential: string;
  displayId: string;
  fetch: (env: NodeJS.ProcessEnv) => Promise<Issue | undefined>;
  issueId: string;
  parsedSlug: string;
  source: string;
}

// One launched target's machine-readable identity for `start --json`. Fields
// absent on a given path are omitted (never undefined) so the value stays valid
// JSON: dispatch has no branch, an inline fallback launch has no workspaceId.
// `json` is set only on the single-target launch path (launchOrFallback) to gate
// whether the `{ started: [...] }` line is emitted; it never reaches the payload
// (compactEntry copies only the wire fields).
interface StartedEntry {
  name: string;
  cwd: string;
  branch?: string;
  workspaceId?: string;
  json?: boolean;
}

// Does a cmux workspace own this worktree cwd? The one match rule shared by
// `start --json` id lookup and collapse detection: an exact cwd, or a workspace
// whose cwd ends in the worktree's basename (it collapsed into an existing window).
const ownsCwd = (workspaceCwd: string, path: string): boolean =>
  workspaceCwd === path || workspaceCwd.endsWith(`/${basename(path)}`);

// Resolve the cmux workspace id that owns a worktree cwd (best-effort), so
// `start --json` can hand a driver the id to address later. Undefined when cmux
// can't be reached or nothing matches.
const workspaceIdForCwd = (
  cwd: string,
  workspaces: { id: string; cwd: string }[]
): string | undefined => workspaces.find((w) => ownsCwd(w.cwd, cwd))?.id;

// A retry is reusable only when cmux reports an active tagged agent in the
// exact derived worktree cwd. Snapshotting once lets batch start skip all issue
// and git I/O for reusable tokens without N workspace/top calls.
const activeWorkspacesByCwd = (port: CmuxPort): Map<string, CmuxWorkspace> => {
  const workspaces = port.listWorkspaces();
  if (workspaces.length === 0) {
    return new Map();
  }
  const runs = port.runStates();
  return new Map(
    workspaces
      .filter((workspace) => workspace.id.toLowerCase() in runs)
      .map((workspace) => [workspace.cwd, workspace])
  );
};

// Drop undefined-valued fields so the emitted JSON never carries `undefined`.
const compactEntry = (entry: StartedEntry): StartedEntry => {
  const out: StartedEntry = { cwd: entry.cwd, name: entry.name };
  if (entry.branch !== undefined) {
    out.branch = entry.branch;
  }
  if (entry.workspaceId !== undefined) {
    out.workspaceId = entry.workspaceId;
  }
  return out;
};

interface PrepareContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  progress: Progress;
  repoOverride?: string;
  base?: string;
  // the configured post-implementation skills, loaded once per run
  skills: string[];
  // the data-scope guardrail injected into the brief + rubric, loaded once per run
  dataScope: string;
  // the resolved coding agent (claude | codex), resolved once per run — the
  // brief's plan-step wording and the launch command both depend on it
  agent: string;
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
    workspaces.some((w) => ownsCwd(w.cwd, path));
  return worktreePaths
    .filter((p) => !owned(p))
    .map(
      (p) =>
        `note: ${basename(p)} has no dedicated cmux workspace — its agent likely attached to an existing window. Close that window, then re-run: captain fanout ${ticketFrom(basename(p))?.toUpperCase() ?? basename(p)}`
    );
};

// jest sizes its default worker pool from the machine (cores - 1) and reads
// caps only from its own config/CLI — nothing captain injects into the agent
// env can bound it (unlike vitest, see DEFAULT_AGENT_ENV). So warn at launch
// when the target checkout's jest config is uncapped: N fleet agents each
// spawning a full pool of multi-GB ts-jest workers is exactly what exhausted
// a 48GB machine on 2026-07-06. Config files only (a package.json `jest` block
// is rare enough to skip); missing/unreadable files fail safe to no note.
const JEST_CONFIG_DIRS = [".", "src"];
const JEST_CONFIG_NAMES = [
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
  "jest.config.json",
];

export const uncappedJestNote = (checkoutPath: string): string | null => {
  for (const dir of JEST_CONFIG_DIRS) {
    for (const name of JEST_CONFIG_NAMES) {
      const rel = dir === "." ? name : join(dir, name);
      let text: string;
      try {
        text = readFileSync(join(checkoutPath, rel), "utf-8");
      } catch {
        continue;
      }
      if (text.includes("maxWorkers")) {
        return null;
      }
      return `note: ${rel} has no maxWorkers cap — concurrent fleet test runs can exhaust memory. Cap it in the repo (maxWorkers + workerIdleMemoryLimit); the brief tells agents to pass --maxWorkers=2 meanwhile`;
    }
  }
  return null;
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
  const dir = worktreeTmpDir(displayId);
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
  // the resolved coding agent (claude | codex)
  agent: string;
  // Issue retries may reuse a live cmux workspace for the same worktree.
  // Dispatch runs in the current checkout, where an existing workspace may be
  // unrelated, so only issue targets enable this.
  reuseExisting?: boolean;
}

interface LaunchOutcome {
  reused: boolean;
  workspaceId?: string;
}

// Resolve the agent for a run, flag-over-config: an explicit `--agent` value
// wins, else the config/env default. Both funnel through normalizeAgent
// (config.ts), so an unknown name always degrades to claude.
const resolveAgent = (
  flag: string | undefined,
  env: NodeJS.ProcessEnv
): string => (flag === undefined ? loadAgent(env) : normalizeAgent(flag));

// Ledger the launch under the same identity approve/reject will log later
// (identityOf over cwd + label + repo → `${repo}-${ticket}` when both derive),
// so `captain gain` can join launch→decision/verdict by name for its
// latency-to-detection metric. Appended only after a launch actually happened,
// and fail-soft like every other peripheral signal: an unwritable ledger must
// never abort a launch (or masquerade as a cmux refusal to the caller's catch).
const logLaunch = (
  cwd: string,
  label: string,
  env: NodeJS.ProcessEnv
): void => {
  try {
    appendLog(
      {
        kind: "launch",
        name: identityOf(cwd, label, repoLabel(cwd, env)).name,
        ts: now(),
      },
      env
    );
  } catch {
    // best-effort side-channel — the launch already happened; gain just
    // loses this latency sample
  }
};

const launchViaCmux = async (
  target: LaunchTarget,
  focus: boolean
): Promise<LaunchOutcome> => {
  const port = realCmux(target.env);
  if (target.reuseExisting) {
    // Same-cwd alone is not enough: cmux groups can leave an anchor or stale
    // shell in the worktree. A run-state key means `cmux top` sees an actual
    // tagged agent process (the same signal surface.ts trusts). Fail-soft top
    // output therefore degrades to a fresh launch, never a false reuse.
    const existing = activeWorkspacesByCwd(port).get(target.cwd);
    if (existing) {
      return { reused: true, workspaceId: existing.id };
    }
  }

  target.progress.step(`opening cmux workspace ${target.label}`);
  const promptPath = await writePromptFile(target.displayId, target.prompt);
  openIssueWorkspace({
    agent: target.agent,
    branch: target.label,
    env: target.env,
    focus,
    promptPath,
    worktreePath: target.cwd,
  });
  // The decision-side identity falls back to cmux's OWN workspace name, which
  // can differ from our requested label when cmux dedupes/renames it. Resolve
  // it once after launch for both the ledger join key and --json id.
  const launched = port
    .listWorkspaces()
    .find((workspace) => ownsCwd(workspace.cwd, target.cwd));
  logLaunch(target.cwd, launched?.name ?? target.label, target.env);
  return { reused: false, workspaceId: launched?.id };
};

// The single-target launch strategy, shared by single-issue fanout and dispatch:
// cmux if reachable, else inline plan mode. (The multi-issue loop calls
// launchViaCmux directly — a refused workspace there surfaces as a collapse note,
// not a fallback.) `meta` carries the single-target --json identity: workspaceId
// is resolved after a successful cmux launch (absent on the inline-fallback path),
// and `meta.json` gates whether anything is emitted at all.
const launchOrFallback = async (
  target: LaunchTarget,
  stdout: NodeJS.WritableStream,
  meta?: StartedEntry
): Promise<number> => {
  const { env, progress } = target;
  const emitStarted = (workspaceId?: string): void => {
    if (!meta?.json) {
      return;
    }
    stdout.write(
      `${JSON.stringify({
        started: [
          compactEntry({
            branch: meta.branch,
            cwd: meta.cwd,
            name: meta.name,
            workspaceId,
          }),
        ],
      })}\n`
    );
  };
  if (cmuxReachable(env) && commandExists(target.agent, env)) {
    try {
      const outcome = await launchViaCmux(target, true);
      progress.done(
        `${outcome.reused ? "reusing" : "opened"} cmux workspace ${target.label}`
      );
      if (meta?.json) {
        emitStarted(outcome.workspaceId);
      } else {
        if (outcome.reused) {
          stdout.write(`reusing existing cmux workspace ${target.label}\n`);
        }
        stdout.write("follow along: captain status\n");
      }
      return 0;
    } catch {
      // fall through to inline launch if cmux refuses the workspace
    }
  }
  progress.done();
  // Inline launch blocks for the whole interactive session — ledger it first.
  logLaunch(target.cwd, target.label, env);
  const status = launchPlanMode(target.cwd, target.prompt, env, target.agent);
  // Inline launch: no cmux workspace to address, so workspaceId is omitted.
  emitStarted();
  return status;
};

const targetOf = (
  prepared: PreparedIssue,
  progress: Progress,
  env: NodeJS.ProcessEnv,
  agent: string,
  reuseExisting = true
): LaunchTarget => ({
  agent,
  cwd: prepared.worktree.worktreePath,
  displayId: prepared.displayId,
  env,
  label: prepared.worktree.branch,
  progress,
  prompt: prepared.prompt,
  reuseExisting,
});

// Keep `.captain/` (rubric + verdict) out of every worktree's diff. Linked
// worktrees share the main checkout's `.git/info/exclude` (a linked worktree's
// own `.git` is a FILE, so we resolve the common git dir rather than assume a
// `.git` directory), so one append covers the whole fleet; nothing is committed.
const excludeCaptainDir = async (
  repoRoot: string,
  env: NodeJS.ProcessEnv
): Promise<void> => {
  const excludePath = join(gitCommonDir(repoRoot, env), "info", "exclude");
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
  skills: string[],
  dataScope: string,
  agent: string,
  source = "Linear"
): Promise<string> => {
  const { text } = renderRubric(issue, displayId, dataScope, source);
  await mkdir(join(worktreePath, ".captain"), { recursive: true });
  await writeFile(join(worktreePath, RUBRIC_RELPATH), text);
  await excludeCaptainDir(repoRoot, env);
  const memoryPath = ensureMemoryFile(repoRoot, env);
  return (
    prompt +
    renderPromptExtras({
      agent,
      dataScope,
      memory: readMemoryExcerpt(repoRoot, env),
      memoryPath,
      rubricPath: RUBRIC_RELPATH,
      skills,
      workflow: true,
    })
  );
};

// Parse the source-owned token without doing I/O. The resulting issue id is
// enough to derive the worktree cwd and identify a live retry before fetching
// issue context or touching git.
const issueSeed = (token: string): IssueSeed => {
  const firstWord = token.trim().split(/\s+/u)[0] ?? token;
  const source = sourceFor(firstWord);
  if (!source) {
    throw new CliError(
      `not a recognized issue token: ${firstWord}`,
      EXIT.USAGE,
      "USAGE"
    );
  }
  const { parsed, fetch } = source.prepare(token);
  return {
    credential: source.credential,
    displayId: parsed.displayId,
    fetch,
    issueId: parsed.issueId,
    parsedSlug: parsed.slug,
    source: source.name,
  };
};

const requireIssueCredential = (
  seed: IssueSeed,
  env: NodeJS.ProcessEnv
): void => {
  if (!env[seed.credential]) {
    throw new CliError(
      `cannot fetch ${seed.source} issue ${seed.displayId} — set ${seed.credential}, then retry`,
      EXIT.GENERIC,
      "ISSUE_FETCH_FAILED"
    );
  }
};

// Fetch and render the source-owned part of an issue without touching git or a
// worktree. Fan-out starts all source requests together after the repository
// fetch precondition passes, so independent Linear/donebear requests overlap.
const prepareIssueData = async (
  seed: IssueSeed,
  context: PrepareContext
): Promise<PreparedIssueData> => {
  const { env, progress } = context;
  progress.step(`fetching ${seed.displayId} from ${seed.source}`);
  const issue = await seed.fetch(env);
  if (!issue) {
    throw new CliError(
      `cannot fetch ${seed.source} issue ${seed.displayId} — verify the issue id, credentials, and network, then retry`,
      EXIT.GENERIC,
      "ISSUE_FETCH_FAILED"
    );
  }

  const slug = seed.parsedSlug || (issue.title ? slugify(issue.title) : "");

  let prompt = renderPrompt(issue, seed.displayId, seed.source);
  if (issue.description && env.LINEAR_API_KEY) {
    progress.step("downloading screenshots");
    const screenshots = await downloadIssueImages(
      issue.description,
      seed.displayId,
      env.LINEAR_API_KEY
    );
    if (screenshots.length > 0) {
      prompt += `\nScreenshots for this ticket (view with the Read tool):\n${screenshots.join("\n")}`;
    }
  }

  return {
    displayId: seed.displayId,
    issue,
    issueId: seed.issueId,
    prompt,
    slug,
    source: seed.source,
  };
};

// Serialize the mutation-heavy half: worktree creation, rubric/exclude writes,
// and memory wiring. Keeping this out of prepareIssueData makes fan-out network
// concurrency explicit without racing git worktree operations.
const materializeIssue = async (
  data: PreparedIssueData,
  context: PrepareContext,
  repoRoot: string
): Promise<PreparedIssue> => {
  const { env, progress } = context;
  progress.step("creating worktree");
  const worktree = await ensureWorktree({
    base: context.base,
    env,
    issueId: data.issueId,
    repoRoot,
    skipFetch: true,
    slug: data.slug,
  });

  const prompt = await withLoopExtras(
    data.prompt,
    worktree.worktreePath,
    repoRoot,
    data.issue,
    data.displayId,
    env,
    context.skills,
    context.dataScope,
    context.agent,
    data.source
  );

  return { displayId: data.displayId, prompt, worktree };
};

interface ReusableIssue {
  workspace: CmuxWorkspace;
  worktree: WorktreeResult;
}

const reusableIssue = (
  seed: IssueSeed,
  repoRoot: string,
  activeByCwd: Map<string, CmuxWorkspace>,
  env: NodeJS.ProcessEnv
): ReusableIssue | undefined => {
  const cwd = worktreePathFor(repoRoot, seed.issueId);
  const workspace = activeByCwd.get(cwd);
  if (!workspace) {
    return undefined;
  }
  const worktree = existingIssueWorktree(repoRoot, seed.issueId, env);
  return worktree ? { workspace, worktree } : undefined;
};

interface LaunchFleetArgs extends DispatchArgs {
  agent: string;
  dataByIndex: Map<number, PreparedIssueData>;
  repoRoot: string;
  reusable: (ReusableIssue | undefined)[];
  scopedContexts: PrepareContext[];
  seeds: IssueSeed[];
}

const launchPreparedFleet = async ({
  agent,
  dataByIndex,
  env,
  options,
  progress,
  repoRoot,
  reusable,
  scopedContexts,
  seeds,
  stdout,
  tokens,
}: LaunchFleetArgs): Promise<number> => {
  const worktreePaths: string[] = [];
  const launched: {
    name: string;
    branch: string;
    cwd: string;
    workspaceId?: string;
  }[] = [];
  let reused = 0;
  for (let index = 0; index < seeds.length; index += 1) {
    const scoped = scopedContexts[index];
    const existing = reusable[index];
    if (existing) {
      reused += 1;
      worktreePaths.push(existing.worktree.worktreePath);
      launched.push({
        branch: existing.worktree.branch,
        cwd: existing.worktree.worktreePath,
        name: existing.worktree.branch,
        workspaceId: existing.workspace.id,
      });
      scoped.progress.done(
        `reusing ${existing.worktree.branch} (${index + 1}/${tokens.length})`
      );
      continue;
    }
    const data = dataByIndex.get(index);
    if (!data) {
      throw new CliError(
        `internal error preparing ${seeds[index].displayId}`,
        EXIT.GENERIC,
        "PREPARE_FAILED"
      );
    }
    const prepared = await materializeIssue(data, scoped, repoRoot);
    worktreePaths.push(prepared.worktree.worktreePath);
    const outcome = await launchViaCmux(
      targetOf(prepared, scoped.progress, env, agent),
      false
    );
    if (outcome.reused) {
      reused += 1;
    }
    launched.push({
      branch: prepared.worktree.branch,
      cwd: prepared.worktree.worktreePath,
      name: prepared.worktree.branch,
      workspaceId: outcome.workspaceId,
    });
    progress.done(
      `${outcome.reused ? "reusing" : "opened"} ${prepared.worktree.branch} (${index + 1}/${tokens.length})`
    );
  }

  // One workspace listing serves both collapse detection and --json id lookup.
  const workspaces = realCmux(env).listWorkspaces();
  if (options.json) {
    const started = launched.map((item) =>
      compactEntry({
        ...item,
        workspaceId:
          item.workspaceId ?? workspaceIdForCwd(item.cwd, workspaces),
      })
    );
    stdout.write(`${JSON.stringify({ started })}\n`);
    return 0;
  }
  stdout.write(
    reused === 0
      ? `spawned ${tokens.length} workspaces — each agent drives its own pipeline to PR-ready\n`
      : `ready ${tokens.length} workspaces — ${tokens.length - reused} launched, ${reused} reused\n`
  );
  // All tokens in one invocation share a repo, so one worktree speaks for all.
  const jestNote = worktreePaths[0] && uncappedJestNote(worktreePaths[0]);
  if (jestNote) {
    stdout.write(`  ${jestNote}\n`);
  }
  for (const note of collapsedWorktreeNotes(worktreePaths, workspaces)) {
    stdout.write(`  ${note}\n`);
  }
  stdout.write("follow along: captain status\n");
  return 0;
};

const dispatch = async ({
  context,
  env,
  options,
  progress,
  stdout,
  tokens,
}: DispatchArgs): Promise<number> => {
  const { agent } = context;
  if (isFanOutInput(tokens, Boolean(options.print))) {
    if (!cmuxReachable(env)) {
      throw new CliError(
        "cmux is not reachable (needed for multi-issue fan-out) — is it running? run `captain install`",
        EXIT.CMUX_UNREACHABLE,
        "CMUX_UNREACHABLE"
      );
    }
    progress.step("resolving repo");
    const repo = resolveRepo({
      cwd: context.cwd,
      env,
      repoOverride: context.repoOverride,
    });
    const scopedContexts = tokens.map((token, index) => ({
      ...context,
      progress: withPrefix(
        progress,
        `[${index + 1}/${tokens.length}] ${token.toUpperCase()} · `
      ),
    }));
    const seeds = tokens.map(issueSeed);
    const activeByCwd = activeWorkspacesByCwd(realCmux(env));
    const reusable = seeds.map((seed) =>
      reusableIssue(seed, repo.repoRoot, activeByCwd, env)
    );
    const pendingIndexes = reusable.flatMap((item, index) =>
      item ? [] : [index]
    );
    if (pendingIndexes.length > 0 && !commandExists(agent, env)) {
      throw new CliError(
        `${agent} is not on PATH — install it, then \`captain install\``,
        EXIT.USAGE,
        "MISSING_DEPENDENCY"
      );
    }
    for (const index of pendingIndexes) {
      requireIssueCredential(seeds[index], env);
    }
    // Validate repository freshness before source requests. This is slightly
    // less overlapped than starting both together, but a failed git precondition
    // cannot strand an unobserved rejecting source promise. An all-reused batch
    // still performs neither fetch.
    if (pendingIndexes.length > 0) {
      progress.step("git fetch origin");
      fetchOrigin(repo.repoRoot, env);
    }
    const pendingData = await Promise.all(
      pendingIndexes.map((index) =>
        prepareIssueData(seeds[index], scopedContexts[index])
      )
    );
    const dataByIndex = new Map(
      pendingIndexes.map((pendingIndex, index) => [
        pendingIndex,
        pendingData[index],
      ])
    );

    return launchPreparedFleet({
      agent,
      context,
      dataByIndex,
      env,
      options,
      progress,
      repoRoot: repo.repoRoot,
      reusable,
      scopedContexts,
      seeds,
      stdout,
      tokens,
    });
  }

  progress.step("resolving repo");
  const repo = resolveRepo({
    cwd: context.cwd,
    env,
    repoOverride: context.repoOverride,
  });
  const seed = issueSeed(tokens.join(" "));
  // A real launch retry can be answered from cmux + the derived worktree path
  // alone. Do this before issue/git I/O and before rewriting the rubric hash.
  // `--print` deliberately stays on the preparation path. Agent selection does
  // not force a duplicate while an agent is already active in this worktree.
  if (!options.print && cmuxReachable(env)) {
    const existing = reusableIssue(
      seed,
      repo.repoRoot,
      activeWorkspacesByCwd(realCmux(env)),
      env
    );
    if (existing) {
      progress.done(`reusing cmux workspace ${existing.worktree.branch}`);
      if (options.json) {
        stdout.write(
          `${JSON.stringify({
            started: [
              compactEntry({
                branch: existing.worktree.branch,
                cwd: existing.worktree.worktreePath,
                name: existing.worktree.branch,
                workspaceId: existing.workspace.id,
              }),
            ],
          })}\n`
        );
      } else {
        stdout.write(
          `reusing existing cmux workspace ${existing.worktree.branch}\n`
        );
        stdout.write("follow along: captain status\n");
      }
      return 0;
    }
  }
  requireIssueCredential(seed, env);
  progress.step("git fetch origin");
  fetchOrigin(repo.repoRoot, env);
  const prepared = await materializeIssue(
    await prepareIssueData(seed, context),
    context,
    repo.repoRoot
  );

  if (options.print) {
    const cdCommand = `cd ${prepared.worktree.worktreePath}`;
    progress.done();
    if (options.json) {
      stdout.write(
        `${JSON.stringify({
          cwd: prepared.worktree.worktreePath,
          name: prepared.worktree.branch,
          prompt: prepared.prompt,
        })}\n`
      );
      return 0;
    }
    // Copy the cd command for an interactive human only. A piped/automated run
    // (the /captain driver, tests) must never touch the real clipboard.
    const copied = Boolean((stdout as Partial<NodeJS.WriteStream>).isTTY);
    if (copied) {
      copyCommand(cdCommand, env);
    }
    stdout.write(
      `agent prompt:\n${prepared.prompt}\n\n${copied ? "copied" : "run"}:\n${cdCommand}\n`
    );
    return 0;
  }

  const singleJestNote =
    !options.json && uncappedJestNote(prepared.worktree.worktreePath);
  if (singleJestNote) {
    stdout.write(`  ${singleJestNote}\n`);
  }
  return launchOrFallback(targetOf(prepared, progress, env, agent), stdout, {
    branch: prepared.worktree.branch,
    cwd: prepared.worktree.worktreePath,
    json: Boolean(options.json),
    name: prepared.worktree.branch,
  });
};

// The worktree fan-out path: one worktree + cmux workspace per issue token. Each
// token routes to its own source in prepareIssueData (Linear id/URL or donebear task
// URL/UUID), so a single invocation can mix both.
export const runLinearWorktree = async (
  options: CliOptions
): Promise<number> => {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const tokens = options.tokens.length > 0 ? options.tokens : readStdinTokens();

  if (tokens.length === 0) {
    throw new CliError(
      "usage: captain start [--print] [--repo-path <path>] <issue-id|url> [more issue-ids...]",
      EXIT.USAGE,
      "USAGE"
    );
  }
  if (
    options.print &&
    tokens.length > 1 &&
    tokens.every((token) => isIssueToken(token))
  ) {
    throw new CliError(
      "--print accepts one issue at a time because it prepares a worktree; run it once per issue",
      EXIT.USAGE,
      "USAGE"
    );
  }

  const progress = createProgress(options.stderr ?? process.stderr);
  const context: PrepareContext = {
    agent: resolveAgent(options.agent, env),
    base: options.base,
    cwd,
    dataScope: loadDataScope(env),
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
      'usage: captain start "<task>" [--name <slug>] [--repo-path <path>]',
      EXIT.USAGE,
      "USAGE"
    );
  }

  const progress = createProgress(options.stderr ?? process.stderr);
  const agent = resolveAgent(options.agent, env);
  try {
    progress.step("resolving repo");
    const repo = resolveRepo({ cwd, env, repoOverride: options.repoOverride });

    const name = slugify(options.name || task);
    if (!name) {
      throw new CliError(
        "could not derive a workspace name from the task — pass --name <slug>",
        EXIT.USAGE,
        "USAGE"
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
      loadSkills(env),
      loadDataScope(env),
      agent
    );

    if (options.print) {
      progress.done();
      if (options.json) {
        // Dispatch runs in the checkout itself — no branch, so omit it.
        stdout.write(
          `${JSON.stringify({ cwd: repo.repoRoot, name, prompt })}\n`
        );
        return 0;
      }
      stdout.write(`agent prompt:\n${prompt}\n`);
      return 0;
    }

    const dispatchJestNote = !options.json && uncappedJestNote(repo.repoRoot);
    if (dispatchJestNote) {
      stdout.write(`  ${dispatchJestNote}\n`);
    }
    return launchOrFallback(
      {
        agent,
        cwd: repo.repoRoot,
        displayId: name,
        env,
        label: name,
        progress,
        prompt,
      },
      stdout,
      // Dispatch runs in the checkout itself — no branch to report.
      { cwd: repo.repoRoot, json: Boolean(options.json), name }
    );
  } catch (error) {
    progress.done();
    throw error;
  }
};

// The single entry point behind `captain start`: route to the issue worktree
// fan-out (Linear or donebear) or the free-form current-dir dispatch by
// inspecting the first token. Empty tokens fall through to runLinearWorktree,
// which reads stdin then errors.
export const runStart = (
  options: CliOptions & { name?: string }
): Promise<number> => {
  const [first] = options.tokens;
  if (first && !isIssueToken(first)) {
    return runDispatch({
      agent: options.agent,
      cwd: options.cwd,
      env: options.env,
      json: options.json,
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
