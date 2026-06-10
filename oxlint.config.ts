import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// Architectural contract, lint-enforced because contracts decay without a rule:
// the pure domain (view.ts, verdict.ts) never imports I/O — it takes plain data
// (cmux feed items, run states, parsed verdicts) and decides what they mean;
// surface.ts is the one fs/cmux edge that feeds it.
const PURE_DOMAIN_BAN = [
  "error",
  {
    paths: [
      {
        message: "view.ts/verdict.ts are PURE — no fs; take data as input.",
        name: "node:fs",
      },
      {
        message: "view.ts/verdict.ts are PURE — no fs; take data as input.",
        name: "node:fs/promises",
      },
      {
        message:
          "view.ts/verdict.ts are PURE — no subprocesses; use the CmuxPort seam.",
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
      files: ["src/captain/view.ts", "src/captain/verdict.ts"],
      rules: { "no-restricted-imports": PURE_DOMAIN_BAN },
    },
  ],
});
