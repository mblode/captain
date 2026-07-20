import type {
  Issue,
  IssueCriterion,
  LinearApiIssue,
  LinearApiRelated,
  LinearGraphqlResponse,
} from "./types";

const issueQuery =
  "query($id:String!){issue(id:$id){identifier title description team{name} labels{nodes{name}} project{name} parent{identifier title description} children(first:50){nodes{identifier title description}}}}";

const toCriterion = (related: LinearApiRelated): IssueCriterion => ({
  description: related.description ?? null,
  ref: related.identifier,
  title: related.title ?? "",
});

// Map the raw Linear issue into the neutral Issue: sub-issues become criteria,
// the parent becomes a referenced criterion, the rest of the Linear context
// (team/labels/project) passes through untouched.
export const mapLinearIssue = (raw: LinearApiIssue): Issue => ({
  criteria: (raw.children?.nodes ?? []).map(toCriterion),
  description: raw.description ?? null,
  identifier: raw.identifier,
  labels: raw.labels ?? null,
  parent: raw.parent ? toCriterion(raw.parent) : null,
  project: raw.project ?? null,
  team: raw.team ?? null,
  title: raw.title ?? null,
});

export const fetchLinearIssue = async (
  displayId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Issue | undefined> => {
  const apiKey = env.LINEAR_API_KEY;
  if (!apiKey) {
    return undefined;
  }

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      body: JSON.stringify({ query: issueQuery, variables: { id: displayId } }),
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      return undefined;
    }

    const body = (await response.json()) as LinearGraphqlResponse;
    const raw = body.data?.issue;
    return raw ? mapLinearIssue(raw) : undefined;
  } catch {
    return undefined;
  }
};
