import { describe, expect, it } from "vitest";

import { renderRubric, rubricBody, rubricHash } from "./rubric";
import type { LinearIssue } from "./types";

const issue: LinearIssue = {
  children: {
    nodes: [{ identifier: "ENG-404", title: "Child task" }],
  },
  description: "The contract body",
  identifier: "ENG-403",
  title: "Fix launch flow",
};

describe("renderRubric", () => {
  it("derives criteria from the issue plus the standard repo gates", () => {
    const { text } = renderRubric(issue, "ENG-403");
    expect(text).toContain("# Definition of done — ENG-403");
    expect(text).toContain("**Fix launch flow**");
    expect(text).toContain("Sub-issue ENG-404: Child task.");
    expect(text).toContain("The contract body");
    expect(text).toContain("test command passes");
    expect(text).toContain("typecheck and lint commands pass");
    expect(text).toContain('"ENG-403" in the title');
  });

  it("always ships the verification procedure and verdict schema", () => {
    const { text } = renderRubric(undefined, "ENG-999");
    expect(text).toContain("## How to verify");
    expect(text).toContain("FRESH context");
    expect(text).toContain("without a verifier run");
    expect(text).toContain("## Verdict");
    expect(text).toContain(".captain/verdict.json");
    expect(text).toContain('"rubricHash"');
  });

  it("embeds the hash of the body, recoverable via rubricBody", () => {
    const { hash, text } = renderRubric(issue, "ENG-403");
    expect(text).toContain(`\`${hash}\``);
    // The watcher-side recompute (rubricBody + rubricHash) must agree with the
    // hash render embedded — this is the tamper check's round trip.
    expect(rubricHash(rubricBody(text))).toBe(hash);
  });

  it("changes the hash when the criteria change", () => {
    const a = renderRubric(issue, "ENG-403").hash;
    const b = renderRubric(
      { ...issue, title: "Different goal" },
      "ENG-403"
    ).hash;
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same issue", () => {
    expect(renderRubric(issue, "ENG-403")).toEqual(
      renderRubric(issue, "ENG-403")
    );
  });
});

describe("rubricBody", () => {
  it("returns the whole text when no verdict heading exists", () => {
    expect(rubricBody("hand-written rubric")).toBe("hand-written rubric");
  });
});
