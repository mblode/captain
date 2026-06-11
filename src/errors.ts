// Semantic exit codes shared by the CLI surface so a machine driver can branch
// on a number without parsing prose. 1 stays the generic/unexpected fallback.
//   2  — usage error or a bad/unresolvable reference (the agent passed garbage)
//   10 — a required credential is missing (e.g. LINEAR_API_KEY)
//   11 — cmux is not reachable (its daemon is down)
export const EXIT = {
  CMUX_UNREACHABLE: 11,
  GENERIC: 1,
  MISSING_CREDENTIAL: 10,
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
