import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_ENV,
  DEFAULT_DATA_SCOPE,
  DEFAULT_HARNESS,
  DEFAULT_SKILLS,
  loadAgentEnv,
  loadDataScope,
  loadHarnessDefaults,
  loadSkills,
  parseAgentEnv,
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

const stepAt = (step: string): number => DEFAULT_SKILLS.indexOf(step);

describe("DEFAULT_SKILLS order", () => {
  // The pipeline order is a correctness property, not a preference. /tidy
  // reviews and applies its fixes in one pass, so it must land before
  // pr-creator opens the PR; otherwise the PR carries findings, not fixes.
  it("runs /tidy before /pr-creator, and /pr-creator before /pr-babysitter", () => {
    expect(stepAt("/tidy")).toBeGreaterThanOrEqual(0);
    expect(stepAt("/tidy")).toBeLessThan(stepAt("/pr-creator"));
    expect(stepAt("/pr-creator")).toBeLessThan(stepAt("/pr-babysitter"));
  });

  // A step the agent can honestly answer "not applicable" to; unconditional
  // ceremony on a diff with no such surface teaches it to argue exemptions.
  it("expresses the UI steps as conditional prose, not bare skill tokens", () => {
    const prose = DEFAULT_SKILLS.filter((s) => !s.startsWith("/"));
    expect(prose.length).toBeGreaterThan(0);
    for (const step of prose) {
      expect(step.toLowerCase()).toContain("if the diff");
    }
  });
});

describe("loadSkills $defaults expansion", () => {
  it("expands $defaults in place, preserving position", () => {
    const path = writeConfig('{"skills":["/first","$defaults","/last"]}');
    expect(loadSkills({ CAPTAIN_CONFIG: path })).toEqual([
      "/first",
      ...DEFAULT_SKILLS,
      "/last",
    ]);
  });

  it("treats a lone $defaults as the built-in pipeline", () => {
    const path = writeConfig('{"skills":["$defaults"]}');
    expect(loadSkills({ CAPTAIN_CONFIG: path })).toEqual(DEFAULT_SKILLS);
  });

  it("expands $defaults from CAPTAIN_SKILLS too", () => {
    expect(loadSkills({ CAPTAIN_SKILLS: "$defaults,/extra" })).toEqual([
      ...DEFAULT_SKILLS,
      "/extra",
    ]);
  });

  // A typo'd or future token must not reach the brief as a literal step: the
  // agent would read "$defualts" as an instruction to follow.
  it("drops unknown $tokens rather than passing them through", () => {
    expect(loadSkills({ CAPTAIN_SKILLS: "/a,$nope,/b" })).toEqual(["/a", "/b"]);
  });

  it("falls back to defaults when a list expands to nothing", () => {
    expect(loadSkills({ CAPTAIN_SKILLS: "$nope,$alsonope" })).toEqual(
      DEFAULT_SKILLS
    );
  });

  // Without the token, a non-empty list still REPLACES the pipeline — the
  // long-standing behaviour $defaults exists to give users a way out of.
  it("still replaces the pipeline when the token is absent", () => {
    expect(loadSkills({ CAPTAIN_SKILLS: "/only-this" })).toEqual([
      "/only-this",
    ]);
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
    const path = writeConfig('{"skills":["/tidy","/pr-creator"]}');
    expect(loadSkills({ CAPTAIN_CONFIG: path })).toEqual([
      "/tidy",
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

describe("loadHarnessDefaults", () => {
  it("defaults workers to the cheaper tier", () => {
    const env = { CAPTAIN_CONFIG: "/no/such/captain/config.json" };
    expect(loadHarnessDefaults("codex", env)).toEqual(DEFAULT_HARNESS.codex);
    expect(loadHarnessDefaults("codex", env).effort).toBe("medium");
    expect(loadHarnessDefaults("claude", env).model).toBe("default");
  });

  it("reads a harness's model and effort from the config file", () => {
    const path = writeConfig(
      '{"harness":{"codex":{"model":"gpt-5.6-sol","effort":"low"}}}'
    );
    expect(loadHarnessDefaults("codex", { CAPTAIN_CONFIG: path })).toEqual({
      effort: "low",
      model: "gpt-5.6-sol",
    });
    // other harnesses keep their defaults
    expect(loadHarnessDefaults("claude", { CAPTAIN_CONFIG: path })).toEqual(
      DEFAULT_HARNESS.claude
    );
  });

  it("ignores blank or malformed fields", () => {
    const path = writeConfig(
      '{"harness":{"cursor":{"model":"  ","effort":3}}}'
    );
    expect(loadHarnessDefaults("cursor", { CAPTAIN_CONFIG: path })).toEqual(
      DEFAULT_HARNESS.cursor
    );
  });
});

describe("parseAgentEnv", () => {
  it("returns a string map, dropping non-string values and invalid keys", () => {
    expect(
      parseAgentEnv({
        agentEnv: {
          "BAD-KEY": "x",
          COUNT: 3,
          NODE_OPTIONS: "--max-old-space-size=3072",
        },
      })
    ).toEqual({ NODE_OPTIONS: "--max-old-space-size=3072" });
  });

  it("returns null for a missing or non-object agentEnv", () => {
    expect(parseAgentEnv({})).toBeNull();
    expect(parseAgentEnv({ agentEnv: "NODE_OPTIONS=x" })).toBeNull();
    expect(parseAgentEnv(null)).toBeNull();
  });
});

describe("loadAgentEnv", () => {
  it("returns the vitest caps by default", () => {
    expect(loadAgentEnv({ CAPTAIN_CONFIG: "/no/such/config.json" })).toEqual(
      DEFAULT_AGENT_ENV
    );
  });

  it("merges config entries over the defaults", () => {
    const path = writeConfig(
      '{"agentEnv":{"VITEST_MAX_THREADS":"4","NODE_OPTIONS":"--max-old-space-size=3072"}}'
    );
    expect(loadAgentEnv({ CAPTAIN_CONFIG: path })).toEqual({
      NODE_OPTIONS: "--max-old-space-size=3072",
      VITEST_MAX_FORKS: "2",
      VITEST_MAX_THREADS: "4",
    });
  });

  it("drops a default when the config sets it to an empty string", () => {
    const path = writeConfig('{"agentEnv":{"VITEST_MAX_FORKS":""}}');
    expect(loadAgentEnv({ CAPTAIN_CONFIG: path })).toEqual({
      VITEST_MAX_THREADS: "2",
    });
  });

  it("degrades to the defaults on unparseable config", () => {
    const path = writeConfig("not json");
    expect(loadAgentEnv({ CAPTAIN_CONFIG: path })).toEqual(DEFAULT_AGENT_ENV);
  });
});
