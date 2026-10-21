import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listOpenspecChanges, readOpenspecChange } from "./openspec";

const repoWith = async (
  changes: Record<string, Record<string, string>>
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "captain-openspec-"));
  for (const [id, files] of Object.entries(changes)) {
    for (const [file, text] of Object.entries(files)) {
      const path = join(root, "openspec", "changes", id, file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, text);
    }
  }
  return root;
};

describe("OpenSpec changes", () => {
  it("lists active changes with a proposal, skipping the archive and drafts", async () => {
    const root = await repoWith({
      "add-dark-mode": { "proposal.md": "# Change: Add dark mode\n" },
      archive: { "proposal.md": "# old\n" },
      "no-proposal": { "tasks.md": "- [ ] x\n" },
    });
    expect(listOpenspecChanges(root)).toEqual(["add-dark-mode"]);
  });

  it("reads the proposal as the contract and open tasks as the criteria", async () => {
    const root = await repoWith({
      "add-dark-mode": {
        "proposal.md": "# Change: Add dark mode\n\n## Why\nEyes.\n",
        "specs/theme/spec.md": "## ADDED Requirements\n",
        "tasks.md":
          "## 1. Build\n- [x] 1.1 Tokens\n- [ ] 1.2 Toggle in settings\n",
      },
    });
    const issue = readOpenspecChange(root, "add-dark-mode");
    expect(issue.title).toBe("Add dark mode");
    expect(issue.criteria).toEqual([{ title: "1.2 Toggle in settings" }]);
    expect(issue.description).toContain("Eyes.");
    expect(issue.description).toContain(
      "openspec/changes/add-dark-mode/specs/theme/spec.md"
    );
  });

  it("titles a change by its id when the proposal uses the template's bare # Proposal", async () => {
    const root = await repoWith({
      "add-dark-mode": {
        "proposal.md": "# Proposal\n\n## Why\nEyes.\n",
        "tasks.md": "# Tasks\n\n## 1. Theme\n\n- [ ] 1.1 Add toggle\n",
      },
    });
    const issue = readOpenspecChange(root, "add-dark-mode");
    expect(issue.title).toBe("add-dark-mode");
    expect(issue.criteria).toEqual([{ title: "1.1 Add toggle" }]);
  });

  it("keeps smoke checks out of the criteria and reads them as the smoke list", async () => {
    const root = await repoWith({
      "add-dark-mode": {
        "proposal.md": "# Proposal\n",
        "tasks.md":
          "## 1. Theme\n\n- [ ] 1.1 Add toggle\n\n## Smoke test\n\n- [ ] S.1 Terminal: run it\n- [x] S.2 done already\n\n## 2. Docs\n\n- [ ] 2.1 Write docs\n",
      },
    });
    const issue = readOpenspecChange(root, "add-dark-mode");
    expect(issue.criteria).toEqual([
      { title: "1.1 Add toggle" },
      { title: "2.1 Write docs" },
    ]);
    expect(issue.smoke).toEqual(["S.1 Terminal: run it"]);
  });
});
