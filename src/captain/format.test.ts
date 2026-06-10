import { describe, expect, it } from "vitest";

import {
  fmtAge,
  fmtDuration,
  groupOf,
  renderAudit,
  renderStatus,
  repoOf,
  style,
  ticketFrom,
} from "./format";
import type { HistoryRecord, Stage, Worktree } from "./types";

const plain = style(false);
const wt = (name: string, stage: Stage, since = 0): Worktree => ({
  agent: "claude",
  cwd: `/repo/${name}`,
  name,
  since,
  stage,
  workspaceId: name,
});

describe("fmtAge", () => {
  it("shows an em dash for unset timestamps", () => {
    expect(fmtAge(0)).toBe("—");
  });

  it("formats minutes and hours", () => {
    const t = Math.floor(Date.now() / 1000);
    expect(fmtAge(t)).toBe("just now");
    expect(fmtAge(t - 5 * 60)).toBe("5m");
    expect(fmtAge(t - (2 * 60 + 5) * 60)).toBe("2h5m");
  });
});

describe("groupOf", () => {
  it("maps stages to the right group", () => {
    expect(groupOf("PLAN_READY")).toBe("needs-you");
    expect(groupOf("BLOCKED")).toBe("needs-you");
    expect(groupOf("SIMPLIFY")).toBe("in-flight");
    expect(groupOf("READY_TO_MERGE")).toBe("ready");
  });
});

describe("renderStatus", () => {
  it("guides the user when the fleet is empty", () => {
    const out = renderStatus([], plain, "not running");
    expect(out).toContain("no worktrees tracked yet");
    expect(out).toContain("watcher: not running");
  });

  it("leads with NEEDS YOU and inlines the resolve command", () => {
    const out = renderStatus(
      [
        wt("frontyard-tig-1", "IMPLEMENTING"),
        wt("frontyard-tig-2", "PLAN_READY"),
      ],
      plain,
      "running (pid 42)"
    );
    expect(out).toContain("2 worktrees");
    expect(out).toContain("1 need you");
    expect(out).toContain("watcher: running (pid 42)");
    // NEEDS YOU section comes before IN FLIGHT.
    expect(out.indexOf("NEEDS YOU")).toBeLessThan(out.indexOf("IN FLIGHT"));
    // The gate carries its own resolve command — no separate `gates` command.
    expect(out).toContain("captain approve --plans tig-2");
  });

  it("inlines a merge hint when a worktree is ready", () => {
    const ready = {
      ...wt("frontyard-tig-1", "READY_TO_MERGE"),
      prUrl: "https://x/pr/1",
    };
    const out = renderStatus([ready], plain, "running (pid 42)");
    expect(out).toContain("gh pr merge https://x/pr/1 --squash");
  });

  it("shows a pending placeholder for a ready worktree without a PR url", () => {
    const out = renderStatus(
      [wt("frontyard-tig-1", "READY_TO_MERGE")],
      plain,
      "running (pid 42)"
    );
    expect(out).toContain("(PR url pending)");
    expect(out).not.toContain("gh pr merge");
  });

  it("inlines an answer hint for a blocked worktree, with its note", () => {
    const blocked = { ...wt("frontyard-tig-1", "BLOCKED"), note: "which db?" };
    const out = renderStatus([blocked], plain, "running (pid 42)");
    expect(out).toContain("cmux send --workspace frontyard-tig-1");
    expect(out).toContain("which db?");
  });

  it("reassures when nothing needs you and nothing is ready", () => {
    const out = renderStatus(
      [wt("frontyard-tig-1", "IMPLEMENTING")],
      plain,
      "running (pid 42)"
    );
    expect(out).toContain("all worktrees flowing");
  });
});

describe("fmtDuration", () => {
  it("formats bare seconds without the age framing", () => {
    expect(fmtDuration(30)).toBe("<1m");
    expect(fmtDuration(5 * 60)).toBe("5m");
    expect(fmtDuration((2 * 60 + 5) * 60)).toBe("2h5m");
  });

  it("switches to days past 48h so a week-old gate reads 7d, not 168h", () => {
    expect(fmtDuration(47 * 3600)).toBe("47h0m");
    expect(fmtDuration(5 * 86_400)).toBe("5d");
  });
});

describe("ticketFrom / repoOf", () => {
  it("extracts the canonical ticket id, lowercased", () => {
    expect(ticketFrom("chat-tig-487")).toBe("tig-487");
    expect(ticketFrom("TIG-488-c3-general-tool")).toBe("tig-488");
    expect(ticketFrom("chat")).toBeUndefined();
  });

  it("prefers the persisted repo, deriving from the name only as fallback", () => {
    expect(repoOf({ ...wt("x-tig-1", "PLANNING"), repo: "linkiq" })).toBe(
      "linkiq"
    );
    expect(repoOf(wt("frontyard-tig-430", "PLANNING"))).toBe("frontyard");
    // No ticket in the name → the name itself is the best label.
    expect(repoOf(wt("chat", "PLANNING"))).toBe("chat");
  });
});

describe("renderStatus — repo-aware view", () => {
  const t = Math.floor(Date.now() / 1000);

  it("addresses cmux hints by workspace UUID, not the display name", () => {
    const gated = {
      ...wt("chat-tig-487", "PLAN_READY"),
      workspaceId: "ws-uuid-487",
    };
    const blocked = {
      ...wt("chat-tig-488", "BLOCKED"),
      workspaceId: "ws-uuid-488",
    };
    const out = renderStatus([gated, blocked], plain, "running (pid 1)");
    expect(out).toContain("cmux read-screen --workspace ws-uuid-487");
    expect(out).toContain("cmux send --workspace ws-uuid-488");
    expect(out).not.toContain("--workspace chat-tig-487");
  });

  it("tags rows with their repo when the fleet spans more than one", () => {
    const a = { ...wt("a-tig-1", "PLANNING"), repo: "linkiq" };
    const b = { ...wt("b-tig-2", "PLANNING"), repo: "notifications" };
    const out = renderStatus([a, b], plain, "running (pid 1)");
    expect(out).toContain("linkiq");
    expect(out).toContain("notifications");
  });

  it("folds long-parked gates into a stale count, unfolded by --all", () => {
    const fresh = wt("linkiq-tig-494", "PLAN_READY", t - 60);
    const old = wt("frontyard-tig-430", "PLAN_READY", t - 5 * 86_400);
    const out = renderStatus([fresh, old], plain, "running (pid 1)");
    expect(out).toContain("+1 stale — captain status --all");
    expect(out).not.toContain("frontyard-tig-430");
    expect(out).toContain("linkiq-tig-494");

    const all = renderStatus([fresh, old], plain, "running (pid 1)", {
      all: true,
    });
    expect(all).toContain("frontyard-tig-430");
    expect(all).not.toContain("stale —");
  });

  it("cues how long a shown gate has been parked, from time-in-stage", () => {
    const parked = wt("linkiq-tig-494", "PLAN_READY", t - 2 * 86_400);
    const out = renderStatus([parked], plain, "running (pid 1)", {
      staleSecs: 30 * 86_400,
    });
    expect(out).toContain("parked 2d");
  });

  it("never cues parked on a working stage", () => {
    const working = wt("linkiq-tig-494", "IMPLEMENTING", t - 2 * 86_400);
    const out = renderStatus([working], plain, "running (pid 1)");
    expect(out).not.toContain("parked");
  });
});

describe("renderAudit", () => {
  it("guides the user when nothing is recorded yet", () => {
    const out = renderAudit([], plain);
    expect(out).toContain("no audit records yet");
  });

  it("renders each record with actor, stage flow, and the action", () => {
    // 2026-06-09T10:00:00Z = 1780999200
    const ts = 1_780_999_200;
    const records: HistoryRecord[] = [
      {
        action: "/simplify",
        event: "Stop",
        from: "IMPLEMENTING",
        kind: "advance",
        name: "frontyard-tig-430",
        seq: 1,
        to: "SIMPLIFY",
        ts,
        workspaceId: "ws-1",
      },
      {
        event: "approve",
        from: "PLAN_READY",
        kind: "approve",
        name: "frontyard-tig-430",
        seq: 0,
        to: "IMPLEMENTING",
        ts: ts + 60,
        workspaceId: "ws-1",
      },
    ];
    const out = renderAudit(records, plain);
    expect(out).toContain("2 events");
    // A timezone-stable stamp, the actor, the slash command, and the human action.
    expect(out).toContain("06-09 10:00:00");
    expect(out).toContain("watcher");
    expect(out).toContain("/simplify");
    expect(out).toContain("you");
    expect(out).toContain("plan ready → implementing");
  });
});
