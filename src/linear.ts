import type { LinearGraphqlResponse, LinearIssue } from "./types.js";

const issueQuery =
  "query($id:String!){issue(id:$id){identifier title description team{name} labels{nodes{name}} project{name} parent{identifier id title description} children(first:50){nodes{identifier id title description}}}}";

export const fetchLinearIssue = async (
  displayId: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LinearIssue | undefined> => {
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
    return body.data?.issue ?? undefined;
  } catch {
    return undefined;
  }
};
