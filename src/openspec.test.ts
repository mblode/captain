import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isChange,
  listChanges,
  openspecHome,
  openTasks,
  proposalTitle,
  readChange,
} from "./openspec";
import { criteriaOf, smokeOf } from "./task";

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "captain-openspec-"));
  const change = join(dir, "openspec", "changes", "add-x");
  mkdirSync(join(change, "specs", "theme"), { recursive: true });
  mkdirSync(join(dir, "openspec", "changes", "archive", "old-one"), {
    recursive: true,
  });
  writeFileSync(
    join(change, "proposal.md"),
    "# Proposal\n\n## Why\nBecause.\n"
  );
  writeFileSync(join(change, "design.md"), "Use CSS variables.\n");
  writeFileSync(join(change, "specs", "theme", "spec.md"), "## ADDED\n");
  writeFileSync(
    join(change, "tasks.md"),
    "# Tasks\n\n## 1. Work\n\n- [ ] 1.1 Toggle\n- [x] 1.2 Done\n\n## Smoke test\n\n- [ ] S.1 curl prod\n"
  );
  return dir;
};

describe("openspec", () => {
  it("lists active changes and never the archive", () => {
    const dir = home();
    expect(listChanges(dir)).toEqual(["add-x"]);
    expect(isChange(dir, "archive")).toBe(false);
    expect(isChange(dir, "missing")).toBe(false);
  });

  it("reads a change into a task body whose criteria and smoke checks split", () => {
    const dir = home();
    const { title, body } = readChange(dir, "add-x");
    expect(title).toBe("add-x");
    expect(body).toContain("Because.");
    expect(body).toContain("Use CSS variables.");
    expect(body).toContain("specs/theme/spec.md");
    expect(criteriaOf(body)).toEqual(["1.1 Toggle"]);
    expect(smokeOf(body)).toEqual(["S.1 curl prod"]);
  });

  it("keeps headings and open boxes only", () => {
    expect(openTasks("# T\n\nprose\n## A\n- [ ] a\n- [x] b")).toBe(
      "## A\n- [ ] a"
    );
  });

  it("titles a change by its heading unless it is the bare template one", () => {
    expect(proposalTitle("# Change: Dark mode\n")).toBe("Dark mode");
    expect(proposalTitle("# Proposal\n")).toBeUndefined();
  });

  // v2 kept homes at <base>/<name> or <base>/<name>-<hash8>; the same key
  // finds a repo's existing changes.
  it("uses the bare repo name when that home exists, else a hashed one", () => {
    const base = mkdtempSync(join(tmpdir(), "captain-base-"));
    const env = { CAPTAIN_OPENSPEC_HOME: base, HOME: base };
    expect(openspecHome("/code/chat", env)).toMatch(/\/chat-[0-9a-f]{8}$/u);
    mkdirSync(join(base, "chat"));
    expect(openspecHome("/code/chat", env)).toBe(join(base, "chat"));
  });
});
