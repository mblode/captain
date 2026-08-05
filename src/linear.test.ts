import { describe, expect, it } from "vitest";

import { mapLinearIssue } from "./linear";

describe("mapLinearIssue", () => {
  it("maps sub-issues to criteria, the parent to a referenced criterion, and passes context through", () => {
    const issue = mapLinearIssue({
      children: {
        nodes: [
          {
            description: "Child body",
            identifier: "ENG-404",
            title: "Child task",
          },
          { identifier: "ENG-405", title: "Second child" },
        ],
      },
      description: "The contract",
      identifier: "ENG-403",
      labels: { nodes: [{ name: "Frontend" }] },
      parent: { identifier: "ENG-400", title: "Parent task" },
      project: { name: "Activation" },
      team: { name: "Engineering" },
      title: "Fix launch flow",
    });

    expect(issue.identifier).toBe("ENG-403");
    expect(issue.title).toBe("Fix launch flow");
    // sub-issues → criteria, each keeping its identifier as the display ref
    expect(issue.criteria).toEqual([
      { description: "Child body", ref: "ENG-404", title: "Child task" },
      { description: null, ref: "ENG-405", title: "Second child" },
    ]);
    // parent becomes a referenced criterion (context, rendered separately)
    expect(issue.parent).toEqual({
      description: null,
      ref: "ENG-400",
      title: "Parent task",
    });
    // Linear-only context passes through untouched
    expect(issue.team).toEqual({ name: "Engineering" });
    expect(issue.labels).toEqual({ nodes: [{ name: "Frontend" }] });
    expect(issue.project).toEqual({ name: "Activation" });
  });

  it("yields empty criteria and null parent when the issue has neither", () => {
    const issue = mapLinearIssue({
      identifier: "ENG-999",
      title: "Standalone",
    });
    expect(issue.criteria).toEqual([]);
    expect(issue.parent).toBeNull();
    expect(issue.description).toBeNull();
    // no relations selected ⇒ no blockers ⇒ unblocked, never "unknown"
    expect(issue.blockedBy).toEqual([]);
  });

  it("maps blocking relations from either end and resolves done state", () => {
    const issue = mapLinearIssue({
      identifier: "ENG-500",
      inverseRelations: {
        nodes: [
          // the relation record names ENG-500 as relatedIssue, blocker as issue
          {
            issue: { identifier: "ENG-498", state: { type: "started" } },
            relatedIssue: { identifier: "ENG-500", state: { type: "backlog" } },
            type: "blocks",
          },
          // ...and the opposite orientation resolves to the same blocker end
          {
            issue: { identifier: "ENG-500", state: { type: "backlog" } },
            relatedIssue: {
              identifier: "ENG-499",
              state: { type: "completed" },
            },
            type: "blocks",
          },
          // a non-blocking relation is not a blocker
          {
            issue: { identifier: "ENG-497", state: { type: "backlog" } },
            type: "related",
          },
        ],
      },
      title: "Blocked work",
    });

    expect(issue.blockedBy).toEqual([
      { done: false, identifier: "ENG-498" },
      { done: true, identifier: "ENG-499" },
    ]);
  });

  it("treats canceled blockers as done and unknown states as still blocking", () => {
    const issue = mapLinearIssue({
      identifier: "ENG-600",
      inverseRelations: {
        nodes: [
          {
            issue: { identifier: "ENG-601", state: { type: "canceled" } },
            type: "blocks",
          },
          // a state Linear did not return at all must not read as done
          { issue: { identifier: "ENG-602" }, type: "blocks" },
        ],
      },
    });

    expect(issue.blockedBy).toEqual([
      { done: true, identifier: "ENG-601" },
      { done: false, identifier: "ENG-602" },
    ]);
  });
});
