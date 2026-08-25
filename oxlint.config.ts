import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// Architectural contract, lint-enforced because contracts decay without a rule.
//
// PURE here has ONE definition: the module reads no filesystem and spawns no
// process. It takes plain data in and returns a decision. `node:crypto` is
// allowed (rubric.ts hashes) — it is deterministic and needs no I/O.
//
// The list below is the contract. Anything AGENTS.md calls pure belongs in it;
// a module documented as pure but missing here is a contract with no rule, and
// decays at the first deadline. The messages stay file-agnostic on purpose —
// enumerating the members inside the message is how the last list went stale.
const PURE_DOMAIN_BAN = [
  "error",
  {
    paths: [
      {
        message:
          "This module is PURE (see oxlint.config.ts) — no fs; take data as input.",
        name: "node:fs",
      },
      {
        message:
          "This module is PURE (see oxlint.config.ts) — no fs; take data as input.",
        name: "node:fs/promises",
      },
      {
        message:
          "This module is PURE (see oxlint.config.ts) — no subprocesses; use the CmuxPort seam.",
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
      files: [
        // the fleet-surface decisions
        "src/captain/view.ts",
        "src/captain/verdict.ts",
        "src/captain/gain.ts",
        // the launch-side decisions: the rubric text, argv routing, the
        // frontier rule. Documented as pure in AGENTS.md, unenforced until now.
        "src/rubric.ts",
        "src/route.ts",
        "src/issue.ts",
      ],
      rules: { "no-restricted-imports": PURE_DOMAIN_BAN },
    },
  ],
  // Mechanical/stylistic rules newly enforced by the ultracite 7.9 ruleset that
  // this codebase deliberately does otherwise — relaxed rather than churned:
  // named node: imports, sequential awaits (git/fs ordering is intentional),
  // method-signature ports, unnamed capture groups, coercion style, and a
  // false-positive no-unreachable-loop on git.ts's retry loop.
  rules: {
    "eslint/no-await-in-loop": "off",
    "eslint/no-unreachable-loop": "off",
    "eslint/prefer-named-capture-group": "off",
    "typescript/method-signature-style": "off",
    "unicorn/import-style": "off",
    "unicorn/prefer-number-coercion": "off",
  },
});
