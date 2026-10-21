import { describe, expect, it } from "vitest";

import { renderRubric, rubricBody, rubricHash } from "./rubric";
import type { Issue } from "./types";

const issue: Issue = {
  criteria: [
    {
      description: "The complete child contract",
      ref: "ENG-404",
      title: "Child task",
    },
  ],
  description: "The contract body",
  identifier: "ENG-403",
  title: "Fix launch flow",
};

describe("renderRubric", () => {
  it("on a shared branch, done means tagged commits pushed to the branch, not a PR", () => {
    const { text } = renderRubric(
      issue,
      "add-dark-mode",
      undefined,
      "OpenSpec",
      {
        baseSha: "abc1234",
        branch: "main",
        stateDir: ".captain/changes/add-dark-mode",
      }
    );
    expect(text).toContain(
      'committed with "[add-dark-mode]" in the message and pushed to `main`'
    );
    expect(text).not.toContain("A PR is open");
    expect(text).toContain(
      "git log -p --grep='\\[add-dark-mode\\]' abc1234..HEAD"
    );
    expect(text).toContain(
      "write `.captain/changes/add-dark-mode/verdict.json`"
    );
  });

  it("on a shared branch, renders the smoke checks after the verdict, outside the hash", () => {
    const shared = {
      baseSha: "abc1234",
      branch: "main",
      stateDir: ".captain/changes/add-dark-mode",
    };
    const withSmoke = renderRubric(
      { ...issue, smoke: ["S.1 Terminal: run it"] },
      "add-dark-mode",
      undefined,
      "OpenSpec",
      shared
    );
    const derived = renderRubric(
      issue,
      "add-dark-mode",
      undefined,
      "OpenSpec",
      shared
    );
    const smokeAt = withSmoke.text.indexOf("\n## Smoke test\n");
    expect(smokeAt).toBeGreaterThan(withSmoke.text.indexOf("\n## Verdict\n"));
    expect(withSmoke.text).toContain("- S.1 Terminal: run it");
    expect(withSmoke.text).toContain(
      "`.captain/changes/add-dark-mode/smoke.json`"
    );
    expect(derived.text).toContain(
      "derive one terminal check and one browser check"
    );
    expect(withSmoke.hash).toBe(derived.hash);
    expect(rubricHash(rubricBody(withSmoke.text))).toBe(withSmoke.hash);
    expect(renderRubric(issue, "ENG-403").text).not.toContain("## Smoke test");
  });

  it("derives criteria from the issue plus the standard repo gates", () => {
    const { text } = renderRubric(issue, "ENG-403");
    expect(text).toContain("# Definition of done — ENG-403");
    expect(text).toContain("**Fix launch flow**");
    expect(text).toContain("Child task (ENG-404).");
    expect(text).toContain("The complete child contract");
    expect(text).toContain("The contract body");
    expect(text).toContain("test command passes");
    expect(text).toContain("typecheck and lint commands pass");
    expect(text).toContain('"ENG-403" in the title');
  });

  it("keeps complete source and optional issue context in the rubric", () => {
    const { text } = renderRubric(
      {
        ...issue,
        labels: { nodes: [{ name: "Frontend" }, { name: "Bug" }] },
        parent: {
          description: "The parent contract",
          ref: "ENG-400",
          title: "Parent task",
        },
        project: { name: "Activation" },
        team: { name: "Engineering" },
      },
      "ENG-403",
      undefined,
      "Linear"
    );
    expect(text).toContain("## Issue context");
    expect(text).toContain("- Source: Linear");
    expect(text).toContain("- Identifier: ENG-403");
    expect(text).toContain("- Team: Engineering");
    expect(text).toContain("- Project: Activation");
    expect(text).toContain("- Labels: Frontend, Bug");
    expect(text).toContain("Parent task (ENG-400)");
    expect(text).toContain("The parent contract");
  });

  // The plan artifact is graded, and its `na` is a FILE-EXISTENCE test — not an
  // exemption the agent argues, which is how the test criterion rotted.
  it("grades the diff against the approved plan, with a mechanical na rule", () => {
    const { text } = renderRubric(issue, "ENG-403");
    expect(text).toContain("The diff does what `.captain/plan.md` says");
    expect(text).toContain(
      'or every departure from it is named under that file\'s "## Deviations" heading'
    );
    expect(text).toContain(
      "Mark `na` only when `.captain/plan.md` does not exist."
    );
    // the verifier is handed the plan alongside the rubric and the diff
    expect(text).toContain("`.captain/plan.md` if it exists");
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
    expect(without.text).not.toContain("credential, payment detail, or PII");
    expect(withScope.text).toContain("credential, payment detail, or PII");
    // phrased as a scan with output — a negative asserted in prose is not evidence
    expect(withScope.text).toContain("Evidence must be a scan you ran");
    // a criterion change must move the body hash (it gates the verdict)
    expect(withScope.hash).not.toBe(without.hash);
  });
});

describe("rubricBody", () => {
  it("returns the whole text when no verdict heading exists", () => {
    expect(rubricBody("hand-written rubric")).toBe("hand-written rubric");
  });
});
