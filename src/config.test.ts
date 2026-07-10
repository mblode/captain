import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT,
  DEFAULT_AGENT_ENV,
  DEFAULT_DATA_SCOPE,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_SKILLS,
  loadAgent,
  loadAgentEnv,
  loadDataScope,
  loadEffort,
  loadModel,
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

describe("loadModel precedence", () => {
  it("prefers CAPTAIN_MODEL over the config file", () => {
    const path = writeConfig('{"model":"sonnet"}');
    expect(loadModel({ CAPTAIN_CONFIG: path, CAPTAIN_MODEL: "  opus  " })).toBe(
      "opus"
    );
  });

  it("reads the config file when no env override is set", () => {
    const path = writeConfig('{"model":"claude-opus-4-8[1m]"}');
    expect(loadModel({ CAPTAIN_CONFIG: path })).toBe("claude-opus-4-8[1m]");
  });

  it("falls back to the default on an empty or missing model", () => {
    expect(loadModel({ CAPTAIN_CONFIG: writeConfig('{"model":"  "}') })).toBe(
      DEFAULT_MODEL
    );
    expect(loadModel({ CAPTAIN_CONFIG: "/no/such/captain/config.json" })).toBe(
      DEFAULT_MODEL
    );
  });
});

describe("loadEffort precedence", () => {
  it("prefers CAPTAIN_EFFORT over the config file", () => {
    const path = writeConfig('{"effort":"medium"}');
    expect(
      loadEffort({ CAPTAIN_CONFIG: path, CAPTAIN_EFFORT: "  xhigh  " })
    ).toBe("xhigh");
  });

  it("reads the config file when no env override is set", () => {
    const path = writeConfig('{"effort":"max"}');
    expect(loadEffort({ CAPTAIN_CONFIG: path })).toBe("max");
  });

  it("falls back to the default on an empty or missing effort", () => {
    expect(loadEffort({ CAPTAIN_CONFIG: writeConfig('{"effort":""}') })).toBe(
      DEFAULT_EFFORT
    );
    expect(loadEffort({ CAPTAIN_CONFIG: "/no/such/captain/config.json" })).toBe(
      DEFAULT_EFFORT
    );
  });
});

describe("loadAgent precedence", () => {
  it("prefers CAPTAIN_AGENT over the config file", () => {
    const path = writeConfig('{"agent":"claude"}');
    expect(
      loadAgent({ CAPTAIN_AGENT: "  CODEX  ", CAPTAIN_CONFIG: path })
    ).toBe("codex");
  });

  it("reads the config file when no env override is set", () => {
    const path = writeConfig('{"agent":"codex"}');
    expect(loadAgent({ CAPTAIN_CONFIG: path })).toBe("codex");
  });

  it("degrades an unknown/typo agent to claude", () => {
    const path = writeConfig('{"agent":"cursor"}');
    expect(loadAgent({ CAPTAIN_CONFIG: path })).toBe(DEFAULT_AGENT);
  });

  it("falls back to the default when the file is missing", () => {
    expect(loadAgent({ CAPTAIN_CONFIG: "/no/such/captain/config.json" })).toBe(
      DEFAULT_AGENT
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
