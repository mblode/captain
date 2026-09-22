import { describe, expect, it } from "vitest";

import { sourceFor } from "./source";

const UUID = "35a2097c-a5c9-477f-b50c-d39b942567a9";

describe("sourceFor", () => {
  it("routes a Linear id/URL to the Linear source", () => {
    expect(sourceFor("TIG-430")?.name).toBe("Linear");
    expect(sourceFor("https://linear.app/team/issue/TIG-430/x")?.name).toBe(
      "Linear"
    );
  });

  it("routes a donebear task URL/UUID to the donebear source", () => {
    expect(sourceFor(UUID)?.name).toBe("donebear");
    expect(
      sourceFor(`https://donebear.com/matthew-blode/task/${UUID}`)?.name
    ).toBe("donebear");
  });

  it("claims nothing for a free-form task token", () => {
    expect(sourceFor("tidy the readme")).toBeUndefined();
    expect(sourceFor("deploy")).toBeUndefined();
  });

  it("prepare() parses the token and binds the matching fetch", () => {
    const { parsed } = sourceFor(UUID)?.prepare(UUID) ?? {};
    expect(parsed?.displayId).toBe("db-35a2097c");
  });
});
