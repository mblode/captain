import type { Stage, Worktree } from "./types.js";

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

export const fmtAge = (since: number): string => {
  if (since <= 0) {
    return "—";
  }
  const mins = Math.max(0, Math.floor(Date.now() / 1000 - since) / 60);
  const m = Math.floor(mins);
  if (m < 1) {
    return "just now";
  }
  if (m < 60) {
    return `${m}m`;
  }
  return `${Math.floor(m / 60)}h${m % 60}m`;
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

const SECTIONS: { group: Group; heading: string }[] = [
  { group: "needs-you", heading: "NEEDS YOU" },
  { group: "in-flight", heading: "IN FLIGHT" },
  { group: "ready", heading: "READY TO MERGE" },
];

// The glanceable fleet view: header with counts, worktrees grouped so the few
// that need a decision are always at the top, and a one-line next-action footer.
export const renderStatus = (
  fleetId: string,
  worktrees: Worktree[],
  s: Style
): string => {
  if (worktrees.length === 0) {
    return [
      s.bold(`Captain · ${fleetId}`),
      s.dim("  no worktrees tracked yet."),
      s.dim("  start the watcher, then: captain fanout <ISSUE-ID> …"),
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

  const lines = [`${s.bold(`Captain · ${fleetId}`)}    ${summary}`, ""];

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
    }
    lines.push("");
  }

  if (needs > 0) {
    lines.push(
      `${s.yellow("→")} ${needs} need you · ${s.bold(`captain gates --fleet ${fleetId}`)}`
    );
  } else if (ready > 0) {
    lines.push(
      `${s.green("→")} ${ready} ready · ${s.bold(`captain ready --fleet ${fleetId}`)}`
    );
  } else {
    lines.push(s.dim("→ all worktrees flowing; nothing needs you."));
  }
  return `${lines.join("\n")}\n`;
};
