import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  downloadImage,
  extractImageUrls,
  shouldSendLinearAuth,
  worktreeTmpDir,
} from "./images";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

describe("image handling", () => {
  it("extracts markdown images and bare Linear upload URLs", () => {
    expect(
      extractImageUrls(
        "![a](https://example.com/a.png)\nhttps://uploads.linear.app/b.png"
      )
    ).toEqual([
      "https://example.com/a.png",
      "https://uploads.linear.app/b.png",
    ]);
  });

  it("only sends Linear auth to Linear upload URLs", () => {
    expect(shouldSendLinearAuth("https://uploads.linear.app/a.png")).toBe(true);
    expect(shouldSendLinearAuth("https://example.com/a.png")).toBe(false);
    expect(shouldSendLinearAuth("http://uploads.linear.app/a.png")).toBe(false);
  });

  it("downloads external https images without the Linear token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-image-"));
    cleanup.push(dir);
    const seenHeaders: HeadersInit[] = [];

    const ok = await downloadImage(
      "https://example.com/a.png",
      join(dir, "a.png"),
      "lin_secret",
      (_input, init) => {
        seenHeaders.push(init?.headers ?? {});
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      }
    );

    expect(ok).toBe(true);
    expect(seenHeaders).toEqual([{}]);
    await expect(readFile(join(dir, "a.png"))).resolves.toEqual(
      Buffer.from([1, 2, 3])
    );
  });

  it("sends the Linear token to Linear upload URLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-image-"));
    cleanup.push(dir);
    const seenHeaders: HeadersInit[] = [];

    await downloadImage(
      "https://uploads.linear.app/a.png",
      join(dir, "a.png"),
      "lin_secret",
      (_input, init) => {
        seenHeaders.push(init?.headers ?? {});
        return Promise.resolve(new Response(new Uint8Array([1])));
      }
    );

    expect(seenHeaders).toEqual([{ Authorization: "lin_secret" }]);
  });

  it("roots the scratch dir at os.tmpdir(), not a hardcoded /tmp", () => {
    expect(worktreeTmpDir("TST-1")).toBe(
      join(tmpdir(), "linear-worktree", "TST-1")
    );
  });
});
