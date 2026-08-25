// Bare-invocation routing for the CLI. Pure + side-effect free so it can be
// unit-tested without importing cli.ts (which runs main() on import).

import { isIssueToken } from "./source";

// Splice `start` in front of a bare work argument so `captain tig-123` /
// `captain "tidy the readme"` behave like `captain start …` (subsuming the old
// `linear-worktree` invocation). `knownCommands` is derived from the commander
// registry at the call site, so a new subcommand can never be swallowed here.
//
// Left untouched: no args (commander prints help), a leading flag
// (--version/--help), any known subcommand — and two shapes that are far more
// likely a typo'd subcommand than a task, because splicing `start` into either
// would LAUNCH AN AGENT and clobber the checkout's `.captain/` rubric instead
// of erroring. A wrong guess that mutates state is worse than the error:
//
//   1. a single bare word that isn't issue work ("captain statsu")
//   2. a bare word followed by issue tokens ("captain aprove tig-430",
//      "captain fanout TIG-430") — a real free-form task does not name tickets
//      as separate argv words; a mistyped subcommand and its targets do
//
// Both fall through to commander, which errors AND suggests the near miss.
// A genuine task keeps working quoted ("captain \"tidy the readme\"") or via
// explicit `captain start deploy`. A bare task UUID IS issue work, so it
// splices through.
export const withImplicitStart = (
  argv: string[],
  knownCommands: ReadonlySet<string>
): string[] => {
  const first = argv.at(2);
  if (!first || first.startsWith("-") || knownCommands.has(first)) {
    return argv;
  }
  const work = argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const firstIsBareWord = !isIssueToken(first) && !first.includes(" ");
  if (
    firstIsBareWord &&
    (work.length === 1 || work.slice(1).some(isIssueToken))
  ) {
    return argv;
  }
  return [...argv.slice(0, 2), "start", ...argv.slice(2)];
};
