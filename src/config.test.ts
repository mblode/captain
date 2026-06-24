import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DATA_SCOPE,
  DEFAULT_SKILLS,
  loadDataScope,
  loadSkills,
  parseDataScope,
  parseSkills,
} from "./config";

const tmpFiles: string[] = [];

const writeConfig = (contents: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "captain-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  tmpFiles.push(path);
  return path;
};

afterEach(() => {
  tmpFiles.length = 0;
});

describe("parseSkills", () => {
  it("returns a cleaned non-empty string array", () => {
    expect(parseSkills({ skills: [" /a ", "/b", ""] })).toEqual(["/a", "/b"]);
  });

  it("returns null for a missing, non-array, or all-empty skills field", () => {
    expect(parseSkills({})).toBeNull();
    expect(parseSkills({ skills: "/a" })).toBeNull();
    expect(parseSkills({ skills: ["", "  "] })).toBeNull();
    expect(parseSkills(null)).toBeNull();
  });
});

describe("loadSkills precedence", () => {
  it("prefers CAPTAIN_SKILLS over the config file", () => {
    const path = writeConfig('{"skills":["/from-file"]}');
    expect(
      loadSkills({ CAPTAIN_CONFIG: path, CAPTAIN_SKILLS: "/a, /b ,," })
    ).toEqual(["/a", "/b"]);
  });

  it("reads the config file when no env override is set", () => {
    const path = writeConfig('{"skills":["/simplify","/pr-creator"]}');
    expect(loadSkills({ CAPTAIN_CONFIG: path })).toEqual([
      "/simplify",
      "/pr-creator",
    ]);
  });

  it("falls back to defaults on malformed JSON", () => {
    const path = writeConfig("{not json");
    expect(loadSkills({ CAPTAIN_CONFIG: path })).toEqual(DEFAULT_SKILLS);
  });

  it("falls back to defaults on an empty skills array", () => {
    const path = writeConfig('{"skills":[]}');
    expect(loadSkills({ CAPTAIN_CONFIG: path })).toEqual(DEFAULT_SKILLS);
  });

  it("falls back to defaults when the file is missing", () => {
    expect(
      loadSkills({ CAPTAIN_CONFIG: "/no/such/captain/config.json" })
    ).toEqual(DEFAULT_SKILLS);
  });
});

describe("parseDataScope", () => {
  it("returns a trimmed non-empty dataScope string", () => {
    expect(parseDataScope({ dataScope: "  source only  " })).toBe(
      "source only"
    );
  });

  it("returns null for a missing, non-string, or empty dataScope field", () => {
    expect(parseDataScope({})).toBeNull();
    expect(parseDataScope({ dataScope: 42 })).toBeNull();
    expect(parseDataScope({ dataScope: "   " })).toBeNull();
    expect(parseDataScope(null)).toBeNull();
  });
});

describe("loadDataScope precedence", () => {
  it("prefers CAPTAIN_DATA_SCOPE over the config file", () => {
    const path = writeConfig('{"dataScope":"from file"}');
    expect(
      loadDataScope({
        CAPTAIN_CONFIG: path,
        CAPTAIN_DATA_SCOPE: "  from env  ",
      })
    ).toBe("from env");
  });

  it("reads the config file when no env override is set", () => {
    const path = writeConfig('{"dataScope":"repo source and config only"}');
    expect(loadDataScope({ CAPTAIN_CONFIG: path })).toBe(
      "repo source and config only"
    );
  });

  it("falls back to the default on malformed JSON", () => {
    const path = writeConfig("{not json");
    expect(loadDataScope({ CAPTAIN_CONFIG: path })).toBe(DEFAULT_DATA_SCOPE);
  });

  it("falls back to the default on an empty dataScope string", () => {
    const path = writeConfig('{"dataScope":"   "}');
    expect(loadDataScope({ CAPTAIN_CONFIG: path })).toBe(DEFAULT_DATA_SCOPE);
  });

  it("falls back to the default when the file is missing", () => {
    expect(
      loadDataScope({ CAPTAIN_CONFIG: "/no/such/captain/config.json" })
    ).toBe(DEFAULT_DATA_SCOPE);
  });
});
