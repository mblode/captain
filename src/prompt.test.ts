import { describe, expect, it } from "vitest";

import { renderPrompt, renderPromptExtras } from "./prompt";
import type { Issue } from "./types";

describe("prompt rendering", () => {
  it("renders only the issue identity and points to the canonical rubric", () => {
    const issue: Issue = {
      criteria: [
        {
          description: "Child body",
          ref: "ENG-404",
          title: "Child task",
        },
      ],
      description:
        "Raw markdown with ![shot](https://uploads.linear.app/file.png)",
      identifier: "ENG-403",
      labels: { nodes: [{ name: "Frontend" }, { name: "Bug" }] },
      parent: {
        ref: "ENG-400",
        title: "Parent task",
      },
      project: { name: "Activation" },
      team: { name: "Engineering" },
      title: "Fix launch flow",
    };

    const prompt = renderPrompt(issue, "ENG-403");

    expect(prompt).toContain("Work on Linear issue ENG-403: Fix launch flow.");
    expect(prompt).toContain("Read `.captain/rubric.md` before planning");
    expect(prompt).not.toContain("Raw markdown");
    expect(prompt).not.toContain("Child body");
  });

  it("renders a source label other than Linear", () => {
    const prompt = renderPrompt(
      { criteria: [{ title: "Fix crashes" }], identifier: "db-35a2097c" },
      "db-35a2097c",
      "donebear"
    );
    expect(prompt).toContain("Work on donebear issue db-35a2097c.");
    expect(prompt).toContain("Read `.captain/rubric.md`");
    expect(prompt).not.toContain("Fix crashes");
  });

  it("falls back when issue data is unavailable", () => {
    expect(renderPrompt(undefined, "ENG-999")).toContain(
      "Work on Linear issue ENG-999."
    );
    expect(renderPrompt(undefined, "ENG-999")).toContain(
      "Read `.captain/rubric.md`"
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
    expect(out).toContain("nobody will tell you to continue");
    expect(out).not.toContain("<finishing-protocol>");
  });

  // The plan gate is the human's one cheap chance to redirect a run, so both
  // agent variants must ask for the unknowns rather than just "a plan".
  it("asks the plan to lead with ambiguities and assumptions", () => {
    for (const agent of ["claude", "codex"]) {
      const out = renderPromptExtras({ agent, workflow: true });
      expect(out).toContain("Lead it with what you are least sure of");
      expect(out).toContain("assumptions you had to make");
      expect(out).toContain("Never resolve an ambiguity silently.");
    }
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

  // Codex has no plan mode or plan-approval gate — a brief telling it to wait
  // for approval would stall the run at step 1 forever.
  it("swaps the plan-gate steps for codex (no approval wait)", () => {
    const out = renderPromptExtras({ agent: "codex", workflow: true });
    expect(out).not.toContain("you are launched in plan mode");
    expect(out).not.toContain("Once the plan is approved");
    expect(out).toContain("no plan-approval gate");
    // the rest of the pipeline is unchanged
    expect(out).toContain("3. Run /tidy.");
  });

  it("keeps the plan-gate steps for claude (and by default)", () => {
    for (const agent of ["claude", undefined]) {
      const out = renderPromptExtras({ agent, workflow: true });
      expect(out).toContain(
        "1. Plan first (you are launched in plan mode) and present the plan for approval."
      );
      expect(out).toContain("2. Once the plan is approved, implement it.");
    }
  });

  // Cross-session messaging (Claude Code ≥2.1.224) is optional breakage
  // warnings only — never a wait/approval channel. Codex has no SendMessage.
  it("allows claude (and default) a peer-warn SendMessage; omits it for codex", () => {
    for (const agent of ["claude", undefined]) {
      const out = renderPromptExtras({ agent, workflow: true });
      expect(out).toContain("you may SendMessage that session");
      expect(out).toContain("Do not wait on peers");
    }
    const codex = renderPromptExtras({ agent: "codex", workflow: true });
    expect(codex).not.toContain("SendMessage");
    expect(codex).not.toContain("Do not wait on peers");
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
    expect(out).toContain("append ONE learning");
    expect(out).toContain("at most 200 characters");
    expect(out).toContain("root cause of a verifier failure");
    expect(out).toContain("command or environment trap");
    // the discriminator is what the next agent DOES, not a two-branch prose test
    expect(out).toContain("would change what the next agent DOES");
    expect(out).toContain("Where code lives is not a learning");
    expect(out).toContain("without reading the file into context");
    expect(out).not.toContain("<finishing-protocol>");
  });

  it("omits the consult block when there is nothing learned yet", () => {
    const out = renderPromptExtras({
      memory: "",
      memoryPath: "/mem/repo/learnings.md",
    });
    expect(out).not.toContain("consult these");
    expect(out).toContain("append ONE learning");
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
