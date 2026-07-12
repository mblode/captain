import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // oxfmt's proseWrap reflows markdown into single lines — keep it off the
  // prose docs (README, AGENTS.md, research/, skills/, LICENSE) so their
  // hand-wrapped formatting survives.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "**/*.md", "**/*.mdx"],
});
