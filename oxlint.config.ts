import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// Architectural contracts (research/architecture.md) — lint-enforced because
// contracts decay without a rule:
//   1. The pure domain (pipeline.ts, verdict.ts) never imports I/O.
//   2. saveState is banned outside commit.ts: the watcher's single mutator,
//      commit(), and the persist() alias are the only sanctioned writers.
//      *.test.ts is exempt — state.test.ts exercises saveState itself, and the
//      `vi.spyOn(state, "fleetDir")` pattern needs `import * as state`, which
//      the named-import ban would flag (see the note in commit.ts).
const SAVE_STATE_BAN = [
  "error",
  {
    paths: [
      {
        importNames: ["saveState"],
        message:
          "All state mutation goes through commit() — import { commit, persist } from './commit' instead.",
        name: "./state",
      },
      {
        importNames: ["saveState"],
        message:
          "All state mutation goes through commit() — import { commit, persist } from './captain/commit' instead.",
        name: "./captain/state",
      },
    ],
  },
];

const PURE_DOMAIN_BAN = [
  "error",
  {
    paths: [
      ...(SAVE_STATE_BAN[1] as { paths: object[] }).paths,
      {
        message: "pipeline.ts/verdict.ts are PURE — no fs; take data as input.",
        name: "node:fs",
      },
      {
        message: "pipeline.ts/verdict.ts are PURE — no fs; take data as input.",
        name: "node:fs/promises",
      },
      {
        message:
          "pipeline.ts/verdict.ts are PURE — no subprocesses; use the CmuxPort seam.",
        name: "node:child_process",
      },
    ],
  },
];

export default defineConfig({
  extends: [core],
  ignorePatterns: core.ignorePatterns,
  overrides: [
    {
      files: ["src/**/*.ts"],
      rules: { "no-restricted-imports": SAVE_STATE_BAN },
    },
    {
      files: ["src/captain/pipeline.ts", "src/captain/verdict.ts"],
      rules: { "no-restricted-imports": PURE_DOMAIN_BAN },
    },
    {
      files: ["src/**/*.test.ts", "src/captain/commit.ts"],
      rules: { "no-restricted-imports": "off" },
    },
  ],
});
