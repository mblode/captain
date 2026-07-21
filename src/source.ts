import {
  fetchDonebearTask,
  isDonebearToken,
  parseDonebearInput,
} from "./donebear";
import { isLinearToken, parseIssueInput } from "./issue";
import { fetchLinearIssue } from "./linear";
import type { Issue, ParsedIssue } from "./types";

// One issue source (Linear, donebear). The single owner of "which source claims
// this token, and how do I parse + fetch it" — so routing files (route.ts,
// runner.ts, cmux.ts) ask the registry instead of enumerating sources, and
// adding a source touches only this file.
export interface IssueSource {
  // the brief/rubric label ("Linear" | "donebear")
  name: string;
  // environment variable required to fetch this source; diagnostics stay at
  // the source seam so adding a source does not add a runner branch.
  credential: string;
  // does this source claim the token? (a bare id/URL/UUID, no trailing words)
  claims(token: string): boolean;
  // parse the token, then bind the fetch that resolves it to a neutral Issue.
  // Pairing parse+fetch here lets each source close over its own concrete parse
  // result (e.g. donebear's UUID) without the registry casting between shapes.
  prepare(token: string): {
    parsed: ParsedIssue;
    fetch: (env: NodeJS.ProcessEnv) => Promise<Issue | undefined>;
  };
}

const linearSource: IssueSource = {
  claims: isLinearToken,
  credential: "LINEAR_API_KEY",
  name: "Linear",
  prepare: (token) => {
    const parsed = parseIssueInput(token);
    return { fetch: (env) => fetchLinearIssue(parsed.displayId, env), parsed };
  },
};

const donebearSource: IssueSource = {
  claims: isDonebearToken,
  credential: "DONEBEAR_TOKEN",
  name: "donebear",
  prepare: (token) => {
    const parsed = parseDonebearInput(token);
    return { fetch: (env) => fetchDonebearTask(parsed.uuid, env), parsed };
  },
};

// Registry order is match precedence; the predicates are mutually exclusive
// (a Linear id/URL can't be a donebear UUID/URL), so order is not load-bearing.
export const SOURCES: IssueSource[] = [linearSource, donebearSource];

// The source that claims a token, else undefined (a free-form task token).
export const sourceFor = (token: string): IssueSource | undefined =>
  SOURCES.find((source) => source.claims(token));

// Is this token issue work (any source claims it) vs a free-form dispatch task?
// The single predicate the routing sites share, replacing scattered
// `isLinearToken(t) || isDonebearToken(t)` chains.
export const isIssueToken = (token: string): boolean =>
  SOURCES.some((source) => source.claims(token));
