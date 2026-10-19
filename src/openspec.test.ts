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
});
