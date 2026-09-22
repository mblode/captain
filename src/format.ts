import { GROUPS, groupCounts, inProgress } from "./board";
import type { Group, Row } from "./board";
import type { Project } from "./project";
import type { GainMetrics } from "./stats";

// ANSI styling that no-ops when output isn't a TTY or NO_COLOR is set, so piped
// output (and the chat reading `--json`) stays clean.
export const useColor = (stream: NodeJS.WritableStream): boolean =>
  Boolean((stream as Partial<NodeJS.WriteStream>).isTTY) &&
  !process.env.NO_COLOR;

type Paint = (s: string) => string;
const wrap = (on: boolean, code: string): Paint =>
  on ? (s) => `\u001B[${code}m${s}\u001B[0m` : (s) => s;

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

// The one message vocabulary for CLI feedback.
export const msg = {
  err: (s: Style, text: string): string => `${s.red("✗")} ${text}`,
  hint: (s: Style, text: string): string => s.dim(`→ ${text}`),
  ok: (s: Style, text: string): string => `${s.green("✓")} ${text}`,
  warn: (s: Style, text: string): string => `${s.yellow("!")} ${text}`,
};

// A bare duration in seconds: "5m" / "2h5m" / "5d".
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

const LABEL: Record<Group, string> = {
  blocked: "BLOCKED",
  captain: "CAPTAIN'S MOVE",
  closed: "CLOSED",
  merged: "MERGED",
  "needs-you": "NEEDS YOU",
  queued: "QUEUED",
  ready: "READY TO MERGE",
  working: "WORKING",
};

const paint = (s: Style, group: Group): Paint => {
  if (group === "needs-you") {
    return s.yellow;
  }
  if (group === "ready" || group === "merged") {
    return s.green;
  }
  if (group === "captain") {
    return s.cyan;
  }
  return s.dim;
};

export const renderTaskLine = (row: Row, color: boolean): string => {
  const s = style(color);
  const tags = [row.harness, row.risk === "escalate" ? "escalate" : ""]
    .filter(Boolean)
    .join(", ");
  const head = `${s.bold(row.id)}  ${row.title}  ${s.dim(`(${tags})`)}`;
  const lines = [head];
  if (row.why) {
    lines.push(`  ${row.why}`);
  }
  if (row.pr) {
    lines.push(`  ${s.dim(row.pr.url)}`);
  }
  if (row.next) {
    lines.push(`  ${msg.hint(s, row.next)}`);
  }
  return lines.join("\n");
};

export const renderBoard = (
  project: Project,
  rows: Row[],
  color: boolean
): string => {
  const s = style(color);
  const counts = groupCounts(rows);
  const head = `${s.bold(project.name)}  ${s.dim(`${inProgress(rows)}/${project.wip} in progress`)}`;
  if (rows.length === 0) {
    return `${head}\n\nno tasks yet: captain add "<message or ticket>"`;
  }
  const sections = GROUPS.filter((g) => counts[g] > 0).map((g) => {
    const title = paint(s, g)(`${LABEL[g]} (${counts[g]})`);
    const body = rows
      .filter((r) => r.group === g)
      .map((r) => renderTaskLine(r, color))
      .join("\n");
    return `${title}\n${body}`;
  });
  return [head, ...sections].join("\n\n");
};

export const renderGain = (
  project: Project,
  m: GainMetrics,
  color: boolean
): string => {
  const s = style(color);
  const window = m.window
    ? `since ${new Date(m.window.since * 1000).toISOString().slice(0, 10)}`
    : "all time";
  const lines = [
    `${s.bold(project.name)}  ${s.dim(window)}`,
    "",
    `tasks      ${m.tasks.todo} todo, ${m.tasks.active} active, ${m.tasks.done} done, ${m.tasks.dropped} dropped`,
    `flow       ${m.started} started, ${m.done} done, ${m.dropped} dropped`,
    `decisions  ${m.approvals} approved (${m.unexplainedApprovals} without a note), ${m.rejections} rejected`,
  ];
  if (m.firstPassRate !== undefined) {
    lines.push(
      `first pass ${Math.round(m.firstPassRate * 100)}% of plans approved without a rejection`
    );
  }
  if (m.medianCycleSec !== undefined) {
    lines.push(
      `cycle      ${fmtDuration(m.medianCycleSec)} median, start to done`
    );
  }
  for (const h of m.byHarness) {
    lines.push(`${h.harness.padEnd(10)} ${h.started} started, ${h.done} done`);
  }
  return lines.join("\n");
};
