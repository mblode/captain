import type { FleetRow, Group } from "./view";

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

// The one message vocabulary for CLI feedback, so approve/reject and the
// top-level error path all speak with the same glyphs.
export const msg = {
  err: (s: Style, text: string): string => `${s.red("✗")} ${text}`,
  hint: (s: Style, text: string): string => s.dim(`→ ${text}`),
  ok: (s: Style, text: string): string => `${s.green("✓")} ${text}`,
  warn: (s: Style, text: string): string => `${s.yellow("!")} ${text}`,
};

// A bare duration in seconds → "5m" / "2h5m" / "5d".
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

const paintGroup = (s: Style, group: Group): Paint => {
  if (group === "needs-you") {
    return s.yellow;
  }
  if (group === "ready") {
    return s.green;
  }
  return s.cyan;
};

// Per-row glyph + label, derived from the live signals — there is no stage.
const meta = (row: FleetRow): { glyph: string; label: string } => {
  if (row.gate?.kind === "plan") {
    return { glyph: "◆", label: "plan ready" };
  }
  if (row.gate) {
    return { glyph: "●", label: "blocked" };
  }
  if (row.verdict === "fail") {
    return { glyph: "●", label: "verifier failed" };
  }
  if (row.verdict === "pass") {
    return { glyph: "✓", label: "ready to merge" };
  }
  if (row.run === "needs-input") {
    return { glyph: "●", label: "needs input" };
  }
  if (row.run === "running") {
    return { glyph: "◐", label: "working" };
  }
  return { glyph: "○", label: row.run === "idle" ? "idle" : "—" };
};

// A short, friendly handle for command examples (the ticket part of the name).
const shortName = (row: FleetRow): string => row.ticket ?? row.name;

// The inline "how to resolve this" lines shown under a row that needs you or
// is ready to merge — so the one status view is also the runbook. cmux
// commands take the workspace UUID; the display name is not a valid handle.
const actionLines = (row: FleetRow, s: Style): string[] => {
  if (row.gate?.kind === "plan") {
    return [
      `      ${s.dim("read:")}    cmux read-screen --workspace ${row.workspaceId} --scrollback`,
      `      ${s.dim("approve:")} captain approve ${shortName(row)}`,
      `      ${s.dim("reject:")}  captain reject ${shortName(row)} --note "…"`,
    ];
  }
  if (row.group === "needs-you") {
    return [
      `      ${s.dim("answer:")}  cmux send --workspace ${row.workspaceId} "<reply>\\n"  (or focus the workspace)`,
    ];
  }
  if (row.group === "ready") {
    return row.prUrl
      ? [`      ${s.dim("merge:")}   gh pr merge ${row.prUrl} --squash`]
      : [`      ${s.dim("(PR url pending)")}`];
  }
  return [];
};

const SECTIONS: { group: Group; heading: string }[] = [
  { group: "needs-you", heading: "NEEDS YOU" },
  { group: "in-flight", heading: "IN FLIGHT" },
  { group: "ready", heading: "READY TO MERGE" },
];

export interface StatusView {
  // merge-order hints keyed by workspaceId (changed-file overlap between ready
  // worktrees of one repo) — computed by the caller, rendered here
  overlaps?: Record<string, string>;
}

// One row: "  ◆ linkiq  linkiq-tig-431   plan ready      · <hint>"
const renderRow = (
  row: FleetRow,
  s: Style,
  width: number,
  repoPad: number
): string => {
  const m = meta(row);
  const paint = paintGroup(s, row.group);
  const repoTag = repoPad ? `${s.dim((row.repo ?? "?").padEnd(repoPad))} ` : "";
  const name = row.name.padEnd(width);
  const verified = row.verdict === "pass" ? ` ${s.green("✓ verified")}` : "";
  const pr = row.prUrl ? `  ${s.dim(row.prUrl)}` : "";
  return `  ${paint(m.glyph)} ${repoTag}${s.bold(name)} ${paint(m.label.padEnd(15))}${verified}${pr}`;
};

// The one glanceable fleet view, derived live from cmux + the worktrees: rows
// grouped so the few that need a decision sit on top, each gated/ready one
// carrying the exact command to resolve it.
export const renderStatus = (
  rows: FleetRow[],
  s: Style,
  view: StatusView = {}
): string => {
  const head = s.bold("Captain");
  if (rows.length === 0) {
    return [
      head,
      s.dim("  no captain worktrees found in cmux."),
      s.dim("  start one: captain fanout <ISSUE-ID> …"),
      "",
    ].join("\n");
  }

  const repos = new Set(rows.map((r) => r.repo ?? "?"));
  const repoPad =
    repos.size > 1 ? Math.max(...[...repos].map((r) => r.length)) : 0;
  const width = Math.min(40, Math.max(...rows.map((r) => r.name.length), 8));
  const needs = rows.filter((r) => r.group === "needs-you").length;
  const ready = rows.filter((r) => r.group === "ready").length;

  const summary = [
    `${rows.length} worktrees`,
    needs ? s.yellow(`${needs} need you`) : "",
    ready ? s.green(`${ready} ready`) : "",
  ]
    .filter(Boolean)
    .join(s.dim(" · "));

  const lines = [`${head}    ${summary}`, ""];

  for (const section of SECTIONS) {
    const group = rows
      .filter((r) => r.group === section.group)
      .toSorted(
        (a, b) =>
          (a.repo ?? "").localeCompare(b.repo ?? "") ||
          a.name.localeCompare(b.name)
      );
    if (group.length === 0) {
      continue;
    }
    lines.push(s.dim(section.heading));
    for (const row of group) {
      lines.push(renderRow(row, s, width, repoPad));
      const note = row.gate?.hint ?? row.summary;
      if (note) {
        lines.push(`      ${s.dim(note)}`);
      }
      const overlap = view.overlaps?.[row.workspaceId];
      if (overlap) {
        lines.push(`      ${msg.warn(s, overlap)}`);
      }
      lines.push(...actionLines(row, s));
    }
    lines.push("");
  }

  if (needs === 0 && ready === 0) {
    lines.push(s.dim("→ all worktrees flowing; nothing needs you."));
  }
  return `${lines.join("\n")}\n`;
};
