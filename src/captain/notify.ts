import { realCmux } from "./control";
import type { CmuxPort } from "./control";
import { fmtDuration } from "./format";
import { appendLog, now } from "./log";
import { fleetRows } from "./surface";
import type { FleetRow } from "./view";

// The optional notifier: a tiny foreground poll loop. Each tick derives the
// same stateless fleet view `status` uses, diffs it against the previous tick
// in memory, and toasts only on a CHANGE — a new gate, a fresh verdict, or a
// worktree gone quiet too long. No pidfile, no event stream, no persisted
// state: kill it and restart it whenever; the worst case is one repeat toast.

const DEFAULT_POLL_SECS = 30;
// How long an in-flight worktree may sit idle before it earns a "quiet" nudge.
const DEFAULT_QUIET_SECS = 1800;

interface Seen {
  // what we last observed (gate id + verdict + run) — any change resets quiet
  sig: string;
  changedAt: number;
  quietNotified: boolean;
}

const sigOf = (row: FleetRow): string =>
  `${row.gate?.id ?? ""}|${row.verdict ?? ""}|${row.run}`;

export interface Notifier {
  // one poll pass; exposed so tests (and a --once run) can drive it directly
  tick(): void;
}

export const createNotifier = (
  port: CmuxPort,
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void
): Notifier => {
  const quietSecs = Number(env.CAPTAIN_QUIET_SECS) || DEFAULT_QUIET_SECS;
  const seen = new Map<string, Seen>();

  const toast = (
    kind: "gate" | "ready" | "quiet",
    row: FleetRow,
    title: string,
    body: string
  ): void => {
    port.notify(title, body);
    appendLog({ kind, name: row.name, note: body, ts: now() }, env);
    log?.(`${title}: ${body}`);
  };

  const onChange = (row: FleetRow, prev: Seen | undefined): void => {
    const prevSig = prev?.sig ?? "";
    if (row.gate && !prevSig.startsWith(row.gate.id)) {
      toast(
        "gate",
        row,
        "Captain · needs you",
        `${row.name}: ${row.gate.hint ?? row.gate.kind}`
      );
      return;
    }
    if (row.verdict === "pass" && !prevSig.includes("|pass|")) {
      toast(
        "ready",
        row,
        "Captain · ready to merge",
        `${row.name}: ${row.summary ?? "verified"}`
      );
      return;
    }
    if (row.verdict === "fail" && !prevSig.includes("|fail|")) {
      toast(
        "gate",
        row,
        "Captain · needs you",
        `${row.name}: verifier failed — ${row.summary ?? ""}`
      );
    }
  };

  return {
    tick: (): void => {
      const tickAt = now();
      const live = new Set<string>();
      for (const row of fleetRows(port, env)) {
        live.add(row.workspaceId);
        const prev = seen.get(row.workspaceId);
        const sig = sigOf(row);
        if (!prev || prev.sig !== sig) {
          onChange(row, prev);
          seen.set(row.workspaceId, {
            changedAt: tickAt,
            quietNotified: false,
            sig,
          });
          continue;
        }
        // Unchanged and supposedly in flight, but the agent isn't running —
        // after long enough that's a stall worth one nudge (never repeated).
        if (
          row.group === "in-flight" &&
          row.run !== "running" &&
          !prev.quietNotified &&
          tickAt - prev.changedAt >= quietSecs
        ) {
          prev.quietNotified = true;
          toast(
            "quiet",
            row,
            "Captain · needs a look",
            `${row.name}: quiet for ${fmtDuration(tickAt - prev.changedAt)} with no gate or verdict`
          );
        }
      }
      for (const id of seen.keys()) {
        if (!live.has(id)) {
          seen.delete(id);
        }
      }
    },
  };
};

// `captain notify` — runs in the foreground (a cmux pane, a tmux window, or
// `&`). Ctrl-C to stop; nothing to clean up.
export const notifyLoop = (input: {
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  port?: CmuxPort;
  once?: boolean;
}): void => {
  const port = input.port ?? realCmux(input.env);
  const notifier = createNotifier(port, input.env, input.log);
  notifier.tick();
  if (input.once) {
    return;
  }
  const pollSecs = Number(input.env.CAPTAIN_POLL_SECS) || DEFAULT_POLL_SECS;
  input.log?.(`watching the fleet — polling every ${pollSecs}s. Ctrl-C stops.`);
  setInterval(() => notifier.tick(), pollSecs * 1000);
};
