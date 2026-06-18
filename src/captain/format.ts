import type { GainMetrics } from "./gain";
import { nextCommand } from "./view";
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
  // The primary command is owned by view.ts's nextCommand (single source of
  // truth, also emitted on --json) — the lines below decorate it for the TTY.
  if (row.gate?.kind === "plan") {
    return [
      `      ${s.dim("read:")}    cmux read-screen --workspace ${row.workspaceId} --scrollback`,
      `      ${s.dim("approve:")} ${nextCommand(row)}`,
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
      ? [`      ${s.dim("merge:")}   ${nextCommand(row)}`]
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

// The compact poll view: a one-line group tally + the NEEDS YOU rows only
// (with their inline resolve commands). For a driver that polls often and only
// needs to act when something is blocked. `rows` is the full (repo-filtered)
// set so the counts stay honest; only needs-you rows are detailed.
export const renderSummary = (rows: FleetRow[], s: Style): string => {
  const needs = rows.filter((r) => r.group === "needs-you");
  const inFlight = rows.filter((r) => r.group === "in-flight").length;
  const ready = rows.filter((r) => r.group === "ready").length;
  const counts = [
    needs.length ? s.yellow(`${needs.length} need you`) : "",
    inFlight ? s.cyan(`${inFlight} in flight`) : "",
    ready ? s.green(`${ready} ready`) : "",
  ]
    .filter(Boolean)
    .join(s.dim(" · "));
  const lines = [`${s.bold("Captain")}    ${counts || s.dim("no worktrees")}`];
  if (needs.length === 0) {
    lines.push(s.dim("→ nothing needs you."));
    return `${lines.join("\n")}\n`;
  }
  const width = Math.min(40, Math.max(...needs.map((r) => r.name.length), 8));
  const repos = new Set(needs.map((r) => r.repo ?? "?"));
  const repoPad =
    repos.size > 1 ? Math.max(...[...repos].map((r) => r.length)) : 0;
  lines.push("", s.dim("NEEDS YOU"));
  for (const row of needs.toSorted((a, b) => a.name.localeCompare(b.name))) {
    lines.push(renderRow(row, s, width, repoPad));
    const note = row.gate?.hint ?? row.summary;
    if (note) {
      lines.push(`      ${s.dim(note)}`);
    }
    lines.push(...actionLines(row, s));
  }
  return `${lines.join("\n")}\n`;
};

// A 0..1 rate → "87%".
const pct = (rate: number): string => `${Math.round(rate * 100)}%`;

// The telemetry view: derived-on-demand fleet metrics with their honesty labels
// as a dimmed footer. Plain on a pipe / under --json (those paths never reach
// here); coloured on a TTY. Display only — every number is computed in gain.ts.
export const renderGain = (m: GainMetrics, s: Style): string => {
  const lines: string[] = [s.bold("Captain — gain")];

  // Decisions: the one true ledger.
  const window = m.decisions.window
    ? s.dim(
        ` (since ${new Date(m.decisions.window.since * 1000).toISOString().slice(0, 10)})`
      )
    : "";
  lines.push("", `${s.dim("DECISIONS")}${window}`);
  const total = m.decisions.approvals + m.decisions.rejections;
  if (total === 0) {
    lines.push(`  ${s.dim("no approve/reject decisions recorded yet")}`);
  } else {
    lines.push(
      `  ${s.green(`${m.decisions.approvals} approved`)} ${s.dim("·")} ${s.yellow(`${m.decisions.rejections} rejected`)} ${s.dim("·")} ${pct(m.decisions.approvalRate)} approval rate`
    );
    for (const r of m.decisions.recentRejectReasons) {
      const note = r.note ? `: ${r.note}` : "";
      lines.push(`  ${s.yellow("↩")} ${s.bold(r.name)}${s.dim(note)}`);
    }
    if (m.decisions.cadence.length > 0) {
      const recent = m.decisions.cadence
        .slice(-7)
        .map((d) => `${d.day} ${d.count}`)
        .join(s.dim(" · "));
      lines.push(`  ${s.dim(`cadence: ${recent}`)}`);
    }
  }

  // Fleet: a live snapshot.
  lines.push("", s.dim("FLEET (live snapshot)"));
  lines.push(
    `  ${m.fleet.total} worktrees ${s.dim("·")} ${s.yellow(`${m.fleet.needsYou} need you`)} ${s.dim("·")} ${s.cyan(`${m.fleet.inFlight} in flight`)} ${s.dim("·")} ${s.green(`${m.fleet.ready} ready`)}`
  );
  for (const r of m.fleet.byRepo) {
    lines.push(`  ${s.dim(`${r.repo}: ${r.total}`)}`);
  }

  // Verdicts: a live read, not a ledger.
  lines.push("", s.dim("VERDICTS (live read)"));
  lines.push(
    `  ${s.green(`${m.verdicts.pass} pass`)} ${s.dim("·")} ${s.red(`${m.verdicts.fail} fail`)}`
  );
  for (const c of m.verdicts.failingCriteria) {
    lines.push(`  ${s.red("✗")} ${c.name} ${s.dim(`(×${c.count})`)}`);
  }
  if (m.verdicts.openPrs.length > 0) {
    lines.push(`  ${s.dim(`open PRs: ${m.verdicts.openPrs.length}`)}`);
    for (const url of m.verdicts.openPrs) {
      lines.push(`  ${s.dim(url)}`);
    }
  }

  // Merged: the opt-in --git approximation.
  if (m.merged) {
    lines.push("", s.dim("MERGED (--git approximation)"));
    if (m.merged.length === 0) {
      lines.push(`  ${s.dim("none found")}`);
    }
    for (const r of m.merged) {
      lines.push(`  ${s.dim(`${r.repo}: ${r.count}`)}`);
    }
  }

  // The honesty contract, dimmed at the foot.
  lines.push("", s.dim("notes:"));
  for (const c of m.caveats) {
    lines.push(`  ${s.dim(`· ${c}`)}`);
  }
  return `${lines.join("\n")}\n`;
};
