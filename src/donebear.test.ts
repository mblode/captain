import { describe, expect, it } from "vitest";

import {
  fetchDonebearTask,
  isDonebearToken,
  mapTaskToIssue,
  parseDonebearInput,
} from "./donebear";
import type { DonebearChecklistItem } from "./types";

const UUID = "35a2097c-a5c9-477f-b50c-d39b942567a9";
const URL = `https://donebear.com/matthew-blode/task/${UUID}`;

describe("isDonebearToken", () => {
  it("recognises a task URL and a bare UUID", () => {
    expect(isDonebearToken(URL)).toBe(true);
    expect(isDonebearToken(UUID)).toBe(true);
    expect(isDonebearToken(UUID.toUpperCase())).toBe(true);
  });

  it("rejects Linear ids, phrases, and junk", () => {
    expect(isDonebearToken("TIG-430")).toBe(false);
    expect(isDonebearToken("tidy the readme")).toBe(false);
    // a prefix is not a full UUID
    expect(isDonebearToken("35a2097c")).toBe(false);
    expect(isDonebearToken("https://linear.app/x/issue/TIG-1")).toBe(false);
  });
});

describe("parseDonebearInput", () => {
  it("derives db-<first8hex> from a URL and keeps the full UUID", () => {
    expect(parseDonebearInput(URL)).toEqual({
      displayId: "db-35a2097c",
      issueId: "db-35a2097c",
      slug: "",
      uuid: UUID,
    });
  });

  it("parses a bare UUID the same way", () => {
    expect(parseDonebearInput(UUID)).toEqual({
      displayId: "db-35a2097c",
      issueId: "db-35a2097c",
      slug: "",
      uuid: UUID,
    });
  });
});

const item = (
  overrides: Partial<DonebearChecklistItem> & { title: string }
): DonebearChecklistItem => ({
  completedAt: null,
  id: overrides.id ?? overrides.title,
  sortOrder: overrides.sortOrder ?? 0,
  ...overrides,
});

describe("mapTaskToIssue", () => {
  it("maps unchecked items to sub-issue criteria and lists all in the description", () => {
    const issue = mapTaskToIssue(
      { description: "iOS bugs to fix", id: UUID, title: "iOS bugs" },
      [
        item({ sortOrder: 1, title: "Fix checklist" }),
        item({
          completedAt: "2026-07-20T00:00:00Z",
          sortOrder: 2,
          title: "Done already",
        }),
        item({ sortOrder: 3, title: "Fix crashes" }),
      ],
      "db-35a2097c"
    );

    expect(issue.identifier).toBe("db-35a2097c");
    expect(issue.title).toBe("iOS bugs");
    // only the two OPEN items become acceptance criteria (ref-less: donebear
    // checklist items have no sub-issue identifier)
    expect(issue.criteria).toEqual([
      { title: "Fix checklist" },
      { title: "Fix crashes" },
    ]);
    // the full checklist (with state) rides in the description for context
    expect(issue.description).toContain("- [ ] Fix checklist");
    expect(issue.description).toContain("- [x] Done already");
    expect(issue.description).toContain("- [ ] Fix crashes");
    expect(issue.description).toContain("iOS bugs to fix");
  });

  it("orders items by sortOrder", () => {
    const issue = mapTaskToIssue(
      { description: "", id: UUID, title: "t" },
      [
        item({ sortOrder: 2, title: "second" }),
        item({ sortOrder: 1, title: "first" }),
      ],
      "db-abc12345"
    );
    expect(issue.criteria?.map((c) => c.title)).toEqual(["first", "second"]);
  });

  it("produces no criteria and no checklist block for an empty checklist", () => {
    const issue = mapTaskToIssue(
      { description: "just a task", id: UUID, title: "t" },
      [],
      "db-abc12345"
    );
    expect(issue.criteria).toBeNull();
    expect(issue.description).toBe("just a task");
  });

  it("skips a blank checklist row so it never renders as an empty criterion", () => {
    const issue = mapTaskToIssue(
      { description: "", id: UUID, title: "t" },
      [
        item({ sortOrder: 1, title: "Fix crashes" }),
        item({ sortOrder: 2, title: "   " }),
        item({ sortOrder: 3, title: "" }),
      ],
      "db-abc12345"
    );
    expect(issue.criteria).toEqual([{ title: "Fix crashes" }]);
  });
});

const jsonResponse = (data: unknown): Response => Response.json({ data });

describe("fetchDonebearTask", () => {
  it("posts a bearer request and maps the task", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const issue = await fetchDonebearTask(
      UUID,
      { DONEBEAR_TOKEN: "db_secret" } as NodeJS.ProcessEnv,
      (url, init) => {
        seen.push({ init, url: String(url) });
        return Promise.resolve(
          jsonResponse({
            task: { id: UUID, key: "abcd1234", title: "iOS bugs" },
            taskChecklistItems: {
              nodes: [
                {
                  completedAt: null,
                  id: "i1",
                  sortOrder: 1,
                  title: "Fix crashes",
                },
              ],
            },
          })
        );
      }
    );

    expect(issue?.title).toBe("iOS bugs");
    expect(issue?.criteria?.[0]?.title).toBe("Fix crashes");
    expect(seen[0]?.url).toBe("https://api.donebear.com/graphql");
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer db_secret");
  });

  it("returns undefined without a token (no request made)", async () => {
    let called = false;
    const issue = await fetchDonebearTask(UUID, {} as NodeJS.ProcessEnv, () => {
      called = true;
      return Promise.resolve(jsonResponse({}));
    });
    expect(issue).toBeUndefined();
    expect(called).toBe(false);
  });

  it("returns undefined on a non-OK response", async () => {
    const issue = await fetchDonebearTask(
      UUID,
      { DONEBEAR_TOKEN: "db_secret" } as NodeJS.ProcessEnv,
      () => Promise.resolve(new Response("nope", { status: 401 }))
    );
    expect(issue).toBeUndefined();
  });
});
