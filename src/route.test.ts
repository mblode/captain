import { describe, expect, it } from "vitest";

import { withImplicitStart } from "./route";

const argv = (...rest: string[]): string[] => ["node", "captain", ...rest];
// Mirrors what cli.ts derives from the commander registry.
const KNOWN = new Set([
  "start",
  "install",
  "status",
  "gain",
  "audit",
  "approve",
  "reject",
  "help",
]);
const route = (...rest: string[]): string[] =>
  withImplicitStart(argv(...rest), KNOWN);

describe("withImplicitStart", () => {
  it("splices start before a bare Linear id", () => {
    expect(route("tig-123")).toEqual(argv("start", "tig-123"));
  });

  it("splices start before a bare Linear URL", () => {
    const url = "https://linear.app/team/issue/TIG-123/fix-thing";
    expect(route(url)).toEqual(argv("start", url));
  });

  it("splices start before a bare donebear task UUID and URL", () => {
    const uuid = "35a2097c-a5c9-477f-b50c-d39b942567a9";
    expect(route(uuid)).toEqual(argv("start", uuid));
    const url = `https://donebear.com/matthew-blode/task/${uuid}`;
    expect(route(url)).toEqual(argv("start", url));
  });

  it("splices start before a free-form task, preserving following args", () => {
    expect(route("tidy the readme", "--agent", "codex")).toEqual(
      argv("start", "tidy the readme", "--agent", "codex")
    );
  });

  it("splices start before an unquoted multi-word task", () => {
    expect(route("fix", "the", "login", "bug")).toEqual(
      argv("start", "fix", "the", "login", "bug")
    );
  });

  it("leaves a known subcommand untouched", () => {
    for (const cmd of KNOWN) {
      expect(withImplicitStart(argv(cmd), KNOWN)).toEqual(argv(cmd));
    }
  });

  // A one-character typo must not launch an agent (runDispatch writes
  // .captain/rubric.md into the checkout BEFORE launching, which would void an
  // in-flight dispatch's verdict hash). Commander's "unknown command" error is
  // the right outcome; a genuine one-word task is `captain start deploy`.
  it("leaves a single non-Linear word untouched (likely a typo'd subcommand)", () => {
    expect(route("statsu")).toEqual(argv("statsu"));
    expect(route("statsu", "--json")).toEqual(argv("statsu", "--json"));
  });

  it("leaves a leading flag untouched (so --version/--help still work)", () => {
    expect(route("--version")).toEqual(argv("--version"));
    expect(route("--help")).toEqual(argv("--help"));
  });

  it("leaves a bare invocation (no args) untouched so help prints", () => {
    expect(route()).toEqual(argv());
  });
});
