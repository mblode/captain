import { now } from "./state";
import type { FleetMetrics, Stage, Worktree } from "./types";

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

// A bare duration in seconds → "5m" / "2h5m" (no "ago"/"just now" framing).
export const fmtDuration = (sec: number): string => {
  const m = Math.floor(Math.max(0, sec) / 60);
  if (m < 1) {
    return "<1m";
  }
  if (m < 60) {
    return `${m}m`;
  }
  return `${Math.floor(m / 60)}h${m % 60}m`;
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

// A short, friendly handle for command examples (the ticket part of the name).
export const shortName = (wt: Worktree): string => {
  const m = wt.name.match(/([a-z]+-\d+)/iu);
  return m ? m[1] : wt.name;
};

// One worktree line: "  ◆ frontyard-tig-431   plan ready   2m   <hint>"
const row = (wt: Worktree, s: Style, width: number): string => {
  const meta = STAGE_META[wt.stage];
  const paint = paintGroup(s, meta.group);
  const name = wt.name.padEnd(width);
  const label = meta.label.padEnd(14);
  const detail = wt.gate ? s.dim(`· ${wt.gate}`) : "";
  const pr = wt.prUrl ? `  ${s.dim(wt.prUrl)}` : "";
  return `  ${paint(meta.glyph)} ${s.bold(name)} ${paint(label)} ${s.dim(fmtAge(wt.since).padStart(8))} ${detail}${pr}`;
};

// The inline "how to resolve this" lines shown under a worktree that's parked at
// a human gate or ready to merge — so the one status view is also the runbook.
const actionLines = (wt: Worktree, s: Style): string[] => {
  if (wt.stage === "PLAN_READY") {
    return [
      `      ${s.dim("read:")}    cmux read-screen --workspace ${wt.name} --scrollback`,
      `      ${s.dim("approve:")} captain approve --plans ${shortName(wt)}`,
      `      ${s.dim("reject:")}  captain reject --ref ${shortName(wt)} --note "…"`,
    ];
  }
  // BLOCKED and any other needs-you stage: answer in the workspace.
  if (groupOf(wt.stage) === "needs-you") {
    return [
      `      ${s.dim("answer:")}  cmux send --workspace ${wt.name} "<reply>\\n"  (or focus the workspace)`,
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

// The one glanceable fleet view: a watcher-health header, worktrees grouped so the
// few that need a decision sit on top, each gated/ready one carrying the exact
// command to resolve it. This is the whole read surface — there's no `gates`/`ready`.
export const renderStatus = (
  worktrees: Worktree[],
  s: Style,
  watcher: string
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

  const width = Math.min(
    40,
    Math.max(...worktrees.map((w) => w.name.length), 8)
  );
  const needs = worktrees.filter(
    (w) => groupOf(w.stage) === "needs-you"
  ).length;
  const ready = worktrees.filter((w) => groupOf(w.stage) === "ready").length;

  const summary = [
    `${worktrees.length} worktrees`,
    needs ? s.yellow(`${needs} need you`) : "",
    ready ? s.green(`${ready} ready`) : "",
  ]
    .filter(Boolean)
    .join(s.dim(" · "));

  const lines = [`${head}    ${summary}`, ""];

  for (const section of SECTIONS) {
    const rows = worktrees
      .filter((w) => groupOf(w.stage) === section.group)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    if (rows.length === 0) {
      continue;
    }
    lines.push(s.dim(section.heading));
    for (const wt of rows) {
      lines.push(row(wt, s, width));
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

// Lifecycle order for the metrics stage table (STAGE_META is keyed, not ordered).
const STAGE_ORDER: Stage[] = [
  "ADOPTED",
  "PLANNING",
  "PLAN_READY",
  "IMPLEMENTING",
  "SIMPLIFY",
  "REVIEW",
  "PR_OPEN",
  "BABYSITTING",
  "READY_TO_MERGE",
  "BLOCKED",
];

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const plural = (n: number, w: string): string =>
  `${n} ${w}${n === 1 ? "" : "s"}`;

// The measurement view: fleet-wide velocity/autonomy up top, then a per-stage
// table of how long worktrees dwell and how reliably the watcher advances them.
// Plain when not a TTY (style no-ops), so `--json` and pipes stay parseable.
export const renderMetrics = (m: FleetMetrics, s: Style): string => {
  const head = `${s.bold("Captain")}  ${s.dim("metrics")}`;
  if (m.runs === 0) {
    return [head, s.dim("  no runs recorded yet."), ""].join("\n");
  }

  const lines = [
    head,
    "",
    `  ${s.dim("runs")}          ${m.runs}`,
    `  ${s.dim("PR-ready")}      ${m.prsReady}  ${s.dim(`(${m.throughputPerDay.toFixed(1)}/day)`)}`,
    `  ${s.dim("autonomous")}    ${m.autonomousRuns}  ${s.dim(`(${pct(m.autonomyRate)} of PR-ready)`)}`,
    `  ${s.dim("intervention")}  ${pct(m.interventionRate)}  ${s.dim(
      `(${plural(m.interventions.plans, "plan")} · ${plural(m.interventions.rejects, "reject")} · ${plural(m.interventions.blocks, "block")})`
    )}`,
    "",
    s.dim("STAGES"),
  ];

  for (const stage of STAGE_ORDER) {
    const sm = m.stages[stage];
    if (!sm) {
      continue;
    }
    const meta = STAGE_META[stage];
    const paint = paintGroup(s, meta.group);
    const label = meta.label.padEnd(14);
    const timing = `${s.dim("median")} ${fmtDuration(sm.medianSec).padStart(6)}  ${s.dim("total")} ${fmtDuration(sm.totalSec).padStart(6)}`;
    const flow =
      sm.advances + sm.reworks > 0
        ? `  ${s.dim(`(${plural(sm.advances, "advance")} · ${plural(sm.reworks, "rework")})`)}`
        : "";
    lines.push(`  ${paint(meta.glyph)} ${paint(label)} ${timing}${flow}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};
