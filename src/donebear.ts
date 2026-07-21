import type {
  DonebearChecklistItem,
  DonebearGraphqlResponse,
  DonebearTask,
  Issue,
  IssueCriterion,
  ParsedIssue,
} from "./types";

type FetchLike = typeof fetch;

const DONEBEAR_ENDPOINT = "https://api.donebear.com/graphql";

// One request pulls the task and its checklist (one variable, two top-level
// fields). `key` is fetched for completeness but captain's short id derives from
// the URL's UUID (see parseDonebearInput) so worktree naming never waits on it.
const taskQuery =
  "query($id:ID!){task(id:$id){id key title description} taskChecklistItems(filter:{taskId:{eq:$id}}){nodes{id title sortOrder completedAt}}}";

const UUID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const uuidRegex = new RegExp(`^${UUID_PATTERN}$`, "u");
// A donebear task URL: https://donebear.com/<workspace-slug>/task/<uuid>. The
// slug segment is opaque; only the trailing UUID matters for the fetch.
const donebearUrlRegex = new RegExp(
  `^https?://(?:www\\.)?donebear\\.com/[^/]+/task/(${UUID_PATTERN})`,
  "u"
);

// A donebear token is either a task URL or a bare full task UUID. A bare UUID is
// unambiguous — it can't be a Linear id (letters-dash-digits) and is not a
// plausible one-word free-form task — so it routes to the donebear fetch.
export const isDonebearToken = (token: string): boolean => {
  const trimmed = token.trim();
  return uuidRegex.test(trimmed) || donebearUrlRegex.test(trimmed);
};

// captain's short id for a donebear task: `db-` + the first 8 hex of the task
// UUID (e.g. db-35a2097c). Derived from the token alone so worktree naming does
// not depend on the fetched `key`. Collision within a repo's fleet is ~1 in 4e9.
const shortIdFromUuid = (uuid: string): string =>
  `db-${uuid.replaceAll("-", "").slice(0, 8).toLowerCase()}`;

export interface ParsedDonebearTask extends ParsedIssue {
  // the full task UUID the GraphQL `task(id:)` query needs (URL/bare form both
  // resolve to this); displayId/issueId are the short `db-<8hex>` handle
  uuid: string;
}

export const parseDonebearInput = (input: string): ParsedDonebearTask => {
  const trimmed = input.trim();
  const uuid = donebearUrlRegex.exec(trimmed)?.[1] ?? trimmed;
  const shortId = shortIdFromUuid(uuid);
  // slug stays empty here; the caller fills it from the fetched title, exactly
  // like the Linear path (parseIssueInput → slugify(issue.title)).
  return { displayId: shortId, issueId: shortId, slug: "", uuid };
};

const isChecked = (item: DonebearChecklistItem): boolean =>
  Boolean(item.completedAt);

// Order checklist items by their donebear sort order (stable for equal/absent
// values), so criteria and the rendered list read in the task's own order.
const bySortOrder = (
  a: DonebearChecklistItem,
  b: DonebearChecklistItem
): number => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);

// The checklist rendered as a markdown block appended to the description, so the
// agent sees every item (done and not) with its state as context.
const renderChecklistBlock = (items: DonebearChecklistItem[]): string => {
  if (items.length === 0) {
    return "";
  }
  const lines = items.map(
    (item) => `- [${isChecked(item) ? "x" : " "}] ${item.title ?? ""}`
  );
  return `\n\n## Checklist\n\n${lines.join("\n")}\n`;
};

// PURE: fold a donebear task + its checklist into the neutral Issue the rest of
// captain consumes. Unchecked items with a title become acceptance criteria
// (renderRubric turns each into a numbered criterion, renderPrompt lists them);
// the full checklist (with state) is appended to the description as context.
// Completed items are never re-implemented as criteria, and a blank checklist
// row (empty title) is not a criterion — it would render as an empty one.
export const mapTaskToIssue = (
  task: DonebearTask,
  checklistNodes: DonebearChecklistItem[],
  displayId: string
): Issue => {
  const items = checklistNodes.toSorted(bySortOrder);
  const criteria: IssueCriterion[] = items
    .filter((item) => !isChecked(item) && (item.title ?? "").trim() !== "")
    .map((item) => ({ title: item.title ?? "" }));
  const description = `${task.description ?? ""}${renderChecklistBlock(items)}`;
  return {
    criteria: criteria.length > 0 ? criteria : null,
    description: description.trim() ? description : null,
    identifier: displayId,
    title: task.title ?? null,
  };
};

// Fetch a donebear task and map it into the neutral Issue. Fail-safe to
// undefined on any failure (missing token, non-OK, GraphQL error, throw) — the
// same contract as fetchLinearIssue, so a no-key run degrades to the coarse
// "implements <name>" rubric instead of crashing.
export const fetchDonebearTask = async (
  uuid: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch
): Promise<Issue | undefined> => {
  const token = env.DONEBEAR_TOKEN;
  if (!token) {
    return undefined;
  }

  try {
    const response = await fetchImpl(DONEBEAR_ENDPOINT, {
      body: JSON.stringify({ query: taskQuery, variables: { id: uuid } }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as DonebearGraphqlResponse;
    const task = body.data?.task;
    if (!task) {
      return undefined;
    }
    return mapTaskToIssue(
      task,
      body.data?.taskChecklistItems?.nodes ?? [],
      shortIdFromUuid(uuid)
    );
  } catch {
    return undefined;
  }
};
