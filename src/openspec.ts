import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Issue, IssueCriterion } from "./types";

// OpenSpec (github.com/Fission-AI/OpenSpec) keeps each piece of planned work as
// a Markdown folder: openspec/changes/<id>/{proposal.md, tasks.md, design.md,
// specs/**/spec.md}. Finished changes move to openspec/changes/archive/. The
// folder is the ticket: captain maps it INTO the source-neutral Issue so the
// rubric and brief stay source-agnostic, the same as Linear and donebear.
export const CHANGES_DIR = join("openspec", "changes");
const ARCHIVE = "archive";

const changeDir = (repoRoot: string, id: string): string =>
  join(repoRoot, CHANGES_DIR, id);

const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

// A change exists when its proposal does; that is the one file OpenSpec
// requires.
export const isOpenspecChange = (repoRoot: string, id: string): boolean =>
  id !== ARCHIVE &&
  !id.includes("/") &&
  existsSync(join(changeDir(repoRoot, id), "proposal.md"));

// Every active (unarchived) change, sorted by id.
export const listOpenspecChanges = (repoRoot: string): string[] => {
  try {
    return readdirSync(join(repoRoot, CHANGES_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => isOpenspecChange(repoRoot, id))
      .toSorted();
  } catch {
    return [];
  }
};

// The unchecked `- [ ] …` lines of tasks.md, one acceptance criterion each.
// Checked boxes are already done and are not part of the contract.
export const openTasks = (tasks: string): IssueCriterion[] =>
  [...tasks.matchAll(/^\s*[-*] \[ \] (.+)$/gmu)].map((m) => ({
    title: m[1].trim(),
  }));

// The proposal's first heading, minus the legacy "Change:" lead. The current
// template's heading is a bare "# Proposal" (OpenSpec titles a change by its
// id), which names nothing, so it falls back to the id too.
export const proposalTitle = (proposal: string): string | undefined => {
  const title = /^#\s+(?:Change:\s*)?(.+)$/mu.exec(proposal)?.[1].trim();
  return title && title.toLowerCase() !== "proposal" ? title : undefined;
};

const specFiles = (dir: string): string[] => {
  try {
    return readdirSync(join(dir, "specs"), { recursive: true })
      .map(String)
      .filter((path) => path.endsWith(".md"))
      .map((path) => join("specs", path))
      .toSorted();
  } catch {
    return [];
  }
};

// Read a change folder into an Issue. The proposal, the design (if any) and the
// spec deltas together are the contract; the open tasks are the criteria.
export const readOpenspecChange = (repoRoot: string, id: string): Issue => {
  const dir = changeDir(repoRoot, id);
  const proposal = readOptional(join(dir, "proposal.md")) ?? "";
  const design = readOptional(join(dir, "design.md"));
  const tasks = readOptional(join(dir, "tasks.md")) ?? "";
  const specs = specFiles(dir);
  const where = relative(repoRoot, dir);

  let description = `Change folder: \`${where}/\`\n\n${proposal.trim()}\n`;
  if (design) {
    description += `\n### Design (\`${where}/design.md\`)\n\n${design.trim()}\n`;
  }
  if (specs.length > 0) {
    description += `\n### Spec deltas\n\nRead these before planning; they are part of the contract:\n\n${specs
      .map((path) => `- \`${where}/${path}\``)
      .join("\n")}\n`;
  }

  return {
    criteria: openTasks(tasks),
    description,
    identifier: id,
    title: proposalTitle(proposal) ?? id,
  };
};
