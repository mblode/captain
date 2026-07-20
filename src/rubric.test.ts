import { describe, expect, it } from "vitest";

import { renderRubric, rubricBody, rubricHash } from "./rubric";
import type { Issue } from "./types";

const issue: Issue = {
  criteria: [{ ref: "ENG-404", title: "Child task" }],
  description: "The contract body",
  identifier: "ENG-403",
  title: "Fix launch flow",
};

describe("renderRubric", () => {
  it("derives criteria from the issue plus the standard repo gates", () => {
    const { text } = renderRubric(issue, "ENG-403");
    expect(text).toContain("# Definition of done — ENG-403");
    expect(text).toContain("**Fix launch flow**");
    expect(text).toContain("Child task (ENG-404).");
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

  it("round-trips the hash when the description contains a ## Verdict line", () => {
    // The description is embedded verbatim, so a `## Verdict` heading inside it
    // must not truncate the hashed body (splitting on the last heading, not the
    // first). Otherwise the worktree could never reach READY TO MERGE.
    const withHeading: Issue = {
      ...issue,
      description: "Intro\n\n## Verdict\n\nsome prose the ticket author wrote",
    };
    const { hash, text } = renderRubric(withHeading, "ENG-403");
    expect(rubricHash(rubricBody(text))).toBe(hash);
  });

  it("adds a data-scope criterion only when a guardrail is passed", () => {
    const without = renderRubric(issue, "ENG-403");
    const withScope = renderRubric(issue, "ENG-403", "no customer data");
    expect(without.text).not.toContain("data-scope guardrail");
    expect(withScope.text).toContain("data-scope guardrail");
    // a criterion change must move the body hash (it gates the verdict)
    expect(withScope.hash).not.toBe(without.hash);
  });
});

describe("rubricBody", () => {
  it("returns the whole text when no verdict heading exists", () => {
    expect(rubricBody("hand-written rubric")).toBe("hand-written rubric");
  });
});
