import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { buildChecks, doctor, renderDoctor } from "./doctor";
import type { DoctorDeps } from "./doctor";
import { style } from "./format";

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  cmuxReachable: () => true,
  env: { LINEAR_API_KEY: "k" },
  hasCommand: () => true,
  nodeMajor: 22,
  nodeVersion: "v22.0.0",
  skillInstalled: () => true,
  ...over,
});

const plain = style(false);

const capture = (): { out: PassThrough; text: () => string } => {
  const out = new PassThrough();
  let buf = "";
  out.on("data", (c: Buffer) => {
    buf += c.toString();
  });
  return { out, text: () => buf };
};

describe("buildChecks", () => {
  it("a fully provisioned environment passes every check", () => {
    const checks = buildChecks(deps());
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.label)).toContain("cmux");
    expect(checks.map((c) => c.label)).toContain("pipeline skills");
  });

  it("old Node fails the required Node check", () => {
    const node = buildChecks(deps({ nodeMajor: 20 })).find(
      (c) => c.label === "Node >= 22"
    );
    expect(node?.ok).toBe(false);
    expect(node?.level).toBe("required");
  });

  it("unreachable cmux is a required failure with a hint", () => {
    const cmux = buildChecks(deps({ cmuxReachable: () => false })).find(
      (c) => c.label === "cmux"
    );
    expect(cmux).toMatchObject({ level: "required", ok: false });
    expect(cmux?.hint).toContain("cmux.com");
  });

  it("a missing LINEAR_API_KEY is only recommended", () => {
    const key = buildChecks(deps({ env: {} })).find(
      (c) => c.label === "LINEAR_API_KEY"
    );
    expect(key).toMatchObject({ level: "recommended", ok: false });
  });

  it("names the specific pipeline skills that are missing", () => {
    const skills = buildChecks(
      deps({ skillInstalled: (s) => s !== "pr-creator" })
    ).find((c) => c.label === "pipeline skills");
    expect(skills?.ok).toBe(false);
    expect(skills?.detail).toContain("pr-creator");
  });
});

describe("renderDoctor", () => {
  it("exits 1 when a required check fails, 0 otherwise", () => {
    expect(renderDoctor(buildChecks(deps()), plain).exitCode).toBe(0);
    expect(
      renderDoctor(buildChecks(deps({ hasCommand: () => false })), plain)
        .exitCode
    ).toBe(1);
  });

  it("recommended-only gaps still exit 0 with a soft warning", () => {
    const { exitCode, text } = renderDoctor(
      buildChecks(deps({ env: {} })),
      plain
    );
    expect(exitCode).toBe(0);
    expect(text).toContain("optional gaps");
  });

  it("a clean run says all set", () => {
    expect(renderDoctor(buildChecks(deps()), plain).text).toContain("all set");
  });
});

describe("doctor entry", () => {
  it("writes the report and returns the exit code", () => {
    const { out, text } = capture();
    const code = doctor(out, deps({ cmuxReachable: () => false }));
    expect(code).toBe(1);
    expect(text()).toContain("Captain doctor");
    expect(text()).toContain("cmux");
  });
});
