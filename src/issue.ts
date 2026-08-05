import { CliError } from "./errors";
import type { Issue, ParsedIssue } from "./types";

export const issueIdPattern = "[A-Za-z][A-Za-z0-9_]*-[0-9]+";
export const issueIdRegex = new RegExp(`^${issueIdPattern}$`, "u");

export const isIssueId = (value: string): boolean => issueIdRegex.test(value);

// A start token is Linear work if it's a bare issue id (TIG-430) or a Linear
// URL; anything else is a free-form task. Shared by runStart's routing and the
// CLI's bare-invocation guard (route.ts).
export const isLinearToken = (token: string): boolean =>
  isIssueId(token) || /^https?:\/\/linear\.app\//iu.test(token);

// The blockers still standing between this issue and work starting on it.
// Fail-safe like the rest of captain: an absent, empty, or unfetchable relation
// set reads as unblocked, so a source without a dependency concept and a Linear
// hiccup both launch rather than silently refusing to.
export const openBlockers = (issue: Issue): string[] =>
  (issue.blockedBy ?? [])
    .filter((blocker) => !blocker.done)
    .map((blocker) => blocker.identifier);

export const slugify = (value: string): string => {
  let slug = value.toLowerCase().replaceAll(/['`]/gu, "");
  slug = slug
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  if (slug.length > 60) {
    slug = slug.slice(0, 60);
    const lastDash = slug.lastIndexOf("-");
    if (lastDash !== -1) {
      slug = slug.slice(0, lastDash);
    }
  }
  return slug;
};

export const parseIssueInput = (input: string): ParsedIssue => {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(
    new RegExp(
      `^https?://linear\\.app/[^/]+/issue/(${issueIdPattern})/?(.*)$`,
      "u"
    )
  );

  let rawId = "";
  let slug = "";

  if (urlMatch) {
    rawId = urlMatch[1] ?? "";
    slug = slugify((urlMatch[2] ?? "").split(/[?#]/u)[0] ?? "");
  } else {
    const idMatch = trimmed.match(
      new RegExp(`^(${issueIdPattern})([\\s]+(.*))?$`, "u")
    );
    if (!idMatch) {
      throw new CliError(`could not parse issue ID from: ${input}`);
    }
    rawId = idMatch[1] ?? "";
    slug = slugify(idMatch[3] ?? "");
  }

  const issueId = rawId.toLowerCase();
  return {
    displayId: issueId.toUpperCase(),
    issueId,
    slug,
  };
};
