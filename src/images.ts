import { mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FetchLike = typeof fetch;

// The shared scratch dir for a run's prompt file + downloaded screenshots, keyed
// by display id. Rooted at the OS temp dir (honours TMPDIR) rather than a
// hardcoded /tmp so it works wherever the platform puts temp files.
export const worktreeTmpDir = (displayId: string): string =>
  join(tmpdir(), "linear-worktree", displayId);

export const extractImageUrls = (description: string): string[] => {
  const urls = new Set<string>();

  for (const match of description.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)) {
    if (match[1]) {
      urls.add(match[1]);
    }
  }

  for (const match of description.matchAll(
    /https:\/\/uploads\.linear\.app\/[^\s)]+/gu
  )) {
    if (match[0]) {
      urls.add(match[0]);
    }
  }

  return [...urls];
};

export const shouldSendLinearAuth = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" && parsed.hostname === "uploads.linear.app"
    );
  } catch {
    return false;
  }
};

const parseHttpsUrl = (value: string): URL | undefined => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const fetchWithRedirectPolicy = async (
  url: URL,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<Response | undefined> => {
  let current = url;

  for (let redirects = 0; redirects < 6; redirects += 1) {
    const response = await fetchImpl(current, {
      headers: shouldSendLinearAuth(current.toString())
        ? { Authorization: apiKey }
        : undefined,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return undefined;
      }
      const next = parseHttpsUrl(new URL(location, current).toString());
      if (!next) {
        return undefined;
      }
      current = next;
      continue;
    }

    return response;
  }

  return undefined;
};

export const downloadImage = async (
  url: string,
  outputPath: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<boolean> => {
  const parsed = parseHttpsUrl(url);
  if (!parsed) {
    return false;
  }

  const response = await fetchWithRedirectPolicy(parsed, apiKey, fetchImpl);
  if (!response?.ok) {
    return false;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    return false;
  }

  await writeFile(outputPath, buffer);
  const file = await stat(outputPath);
  return file.size > 0;
};

export const downloadIssueImages = async (
  description: string,
  displayId: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch
): Promise<string[]> => {
  const urls = extractImageUrls(description);
  if (urls.length === 0) {
    return [];
  }

  const imageDir = worktreeTmpDir(displayId);
  await mkdir(imageDir, { recursive: true });

  const results = await Promise.all(
    urls.map(async (url, index) => {
      const outputPath = join(imageDir, `img-${index + 1}.png`);
      return (await downloadImage(url, outputPath, apiKey, fetchImpl))
        ? outputPath
        : undefined;
    })
  );

  return results.filter((path): path is string => path !== undefined);
};
