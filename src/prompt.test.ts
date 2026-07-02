import { describe, expect, it } from "vitest";

import { renderPrompt, renderPromptExtras } from "./prompt";
import type { LinearIssue } from "./types";

describe("prompt rendering", () => {
  it("renders Linear copy-as-prompt shape without url", () => {
    const issue: LinearIssue = {
      children: {
        nodes: [
          {
            description: "Child body",
            id: "child-uuid",
            identifier: "ENG-404",
            title: "Child task",
          },
        ],
      },
      description:
        "Raw markdown with ![shot](https://uploads.linear.app/file.png)",
      identifier: "ENG-403",
      labels: { nodes: [{ name: "Frontend" }, { name: "Bug" }] },
      parent: {
        id: "parent-uuid",
        identifier: "ENG-400",
        title: "Parent task",
      },
      project: { name: "Activation" },
      team: { name: "Engineering" },
      title: "Fix launch flow",
    };

    const prompt = renderPrompt(issue, "ENG-403");

    expect(prompt).toContain("Work on Linear issue ENG-403:");
    expect(prompt).toContain('<issue identifier="ENG-403">');
    expect(prompt).toContain('<team name="Engineering"/>');
    expect(prompt).toContain("<label>Frontend</label>");
    expect(prompt).toContain('<project name="Activation"/>');
    expect(prompt).toContain('<parent-issue identifier="ENG-400">');
    expect(prompt).toContain("<id>parent-uuid</id>");
    expect(prompt).toContain('<sub-issue identifier="ENG-404">');
    expect(prompt).toContain("<id>child-uuid</id>");
    expect(prompt).not.toContain("<url>");
  });

  it("falls back when Linear data is unavailable", () => {
    expect(renderPrompt(undefined, "ENG-999")).toBe(
      "Work on Linear issue ENG-999."
    );
  });
});

describe("prompt extras", () => {
  it("is empty with no extras (the base prompt is byte-identical)", () => {
    expect(renderPromptExtras({})).toBe("");
  });

  it("renders the self-drive workflow with the full pipeline in order", () => {
    const out = renderPromptExtras({ workflow: true });
    expect(out).toContain("<workflow>");
    const steps = ["/tidy", "/pr-reviewer", "/pr-creator", "/pr-babysitter"];
    let last = -1;
    for (const step of steps) {
      const at = out.indexOf(step);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
    expect(out).toContain("without waiting to be told to continue");
    expect(out).not.toContain("<finishing-protocol>");
  });

  it("renders the configured skills in order between implement and finish", () => {
    const out = renderPromptExtras({
      skills: ["/tidy", "/pr-creator"],
      workflow: true,
    });
    expect(out).toContain("2. Once the plan is approved, implement it.");
    expect(out).toContain("3. Run /tidy.");
    expect(out).toContain("4. Run /pr-creator.");
    expect(out).toContain(
      "5. Finish with the finishing protocol below (verifier + verdict)."
    );
    // only the configured skills appear — not the unconfigured defaults
    expect(out).not.toContain("/pr-reviewer");
    expect(out).not.toContain("/pr-babysitter");
  });

  it("renders the finishing protocol around the rubric path", () => {
    const out = renderPromptExtras({ rubricPath: ".captain/rubric.md" });
    expect(out).toContain("<finishing-protocol>");
    expect(out).toContain(".captain/rubric.md");
    expect(out).toContain("fresh-context verifier");
    expect(out).toContain("write the verdict file");
    expect(out).not.toContain("<fleet-memory>");
  });

  it("renders the memory excerpt and the verified-only write rule", () => {
    const out = renderPromptExtras({
      memory: "- [TIG-1 2026-06-01] run yarn install first",
      memoryPath: "/mem/repo/learnings.md",
    });
    expect(out).toContain("<fleet-memory>");
    expect(out).toContain("run yarn install first");
    expect(out).toContain("/mem/repo/learnings.md");
    expect(out).toContain("VERIFIED this run");
    expect(out).not.toContain("<finishing-protocol>");
  });

  it("omits the consult block when there is nothing learned yet", () => {
    const out = renderPromptExtras({
      memory: "",
      memoryPath: "/mem/repo/learnings.md",
    });
    expect(out).not.toContain("consult these");
    expect(out).toContain("append 1-3 distilled learnings");
  });

  it("renders the data-scope guardrail when set", () => {
    const out = renderPromptExtras({
      dataScope: "Operate on repo source only; no customer data.",
    });
    expect(out).toContain("<data-scope>");
    expect(out).toContain("Operate on repo source only; no customer data.");
    expect(out).toContain("</data-scope>");
  });

  it("omits the data-scope block when unset and stays empty for {}", () => {
    expect(renderPromptExtras({ workflow: true })).not.toContain(
      "<data-scope>"
    );
    expect(renderPromptExtras({})).toBe("");
  });

  it("places the data-scope block between workflow and finishing-protocol", () => {
    const out = renderPromptExtras({
      dataScope: "no PII",
      rubricPath: ".captain/rubric.md",
      workflow: true,
    });
    const workflowAt = out.indexOf("</workflow>");
    const scopeAt = out.indexOf("<data-scope>");
    const protocolAt = out.indexOf("<finishing-protocol>");
    expect(workflowAt).toBeGreaterThanOrEqual(0);
    expect(scopeAt).toBeGreaterThan(workflowAt);
    expect(protocolAt).toBeGreaterThan(scopeAt);
  });
});
