import type { Checks, PullRequest } from "./board";
import { run } from "./shell";

// The GitHub seam: the one place captain asks `gh` about a task's PR. Injected
// as a port so the board logic is tested against a fake, like CmuxPort.
export interface GithubPort {
  // the PR whose head is this branch, newest first; undefined when none exists
  // or gh cannot answer (not installed, not authenticated, offline)
  pr(repo: string, branch: string): PullRequest | undefined;
}

interface GhCheck {
  // CheckRun
  status?: string;
  conclusion?: string;
  // StatusContext
  state?: string;
}

const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

// Pure: reduce gh's statusCheckRollup to one answer. Any failure wins, then
// anything still running, then pass. No checks at all is "none", which the
// board treats like pending: a repo with no CI never reads as green.
export const rollup = (checks: GhCheck[]): Checks => {
  if (checks.length === 0) {
    return "none";
  }
  const outcomes = checks.map((c) =>
    (c.conclusion || c.state || "").toUpperCase()
  );
  if (outcomes.some((o) => FAILED.has(o))) {
    return "fail";
  }
  const running = checks.some(
    (c, i) =>
      (c.status && c.status.toUpperCase() !== "COMPLETED") ||
      outcomes[i] === "PENDING" ||
      outcomes[i] === "EXPECTED" ||
      outcomes[i] === ""
  );
  return running ? "pending" : "pass";
};

interface GhPr {
  url?: string;
  state?: string;
  statusCheckRollup?: GhCheck[] | null;
}

export const realGithub = (env: NodeJS.ProcessEnv): GithubPort => ({
  pr: (repo, branch) => {
    const raw = run(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "url,state,statusCheckRollup",
      ],
      { cwd: repo, env }
    );
    if (raw.status !== 0) {
      return;
    }
    let prs: GhPr[] = [];
    try {
      prs = JSON.parse(raw.stdout) as GhPr[];
    } catch {
      return;
    }
    const [pr] = prs;
    if (!pr?.url) {
      return;
    }
    const state = (pr.state ?? "").toLowerCase();
    return {
      checks: rollup(pr.statusCheckRollup ?? []),
      state: state === "merged" || state === "closed" ? state : "open",
      url: pr.url,
    };
  },
});
