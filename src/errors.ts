// Semantic exit codes shared by the CLI surface so a machine driver can branch
// on a number without parsing prose. 1 stays the generic/unexpected fallback.
//   2  — usage error or a bad/unresolvable reference (the agent passed garbage)
//   11 — cmux is not reachable (its daemon is down)
//   12 — the System One judge (TypeSafe) is not configured or not reachable;
//        only `captain triage` can raise it — every other command is offline
export const EXIT = {
  CMUX_UNREACHABLE: 11,
  GENERIC: 1,
  JUDGE_UNAVAILABLE: 12,
  USAGE: 2,
} as const;

export class CliError extends Error {
  readonly exitCode: number;
  // A stable machine code for the failure, surfaced in `--json` as
  // {error:{type}}. Optional: legacy throws without one read as generic.
  readonly errorType?: string;

  constructor(
    message: string,
    exitCode: number = EXIT.GENERIC,
    errorType?: string
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.errorType = errorType;
  }
}
