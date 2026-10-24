import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { loadOpenspecBase } from "./config";

// OpenSpec (github.com/Fission-AI/OpenSpec) keeps each piece of planned work as
// a Markdown folder: openspec/changes/<id>/{proposal.md, tasks.md, design.md,
// specs/**/spec.md}. Finished changes move to openspec/changes/archive/. The
// folders live in the repo's OpenSpec HOME, outside the repo, so no change is
// ever committed. `captain spec` turns a change into a task whose body points
// back at the folder; the folder stays the plan of record.
const CHANGES_DIR = join("openspec", "changes");
const ARCHIVE = "archive";

// The repo's OpenSpec home: `<base>/<repo name>` when that exists (or v2's
// memory used the bare name), else `<base>/<repo name>-<hash8>`. The same key
// v2 used, so a repo's existing changes are found where they already are.
export const openspecHome = (
  repo: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const base = loadOpenspecBase(env);
  const name = basename(repo);
  const legacyMemory = join(
    env.HOME || homedir(),
    ".claude",
    "captain",
    "memory",
    name,
    "learnings.md"
  );
  if (existsSync(join(base, name)) || existsSync(legacyMemory)) {
    return join(base, name);
  }
  const hash = createHash("sha256").update(repo).digest("hex").slice(0, 8);
  return join(base, `${name}-${hash}`);
};

const changeDir = (home: string, id: string): string =>
  join(home, CHANGES_DIR, id);

const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
};

// A change exists when its proposal does; that is the one file OpenSpec
// requires.
export const isChange = (home: string, id: string): boolean =>
  id !== ARCHIVE &&
  !id.includes("/") &&
  existsSync(join(changeDir(home, id), "proposal.md"));

// Every active (unarchived) change, sorted by id.
export const listChanges = (home: string): string[] => {
  try {
    return readdirSync(join(home, CHANGES_DIR), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((id) => isChange(home, id))
      .toSorted();
  } catch {
    return [];
  }
};

const OPEN_TASK = /^\s*[-*] \[ \] (.+)$/u;

// The proposal's first heading, minus the legacy "Change:" lead. The current
// template's heading is a bare "# Proposal" (OpenSpec titles a change by its
// id), which names nothing, so it falls back to the id.
export const proposalTitle = (proposal: string): string | undefined => {
  const title = /^#\s+(?:Change:\s*)?(.+)$/mu.exec(proposal)?.[1].trim();
  return title && title.toLowerCase() !== "proposal" ? title : undefined;
};

// tasks.md reduced to its open boxes, keeping the `## ` headings so its
// `## Smoke test` section survives into the task body (see smokeOf).
// Checked boxes are already done and are not part of the contract.
export const openTasks = (tasks: string): string =>
  tasks
    .split("\n")
    .filter((line) => line.startsWith("## ") || OPEN_TASK.test(line))
    .join("\n")
    .trim();

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

// A change folder as a task title and body. The proposal, the design (if any)
// and the spec deltas are the contract; tasks.md's open boxes are the criteria,
// and its `## Smoke test` boxes the production checks.
export const readChange = (
  home: string,
  id: string
): { title: string; body: string } => {
  const dir = changeDir(home, id);
  const proposal = readOptional(join(dir, "proposal.md")) ?? "";
  const design = readOptional(join(dir, "design.md"));
  const tasks = openTasks(readOptional(join(dir, "tasks.md")) ?? "");
  const specs = specFiles(dir);

  let body = `OpenSpec change folder: \`${dir}/\`\n\n${proposal.trim()}\n`;
  if (design) {
    body += `\n### Design (\`${dir}/design.md\`)\n\n${design.trim()}\n`;
  }
  if (specs.length > 0) {
    body += `\n### Spec deltas\n\nRead these before planning; they are part of the contract:\n\n${specs
      .map((path) => `- \`${dir}/${path}\``)
      .join("\n")}\n`;
  }
  if (tasks) {
    body += `\n${tasks}\n`;
  }
  return { body, title: proposalTitle(proposal) ?? id };
};
