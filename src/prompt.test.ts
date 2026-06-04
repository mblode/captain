import { describe, expect, it } from "vitest";

import { renderPrompt } from "./prompt";
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
