import { now } from "./state";
import type { HistoryKind, HistoryRecord, Stage, Worktree } from "./types";

// ANSI styling that no-ops when output isn't a TTY or NO_COLOR is set, so piped
// output (and the LLM reading it via `--json`) stays clean.
export const useColor = (stream: NodeJS.WritableStream): boolean =>
  Boolean((stream as Partial<NodeJS.WriteStream>).isTTY) &&
  !process.env.NO_COLOR;

type Paint = (s: string) => string;
const wrap = (on: boolean, code: string): Paint =>
  on ? (s) => `[${code}m${s}[0m` : (s) => s;

export interface Style {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
}

export const style = (on: boolean): Style => ({
  bold: wrap(on, "1"),
  cyan: wrap(on, "36"),
  dim: wrap(on, "2"),
  green: wrap(on, "32"),
  red: wrap(on, "31"),
  yellow: wrap(on, "33"),
});

// The one message vocabulary for CLI feedback, so approve/reject/stop/restart
// and the top-level error path all speak with the same glyphs.
export const msg = {
  err: (s: Style, text: string): string => `${s.red("✗")} ${text}`,
  hint: (s: Style, text: string): string => s.dim(`→ ${text}`),
  ok: (s: Style, text: string): string => `${s.green("✓")} ${text}`,
  warn: (s: Style, text: string): string => `${s.yellow("!")} ${text}`,
};

type Group = "needs-you" | "in-flight" | "ready";

interface StageMeta {
  glyph: string;
  label: string;
  group: Group;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  ADOPTED: { glyph: "◌", group: "in-flight", label: "adopted" },
  BABYSITTING: { glyph: "◐", group: "ready", label: "babysitting" },
  BLOCKED: { glyph: "●", group: "needs-you", label: "blocked" },
  IMPLEMENTING: { glyph: "◐", group: "in-flight", label: "implementing" },
  PLANNING: { glyph: "◐", group: "in-flight", label: "planning" },
  PLAN_READY: { glyph: "◆", group: "needs-you", label: "plan ready" },
  PR_OPEN: { glyph: "◐", group: "in-flight", label: "opening PR" },
  READY_TO_MERGE: { glyph: "✓", group: "ready", label: "ready to merge" },
  REVIEW: { glyph: "◐", group: "in-flight", label: "review" },
  SIMPLIFY: { glyph: "◐", group: "in-flight", label: "simplify" },
};

// A bare duration in seconds → "5m" / "2h5m" / "5d" (no "ago"/"just now"
// framing). Days kick in at 48h so a gate parked for a week reads "7d", not
// "168h0m".
export const fmtDuration = (sec: number): string => {
  const m = Math.floor(Math.max(0, sec) / 60);
  if (m < 1) {
    return "<1m";
  }
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  if (h < 48) {
    return `${h}h${m % 60}m`;
  }
  return `${Math.floor(h / 24)}d`;
};

export const fmtAge = (since: number): string => {
  if (since <= 0) {
    return "—";
  }
  const sec = now() - since;
  return sec < 60 ? "just now" : fmtDuration(sec);
};

export const groupOf = (stage: Stage): Group => STAGE_META[stage].group;

const paintGroup = (s: Style, group: Group): Paint => {
  if (group === "needs-you") {
    return s.yellow;
  }
  if (group === "ready") {
    return s.green;
  }
  return s.cyan;
};

// The canonical ticket id inside a name/path ("tig-494"), lowercased.
export const ticketFrom = (text: string): string | undefined => {
  const m = text.match(/([a-z]+-\d+)/iu);
  return m ? m[1].toLowerCase() : undefined;
};

// A short, friendly handle for command examples (the ticket part of the name).
export const shortName = (wt: Worktree): string =>
  wt.ticket ?? ticketFrom(wt.name) ?? wt.name;

// The worktree's repo label. Persisted by adoption since the field existed;
// derived from the name for older state.json entries ("linkiq-tig-494" →
// "linkiq") so repo grouping/filtering works on the live fleet unmigrated.
export const repoOf = (wt: Worktree): string => {
  if (wt.repo) {
    return wt.repo;
  }
  const ticket = ticketFrom(wt.name);
  if (ticket) {
    const prefix = wt.name.toLowerCase().split(ticket)[0].replace(/-$/u, "");
    if (prefix) {
      return prefix;
    }
  }
  return wt.name;
};

// A human gate the fleet is waiting on YOU for (vs. an agent working/idling).
const HUMAN_GATES = new Set<Stage>(["PLAN_READY", "BLOCKED"]);

// Surface the "parked Nd" cue once a gate has waited a full day.
const PARKED_CUE_SECS = 86_400;

// One worktree line: "  ◆ linkiq  frontyard-tig-431   plan ready   2m   <hint>"
const row = (
  wt: Worktree,
  s: Style,
  width: number,
  repoPad: number
): string => {
  const meta = STAGE_META[wt.stage];
  const paint = paintGroup(s, meta.group);
  const repoTag = repoPad ? `${s.dim(repoOf(wt).padEnd(repoPad))} ` : "";
  const name = wt.name.padEnd(width);
  const label = meta.label.padEnd(14);
  const detail = wt.gate ? s.dim(`· ${wt.gate}`) : "";
  const verified = wt.verdict === "pass" ? ` ${s.green("✓ verified")}` : "";
  const pr = wt.prUrl ? `  ${s.dim(wt.prUrl)}` : "";
  // "this has been waiting on you for days" — time parked at the gate (since),
  // not event-silence: checkHalt exempts human gates, so lastSeen never moves.
  const parkedSecs = wt.since > 0 ? now() - wt.since : 0;
  const parked =
    HUMAN_GATES.has(wt.stage) && parkedSecs >= PARKED_CUE_SECS
      ? ` ${s.dim(`parked ${fmtDuration(parkedSecs)}`)}`
      : "";
  return `  ${paint(meta.glyph)} ${repoTag}${s.bold(name)} ${paint(label)} ${s.dim(fmtAge(wt.since).padStart(8))} ${detail}${verified}${parked}${pr}`;
};

// The inline "how to resolve this" lines shown under a worktree that's parked at
// a human gate or ready to merge — so the one status view is also the runbook.
// cmux commands take the workspace UUID (the handle control.ts drives agents
// with) — the display name is not a valid cmux handle.
const actionLines = (wt: Worktree, s: Style): string[] => {
  if (wt.stage === "PLAN_READY") {
    return [
      `      ${s.dim("read:")}    cmux read-screen --workspace ${wt.workspaceId} --scrollback`,
      `      ${s.dim("approve:")} captain approve --plans ${shortName(wt)}`,
      `      ${s.dim("reject:")}  captain reject --ref ${shortName(wt)} --note "…"`,
    ];
  }
  // BLOCKED and any other needs-you stage: answer in the workspace.
  if (groupOf(wt.stage) === "needs-you") {
    return [
      `      ${s.dim("answer:")}  cmux send --workspace ${wt.workspaceId} "<reply>\\n"  (or focus the workspace)`,
    ];
  }
  if (groupOf(wt.stage) === "ready") {
    return wt.prUrl
      ? [`      ${s.dim("merge:")}   gh pr merge ${wt.prUrl} --squash`]
      : [`      ${s.dim("(PR url pending)")}`];
  }
  return [];
};

const SECTIONS: { group: Group; heading: string }[] = [
  { group: "needs-you", heading: "NEEDS YOU" },
  { group: "in-flight", heading: "IN FLIGHT" },
  { group: "ready", heading: "READY TO MERGE" },
];

export const DEFAULT_STALE_SECS = 3 * 86_400;

export interface StatusView {
  // show stale gate-parked worktrees instead of folding them into a count
  all?: boolean;
  // how long a human gate sits unanswered before it counts as stale clutter
  staleSecs?: number;
}

// A worktree parked at a human gate so long it's clutter, not a decision queue.
const isStale = (wt: Worktree, staleSecs: number): boolean =>
  HUMAN_GATES.has(wt.stage) && wt.since > 0 && now() - wt.since >= staleSecs;

// The one glanceable fleet view: a watcher-health header, worktrees grouped so the
// few that need a decision sit on top, each gated/ready one carrying the exact
// command to resolve it. This is the whole read surface — there's no `gates`/`ready`.
// Long-parked gates fold into a "+N stale" count (nothing silently hidden) unless
// `all` is set; multi-repo fleets get a per-row repo tag.
export const renderStatus = (
  worktrees: Worktree[],
  s: Style,
  watcher: string,
  view: StatusView = {}
): string => {
  const head = `${s.bold("Captain")}  ${s.dim(`watcher: ${watcher}`)}`;
  if (worktrees.length === 0) {
    return [
      head,
      s.dim("  no worktrees tracked yet."),
      s.dim("  start one: captain fanout <ISSUE-ID> …"),
      "",
    ].join("\n");
  }

  const staleSecs = view.staleSecs ?? DEFAULT_STALE_SECS;
  const stale = view.all ? [] : worktrees.filter((w) => isStale(w, staleSecs));
  const shown = worktrees.filter((w) => !stale.includes(w));

  const repos = new Set(worktrees.map(repoOf));
  const repoPad =
    repos.size > 1 ? Math.max(...[...repos].map((r) => r.length)) : 0;

  const width = Math.min(40, Math.max(...shown.map((w) => w.name.length), 8));
  const needs = shown.filter((w) => groupOf(w.stage) === "needs-you").length;
  const ready = shown.filter((w) => groupOf(w.stage) === "ready").length;

  const summary = [
    `${worktrees.length} worktrees`,
    needs ? s.yellow(`${needs} need you`) : "",
    ready ? s.green(`${ready} ready`) : "",
    stale.length ? s.dim(`+${stale.length} stale — captain status --all`) : "",
  ]
    .filter(Boolean)
    .join(s.dim(" · "));

  const lines = [`${head}    ${summary}`, ""];

  for (const section of SECTIONS) {
    const rows = shown
      .filter((w) => groupOf(w.stage) === section.group)
      .toSorted(
        (a, b) =>
          repoOf(a).localeCompare(repoOf(b)) || a.name.localeCompare(b.name)
      );
    if (rows.length === 0) {
      continue;
    }
    lines.push(s.dim(section.heading));
    for (const wt of rows) {
      lines.push(row(wt, s, width, repoPad));
      if (wt.note) {
        lines.push(`      ${s.dim(wt.note)}`);
      }
      lines.push(...actionLines(wt, s));
    }
    lines.push("");
  }

  if (needs === 0 && ready === 0) {
    lines.push(s.dim("→ all worktrees flowing; nothing needs you."));
  }
  return `${lines.join("\n")}\n`;
};

const plural = (n: number, w: string): string =>
  `${n} ${w}${n === 1 ? "" : "s"}`;

// Per-kind glyph + actor (who caused the record): approve/reject are human
// decisions; everything else is the watcher acting on the event stream.
const KIND_META: Record<HistoryKind, { glyph: string; actor: string }> = {
  adopt: { actor: "watcher", glyph: "+" },
  advance: { actor: "watcher", glyph: "→" },
  approve: { actor: "you", glyph: "✓" },
  gate: { actor: "watcher", glyph: "◆" },
  reject: { actor: "you", glyph: "↩" },
  rework: { actor: "watcher", glyph: "↻" },
  verdict: { actor: "agent", glyph: "⚖" },
};

const paintKind = (s: Style, kind: HistoryKind): Paint => {
  if (kind === "approve" || kind === "verdict") {
    return s.green;
  }
  if (kind === "reject" || kind === "gate" || kind === "rework") {
    return s.yellow;
  }
  if (kind === "adopt") {
    return s.dim;
  }
  return s.cyan;
};

// Absolute, timezone-stable stamp ("06-05 10:00:00") — an audit trail wants the
// real time of each event, not a now-relative age, and UTC keeps it deterministic.
const fmtStamp = (ts: number): string =>
  new Date(ts * 1000).toISOString().slice(5, 19).replace("T", " ");

// The governance trail: the append-only history rendered chronologically — every
// advance, gate, and human decision, with who caused it and the stage it moved.
// Plain when not a TTY (style no-ops), so `--json` and pipes stay parseable.
export const renderAudit = (records: HistoryRecord[], s: Style): string => {
  const head = `${s.bold("Captain")}  ${s.dim("audit")}`;
  if (records.length === 0) {
    return [head, s.dim("  no audit records yet."), ""].join("\n");
  }

  const width = Math.min(40, Math.max(...records.map((r) => r.name.length), 8));
  const lines = [
    `${head}  ${s.dim(`· ${plural(records.length, "event")}`)}`,
    "",
  ];

  for (const r of records) {
    const meta = KIND_META[r.kind];
    const paint = paintKind(s, r.kind);
    const name = s.bold(r.name.padEnd(width));
    const flow = `${STAGE_META[r.from].label} → ${STAGE_META[r.to].label}`;
    let tail = "";
    if (r.action) {
      tail = `  ${s.dim(r.action)}`;
    } else if (r.gate) {
      tail = `  ${s.dim(`· ${r.gate}`)}`;
    }
    lines.push(
      `  ${s.dim(fmtStamp(r.ts))}  ${paint(meta.glyph)} ${name} ${s.dim(meta.actor.padEnd(7))} ${paint(r.event.padEnd(12))} ${flow}${tail}`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};
