import { createHash } from "node:crypto";

import { CliError, EXIT } from "../errors";
import { run, shellQuote } from "../shell";
import { realCmux } from "./control";
import type { CmuxPort } from "./control";
import {
  msg,
  renderGain,
  renderStatus,
  renderSummary,
  style,
  useColor,
} from "./format";
import type { Style } from "./format";
import { computeGain, parseSince } from "./gain";
import { appendLog, now, readLog } from "./log";
import { fleetRows, readVerdict } from "./surface";
import type { Verdict } from "./verdict";
import { groupCounts, mergeOrderHints, ticketFrom } from "./view";
import type { FleetRow } from "./view";

const styleFor = (out: NodeJS.WritableStream): Style => style(useColor(out));

// A token that loosely matched more than one worktree (the same ticket fanned
// into two repos). We refuse to guess; `candidates` are the fully-qualified
// `${repo}-${ticket}` names to retype.
export interface Ambiguity {
  token: string;
  candidates: string[];
}

export interface ResolvedTargets {
  matched: FleetRow[];
  unknown: string[];
  ambiguous: Ambiguity[];
}

// Resolve a user-friendly target spec to rows. Accepts "all", a repo label
// ("linkiq" → every matching row in the pool), or a comma-separated list of
// fully-qualified names ("frontyard-tig-424"), bare tickets ("tig-430"),
// substrings, or workspace ids — never a pasted uuid.
//
// Cross-repo collisions resolve natively: a fully-qualified name or a workspace
// id always picks exactly one row, so it disambiguates a ticket that runs in
// two repos. A bare/substring token that hits more than one worktree is
// reported as `ambiguous` (with the qualified names to retype) instead of being
// silently first-matched to the wrong one.
export const resolveTargets = (
  pool: FleetRow[],
  spec: string
): ResolvedTargets => {
  if (spec === "all") {
    return { ambiguous: [], matched: pool, unknown: [] };
  }
  const matched: FleetRow[] = [];
  const unknown: string[] = [];
  const ambiguous: Ambiguity[] = [];
  const push = (hit: FleetRow): void => {
    if (!matched.includes(hit)) {
      matched.push(hit);
    }
  };
  for (const raw of spec.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!token) {
      continue;
    }
    // A repo label addresses the whole repo's batch at once.
    const repoHits = pool.filter((r) => r.repo?.toLowerCase() === token);
    if (repoHits.length > 0) {
      for (const hit of repoHits) {
        push(hit);
      }
      continue;
    }
    // A fully-qualified handle — the `${repo}-${ticket}` name or a workspace id
    // — resolves to exactly one row. This is how you target one of several
    // worktrees that share a ticket across repos, no uuid needed.
    const exact = pool.find(
      (r) =>
        r.workspaceId.toLowerCase() === token || r.name.toLowerCase() === token
    );
    if (exact) {
      push(exact);
      continue;
    }
    // A bare ticket ("tig-1") resolves by EXACT ticket, never a substring —
    // otherwise `tig-1` would silently approve `tig-10` (and with both present,
    // exact `tig-1` was wrongly refused as ambiguous). Unique → take it; the
    // same ticket fanned into two repos → ambiguous, qualify with the repo.
    if (ticketFrom(token) === token) {
      const ticketHits = pool.filter((r) => r.ticket?.toLowerCase() === token);
      if (ticketHits.length === 1) {
        push(ticketHits[0]);
      } else if (ticketHits.length > 1) {
        ambiguous.push({
          candidates: ticketHits.map((r) => r.name),
          token: raw.trim(),
        });
      } else {
        unknown.push(raw.trim());
      }
      continue;
    }
    // Otherwise a loose substring — a name fragment or a partial workspace id
    // (not a ticket, so no `tig-1`/`tig-10` bleed): unique → take it, colliding
    // → refuse to guess and report the qualified names.
    const loose = pool.filter(
      (r) =>
        r.name.toLowerCase().includes(token) ||
        r.workspaceId.toLowerCase().includes(token)
    );
    if (loose.length === 1) {
      push(loose[0]);
    } else if (loose.length > 1) {
      ambiguous.push({
        candidates: loose.map((r) => r.name),
        token: raw.trim(),
      });
    } else {
      unknown.push(raw.trim());
    }
  }
  return { ambiguous, matched, unknown };
};

export interface StatusOptions {
  json?: boolean;
  // friendly ticket/workspace refs, using the same resolution rules as
  // approve/reject. Applied after --repo so that filter can disambiguate a
  // ticket shared across repos.
  refs?: string;
  // narrow to one repo's worktrees (label match, e.g. "linkiq")
  repo?: string;
  // only the NEEDS YOU group
  needs?: boolean;
  // only the READY group
  ready?: boolean;
  // compact view: group counts + the NEEDS YOU rows only — a near-zero-token
  // poll. Composes with refs/--repo. Honoured by both --json and the TTY render.
  summary?: boolean;
  // Compare the current aggregate fleet snapshot with a token returned by an
  // earlier `--summary --json` call. This is deliberately caller-held state:
  // Captain persists nothing and simply reports whether the live view changed.
  since?: string;
  // --watch: a stateless foreground live view that re-renders on a timer. NOT a
  // daemon — it holds no state, every tick re-derives the fleet from scratch
  // (same as re-running `status`), and Ctrl-C ends it. The agent driver does
  // NOT use this; its heartbeat is a backgrounded sleep that re-invokes its turn
  // (see the captain skill). This is purely the human's terminal view.
  watch?: boolean;
  // --watch poll interval in seconds (default 5). Ignored without --watch.
  interval?: number;
}

// Thin fs edge: the branch's changed files vs origin's default branch.
// Fail-soft ([]): a missing origin/HEAD or a deleted worktree must never break
// `status`.
const changedFiles = (cwd: string, env: NodeJS.ProcessEnv): string[] => {
  const head = run(
    "git",
    ["-C", cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { env }
  );
  if (head.status !== 0) {
    return [];
  }
  const diff = run(
    "git",
    ["-C", cwd, "diff", "--name-only", `${head.stdout.trim()}...HEAD`],
    { env }
  );
  if (diff.status !== 0) {
    return [];
  }
  return diff.stdout.split("\n").filter(Boolean);
};

// Probe cmux BEFORE deriving anything: a dead daemon makes every list/feed call
// fail soft to empty, which a driver would read as "all done". On an
// unreachable daemon this writes a structured error with a dedicated exit code
// and returns true so the caller bails, instead of rendering a phantom-empty
// fleet. Shared by `status` and `gain`.
const cmuxUnreachable = (
  port: CmuxPort,
  options: { json?: boolean },
  out: NodeJS.WritableStream
): boolean => {
  if (port.reachable()) {
    return false;
  }
  process.exitCode = EXIT.CMUX_UNREACHABLE;
  const message =
    "cmux is not reachable — is it running? run 'captain install'";
  if (options.json) {
    out.write(
      `${JSON.stringify({ error: { message, type: "CMUX_UNREACHABLE" } })}\n`
    );
  } else {
    out.write(`${msg.err(styleFor(out), message)}\n`);
  }
  return true;
};

const assertCmuxReachable = (port: CmuxPort): void => {
  if (!port.reachable()) {
    throw new CliError(
      "cmux is not reachable — is it running? run 'captain install'",
      EXIT.CMUX_UNREACHABLE,
      "CMUX_UNREACHABLE"
    );
  }
};

const badRef = (message: string): CliError =>
  new CliError(message, EXIT.USAGE, "BAD_REF");

const badOptions = (message: string): CliError =>
  new CliError(message, EXIT.USAGE, "BAD_OPTIONS");

const validateStatusOptions = (options: StatusOptions): void => {
  if (options.needs && options.ready) {
    throw badOptions("--needs and --ready cannot be used together");
  }
  if (options.summary && (options.needs || options.ready)) {
    throw badOptions("--summary cannot be combined with --needs or --ready");
  }
  if (
    options.since !== undefined &&
    (!options.summary || !options.json || options.watch)
  ) {
    throw badOptions(
      "--since requires --summary --json and cannot be used with --watch"
    );
  }
};

const repoRows = (rows: FleetRow[], raw: string): FleetRow[] => {
  const token = raw.trim().toLowerCase();
  const repos = [
    ...new Set(rows.flatMap((row) => (row.repo ? [row.repo] : []))),
  ].toSorted((a, b) => a.localeCompare(b));
  const exact = repos.find((repo) => repo.toLowerCase() === token);
  if (exact) {
    return rows.filter((row) => row.repo === exact);
  }
  const matches = repos.filter((repo) => repo.toLowerCase().includes(token));
  if (matches.length === 1) {
    return rows.filter((row) => row.repo === matches[0]);
  }
  if (matches.length === 0) {
    throw badRef(`no Captain repo matches: ${raw}`);
  }
  throw badRef(
    `"${raw}" is an ambiguous repo — use one of: ${matches.join(", ")}`
  );
};

// Hash only the summary/action contract. Raw busy/idle/unknown churn inside the
// IN FLIGHT group does not change counts and cannot create a new action, so it
// must not wake a polling driver. Missing targeted refs are part of the token so
// a disappearing worktree produces exactly one transition.
const fleetSnapshot = (
  counts: ReturnType<typeof groupCounts>,
  needsYou: FleetRow[],
  missing: string[]
): string => {
  const projection = {
    counts,
    missing: missing.toSorted((a, b) => a.localeCompare(b)),
    needsYou: needsYou
      .map((row) => ({
        gate: row.gate,
        group: row.group,
        identity: row.name,
        nextCommand: row.nextCommand,
        summary: row.summary,
        verdict: row.verdict,
      }))
      .toSorted((a, b) => a.identity.localeCompare(b.identity)),
  };
  return createHash("sha256")
    .update(JSON.stringify(projection))
    .digest("hex")
    .slice(0, 16);
};

// The one read surface: the fleet view derived live from cmux + the worktrees,
// grouped with the few that need a decision on top — each carrying its inline
// resolve command. refs/--repo/--needs/--ready narrow the view. One independent,
// stateless derivation per call.
const statusOnce = (
  options: StatusOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): void => {
  if (cmuxUnreachable(port, options, out)) {
    return;
  }
  let rows = fleetRows(port);
  let missing: string[] = [];
  if (options.repo) {
    rows = repoRows(rows, options.repo);
  }
  if (options.refs) {
    const { ambiguous, matched, unknown } = resolveTargets(rows, options.refs);
    // A first targeted poll stays strict so typos never become a valid empty
    // baseline. Once the caller presents a valid snapshot, a missing ref is a
    // normal completion/removal transition; ambiguity still always errors.
    if (
      ambiguous.length > 0 ||
      (unknown.length > 0 && options.since === undefined)
    ) {
      const parts = [
        unknown.length > 0
          ? `no Captain worktree matches: ${unknown.join(", ")}`
          : "",
        ...ambiguous.map(
          (a) =>
            `"${a.token}" is ambiguous — qualify it: ${a.candidates.join(", ")}`
        ),
      ].filter(Boolean);
      throw badRef(parts.join("; "));
    }
    missing = unknown;
    rows = matched;
  }
  // --summary: counts for every group + full detail for NEEDS YOU only. Counts
  // come off the (repo/ref-filtered) full set, so they stay honest regardless
  // of any group-narrowing flags.
  if (options.summary) {
    const counts = groupCounts(rows);
    const needsYou = rows.filter((r) => r.group === "needs-you");
    if (options.json) {
      const snapshot = fleetSnapshot(counts, needsYou, missing);
      if (options.since === snapshot) {
        out.write(`${JSON.stringify({ changed: false, snapshot })}\n`);
        return;
      }
      out.write(
        `${JSON.stringify({
          ...(options.since === undefined ? {} : { changed: true }),
          counts,
          ...(missing.length === 0 ? {} : { missing }),
          needsYou,
          snapshot,
        })}\n`
      );
      return;
    }
    out.write(renderSummary(rows, styleFor(out)));
    return;
  }
  if (options.needs) {
    rows = rows.filter((r) => r.group === "needs-you");
  }
  if (options.ready) {
    rows = rows.filter((r) => r.group === "ready");
  }
  if (options.json) {
    out.write(`${JSON.stringify(rows)}\n`);
    return;
  }
  // Merge-order pass (human-display hint only): runs 2 git calls per ready
  // worktree, so it is reached ONLY on the plain TTY render — the --json and
  // --summary machine paths above all return before this point and never pay
  // the git cost. Only worth a git call when ≥2 worktrees are ready.
  const ready = rows.filter((r) => r.group === "ready");
  const overlaps =
    ready.length >= 2
      ? mergeOrderHints(
          ready.map((r) => ({
            files: changedFiles(r.cwd, process.env),
            name: r.name,
            repo: r.repo ?? "?",
            workspaceId: r.workspaceId,
          }))
        )
      : {};
  out.write(renderStatus(rows, styleFor(out), { overlaps }));
};

// The status entry point. Without --watch it derives the view once and returns
// (the machine/one-shot path every script and the agent driver use). With
// --watch it re-renders on a timer for a human watching a terminal — a
// stateless foreground loop, NOT a daemon: it persists nothing, every tick is
// an independent `statusOnce`, and Ctrl-C (SIGINT) ends it. Returns a stop()
// handle in watch mode so callers/tests can tear the loop down deterministically.
export const status = (
  options: StatusOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): (() => void) | undefined => {
  validateStatusOptions(options);
  if (!options.watch) {
    statusOnce(options, out, port);
    return undefined;
  }
  const seconds =
    typeof options.interval === "number" &&
    Number.isFinite(options.interval) &&
    options.interval > 0
      ? options.interval
      : 5;
  const isTty = (out as Partial<NodeJS.WriteStream>).isTTY === true;
  const render = (): void => {
    // Clear+home on a TTY so each tick repaints in place; on a pipe just append.
    if (isTty && !options.json) {
      out.write("\u001B[2J\u001B[H");
    }
    if (!options.json) {
      out.write(
        `${styleFor(out).dim(`captain status — watching every ${seconds}s · Ctrl-C to exit`)}\n`
      );
    }
    statusOnce(options, out, port);
  };
  // Paint immediately, then again on each tick.
  render();
  const renderTick = (): void => {
    try {
      render();
    } catch (error) {
      // A targeted workspace disappearing is a normal watch transition. The
      // first render still validates refs through the CLI error boundary; later
      // ticks surface the typed error inline and keep the foreground watch alive.
      if (!(error instanceof CliError)) {
        throw error;
      }
      if (options.json) {
        out.write(
          `${JSON.stringify({
            error: {
              message: error.message,
              type: error.errorType ?? "GENERIC",
            },
          })}\n`
        );
      } else {
        out.write(`${msg.err(styleFor(out), error.message)}\n`);
      }
    }
  };
  const handle = setInterval(renderTick, seconds * 1000);
  const onSigint = (): void => {
    clearInterval(handle);
    if (!options.json) {
      out.write("\n");
    }
    process.exit(0);
  };
  process.on("SIGINT", onSigint);
  return (): void => {
    clearInterval(handle);
    process.removeListener("SIGINT", onSigint);
  };
};

const unresolvedPlanMessage = (resolved: ResolvedTargets): string =>
  [
    resolved.unknown.length > 0
      ? `no plan-ready worktree matches: ${resolved.unknown.join(", ")}`
      : "",
    ...resolved.ambiguous.map(
      (item) =>
        `"${item.token}" is ambiguous — qualify it: ${item.candidates.join(", ")}`
    ),
  ]
    .filter(Boolean)
    .join("; ");

// Resolve controls against the plan-gated subset, but use the full fleet to
// distinguish a genuine typo from a known worktree whose plan already moved
// on. Only a fully unresolved/ambiguous ref is a usage error; comma lists with
// at least one plan match preserve the established partial-success contract.
const resolvePlanTargets = (port: CmuxPort, spec: string): ResolvedTargets => {
  const rows = fleetRows(port);
  const resolved = resolveTargets(
    rows.filter((row) => row.gate?.kind === "plan"),
    spec
  );
  if (
    resolved.matched.length === 0 &&
    (resolved.unknown.length > 0 || resolved.ambiguous.length > 0)
  ) {
    const known = resolveTargets(rows, spec);
    if (known.matched.length === 0) {
      throw badRef(unresolvedPlanMessage(resolved));
    }
  }
  return resolved;
};

const appendDecision = (
  record: Parameters<typeof appendLog>[0],
  unlogged: string[]
): void => {
  try {
    appendLog(record);
  } catch {
    // The cmux control operation is authoritative. A local telemetry write must
    // never report a successful approval/rejection as failed.
    unlogged.push(record.name);
  }
};

// Approve plan(s): reply to the cmux exit-plan feed item directly — there is
// no state to update and no watcher to hand off to, so the reply IS the
// approval; the agent resumes and self-drives the rest of its brief.
export const approve = (
  spec: string,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env),
  options: { json?: boolean } = {}
): void => {
  assertCmuxReachable(port);
  const { matched, unknown, ambiguous } = resolvePlanTargets(port, spec);
  const unlogged: string[] = [];
  // The reply IS the approval (no state), so do it regardless of output mode.
  for (const row of matched) {
    port.replyExitPlan(row.gate?.id ?? "", true);
    appendDecision({ kind: "approve", name: row.name, ts: now() }, unlogged);
  }
  if (options.json) {
    out.write(
      `${JSON.stringify({
        ambiguous,
        approved: matched.map((r) => r.name),
        unknown,
        ...(unlogged.length === 0 ? {} : { unlogged }),
      })}\n`
    );
    return;
  }
  const s = styleFor(out);
  for (const a of ambiguous) {
    out.write(
      `  ${msg.warn(s, `"${a.token}" matches ${a.candidates.length} worktrees — qualify it: ${a.candidates.join(", ")}`)}\n`
    );
  }
  for (const u of unknown) {
    out.write(`  ${msg.warn(s, `no plan-ready worktree matches "${u}"`)}\n`);
  }
  if (matched.length === 0) {
    out.write(s.dim("nothing to approve.\n"));
    return;
  }
  for (const row of matched) {
    out.write(`${msg.ok(s, `approved ${s.bold(row.name)} — implementing`)}\n`);
  }
  if (unlogged.length > 0) {
    out.write(
      `  ${msg.warn(s, `approval succeeded but the audit log failed for: ${unlogged.join(", ")}`)}\n`
    );
  }
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};

// Reject a plan: deliver the feedback first, then reply false to the plan gate
// so the agent receives the why before it resumes planning.
export const reject = (
  ref: string,
  note: string,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env),
  options: { json?: boolean } = {}
): void => {
  const trimmedNote = note.trim();
  if (!trimmedNote) {
    throw badOptions("--note must contain feedback");
  }
  assertCmuxReachable(port);
  const s = styleFor(out);
  const { matched, ambiguous, unknown } = resolvePlanTargets(port, ref);
  const feedback = `Plan rejected — revise it: ${trimmedNote}`;
  const deliveryFailures: FleetRow[] = [];
  // Two-phase fail-closed rejection: every target must receive the feedback
  // before any gate is resolved. Otherwise a partial cmux failure could resume
  // agents without the reason they need to revise safely.
  for (const row of matched) {
    try {
      port.send(row.workspaceId, feedback);
    } catch {
      deliveryFailures.push(row);
    }
  }
  if (deliveryFailures.length > 0) {
    const resend = deliveryFailures
      .map(
        (row) =>
          `cmux send --workspace ${shellQuote(row.workspaceId)} ${shellQuote(`${feedback}\n`)}`
      )
      .join("; ");
    throw new CliError(
      `feedback delivery failed for ${deliveryFailures.map((row) => row.name).join(", ")}; no plan gates were changed. Retry the rejection, or resend manually: ${resend}`,
      EXIT.CMUX_UNREACHABLE,
      "CMUX_UNREACHABLE"
    );
  }

  const rejected: string[] = [];
  const unlogged: string[] = [];
  for (const row of matched) {
    port.replyExitPlan(row.gate?.id ?? "", false);
    appendDecision(
      { kind: "reject", name: row.name, note: trimmedNote, ts: now() },
      unlogged
    );
    rejected.push(row.name);
  }
  if (options.json) {
    out.write(
      `${JSON.stringify({
        ambiguous,
        note: trimmedNote,
        rejected,
        undelivered: [],
        unknown,
        ...(unlogged.length === 0 ? {} : { unlogged }),
      })}\n`
    );
    return;
  }
  // An ambiguous ref (a ticket shared across repos) gets the qualified names to
  // retype; an unknown ref is reported too — every unresolved token, not just
  // the first.
  for (const a of ambiguous) {
    out.write(
      `  ${msg.warn(s, `"${a.token}" matches ${a.candidates.length} worktrees — qualify it: ${a.candidates.join(", ")}`)}\n`
    );
  }
  for (const u of unknown) {
    out.write(`  ${msg.warn(s, `no plan-ready worktree matches "${u}"`)}\n`);
  }
  if (rejected.length === 0) {
    out.write(s.dim("nothing to reject.\n"));
    return;
  }
  for (const name of rejected) {
    out.write(
      `${s.yellow("↩")} ${s.bold(name)} back to planning: ${trimmedNote}\n`
    );
  }
  if (unlogged.length > 0) {
    out.write(
      `  ${msg.warn(s, `rejection succeeded but the audit log failed for: ${unlogged.join(", ")}`)}\n`
    );
  }
  out.write(`${msg.hint(s, "next: captain status")}\n`);
};

export interface GainOptions {
  json?: boolean;
  // a "since" window for the decision-based metrics: "7d" / "24h" / ISO date
  since?: string;
  // opt in to the gh/git merged-PR approximation (one call per unique repo)
  git?: boolean;
}

// Per-row valid verdicts for the criteria-level detail. `row.verdict` is only
// set by rowOf when the on-disk verdict already passed the hash-check against
// the rubric as it exists NOW, so the row itself is the validity gate — no need
// to re-read the rubric and re-run verdictCounts here. We still read the raw
// verdict for its criteria (the row carries only the pass/fail label).
const validVerdicts = (
  rows: FleetRow[]
): { repo?: string; name?: string; verdict: Verdict }[] => {
  const out: { repo?: string; name?: string; verdict: Verdict }[] = [];
  for (const row of rows) {
    if (!row.verdict) {
      continue;
    }
    const verdict = readVerdict(row.cwd);
    if (verdict) {
      out.push({ name: row.name, repo: row.repo, verdict });
    }
  }
  return out;
};

// The opt-in --git approximation: per unique repo, count merged PRs via `gh`.
// Fail-soft per repo (gh missing / not authed / non-repo → skipped), so a
// partial answer beats an error, and CI without gh just omits the block. Lives
// in this edge, never in the pure gain.ts.
const mergedCounts = (
  rows: FleetRow[],
  env: NodeJS.ProcessEnv
): { repo: string; count: number }[] => {
  const byRepo = new Map<string, string>();
  for (const row of rows) {
    if (row.repo && !byRepo.has(row.repo)) {
      byRepo.set(row.repo, row.cwd);
    }
  }
  const counts: { repo: string; count: number }[] = [];
  for (const [repo, cwd] of byRepo) {
    const res = run(
      "gh",
      ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number"],
      { cwd, env }
    );
    if (res.status !== 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(res.stdout) as unknown[];
      if (Array.isArray(parsed)) {
        counts.push({ count: parsed.length, repo });
      }
    } catch {
      // gh returned non-JSON (e.g. an auth nudge on stdout) — skip this repo
    }
  }
  return counts;
};

// Stateless fleet telemetry: every metric derived ON DEMAND from the decision
// log (the one gap-free ledger), the live cmux fleet, and the verdict files —
// no daemon, no persisted counter, no event stream. The honesty caveats name
// exactly what each number is so a snapshot is never read as a trend.
export const gain = (
  options: GainOptions,
  out: NodeJS.WritableStream,
  port: CmuxPort = realCmux(process.env)
): void => {
  // Probe cmux first — same reason as `status`: a dead daemon fails every
  // list/feed call soft to empty, which would read as an honest "empty fleet".
  if (cmuxUnreachable(port, options, out)) {
    return;
  }
  const { env } = process;
  const rows = fleetRows(port);
  const at = now();
  const metrics = computeGain({
    log: readLog(env),
    merged: options.git ? mergedCounts(rows, env) : undefined,
    now: at,
    rows,
    since: parseSince(options.since, at),
    verdicts: validVerdicts(rows),
  });
  if (options.json) {
    out.write(`${JSON.stringify(metrics, null, 2)}\n`);
    return;
  }
  out.write(renderGain(metrics, styleFor(out)));
};
