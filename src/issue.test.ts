import { describe, expect, it } from "vitest";

import { parseIssueInput, slugify } from "./issue";

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
