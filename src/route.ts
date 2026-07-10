// Bare-invocation routing for the CLI. Pure + side-effect free so it can be
// unit-tested without importing cli.ts (which runs main() on import).

import { isLinearToken } from "./issue";

// Splice `start` in front of a bare work argument so `captain tig-123` /
// `captain "tidy the readme"` behave like `captain start …` (subsuming the old
// `linear-worktree` invocation). `knownCommands` is derived from the commander
// registry at the call site, so a new subcommand can never be swallowed here.
//
// Left untouched: no args (commander prints help), a leading flag
// (--version/--help), any known subcommand — and a single bare word that isn't
// Linear work. That last one is far more likely a typo'd subcommand than a
// one-word task ("captain statsu"), and splicing `start` in would launch an
// agent and clobber the checkout's `.captain/` rubric; commander's "unknown
// command" error is the right outcome. A genuine one-word task stays available
// as `captain start deploy`.
export const withImplicitStart = (
  argv: string[],
  knownCommands: ReadonlySet<string>
): string[] => {
  const first = argv.at(2);
  if (!first || first.startsWith("-") || knownCommands.has(first)) {
    return argv;
  }
  const work = argv.slice(2).filter((arg) => !arg.startsWith("-"));
  if (work.length === 1 && !isLinearToken(first) && !first.includes(" ")) {
    return argv;
  }
  return [...argv.slice(0, 2), "start", ...argv.slice(2)];
};
