import { describe, expect, it } from "vitest";

import { openBlockers, parseIssueInput, slugify } from "./issue";

describe("issue parsing", () => {
  it("parses bare issue IDs", () => {
    expect(parseIssueInput("ENG-423")).toEqual({
      displayId: "ENG-423",
      issueId: "eng-423",
      slug: "",
    });
  });

  it("parses issue IDs with slug words", () => {
    expect(parseIssueInput("eng-423 Add launch mode")).toEqual({
      displayId: "ENG-423",
      issueId: "eng-423",
      slug: "add-launch-mode",
    });
  });

  it("parses Linear issue URLs", () => {
    expect(
      parseIssueInput(
        "https://linear.app/acme/issue/ENG-423/add-launch-mode?foo=bar"
      )
    ).toEqual({
      displayId: "ENG-423",
      issueId: "eng-423",
      slug: "add-launch-mode",
    });
  });

  it("truncates slugs without leaving partial trailing words", () => {
    expect(
      slugify(
        "this is a very long issue title that should be cut at a stable word boundary"
      )
    ).toBe("this-is-a-very-long-issue-title-that-should-be-cut-at-a");
  });
});

describe("openBlockers", () => {
  it("lists only the blockers that are not done", () => {
    expect(
      openBlockers({
        blockedBy: [
          { done: true, identifier: "ENG-1" },
          { done: false, identifier: "ENG-2" },
          { done: false, identifier: "ENG-3" },
        ],
        identifier: "ENG-4",
      })
    ).toEqual(["ENG-2", "ENG-3"]);
  });

  // Fail-safe: a source with no dependency concept (donebear), an issue with no
  // relations, and a fetch that dropped them all read as unblocked. Refusing to
  // launch on missing data would be the dangerous default.
  it("reads absent, null, and empty relations as unblocked", () => {
    expect(openBlockers({ identifier: "ENG-5" })).toEqual([]);
    expect(openBlockers({ blockedBy: null, identifier: "ENG-6" })).toEqual([]);
    expect(openBlockers({ blockedBy: [], identifier: "ENG-7" })).toEqual([]);
  });
});
