import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  buildChecks,
  install,
  missingBundles,
  realDeps,
  renderDoctor,
} from "./doctor";
import type { DoctorDeps } from "./doctor";
import { style } from "./format";

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  cmuxReachable: () => true,
  configuredSkills: ["pr-reviewer", "pr-creator", "pr-babysitter"],
  env: { LINEAR_API_KEY: "k" },
  hasCommand: () => true,
  installBundle: () => true,
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

  it("only probes the installable skills the configured pipeline runs", () => {
    // A custom pipeline that runs only pr-reviewer isn't nagged about the other
    // two — even though they're globally missing.
    const skills = buildChecks(
      deps({ configuredSkills: ["pr-reviewer"], skillInstalled: () => false })
    ).find((c) => c.label === "pipeline skills");
    expect(skills?.detail).toContain("pr-reviewer");
    expect(skills?.detail).not.toContain("pr-creator");
  });

  it("omits the pipeline-skills check when the pipeline runs none", () => {
    // /tidy isn't fetched through the pipeline bundle, so a tidy-only pipeline
    // has no installable skills to probe — the check is dropped, not shown as ok.
    const checks = buildChecks(deps({ configuredSkills: ["tidy"] }));
    expect(checks.map((c) => c.label)).not.toContain("pipeline skills");
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

describe("missingBundles", () => {
  it("names a bundle once per failing skill check, deduped", () => {
    // All three pipeline skills missing → still one mblode/agent-skills bundle.
    const bundles = missingBundles(
      buildChecks(deps({ skillInstalled: () => false }))
    );
    expect(bundles).toContain("mblode/agent-skills");
    expect(bundles).toContain("mblode/captain");
    expect(bundles).toHaveLength(2);
  });

  it("is empty when every skill is present", () => {
    expect(missingBundles(buildChecks(deps()))).toEqual([]);
  });

  it("ignores required gaps it can't install (node/git/cmux)", () => {
    const bundles = missingBundles(
      buildChecks(deps({ cmuxReachable: () => false, hasCommand: () => false }))
    );
    expect(bundles).toEqual([]);
  });
});

describe("install entry", () => {
  it("writes the report and returns the exit code", () => {
    const { out, text } = capture();
    const code = install(out, deps({ hasCommand: () => false }));
    expect(code).toBe(1);
    expect(text()).toContain("Captain setup");
    expect(text()).toContain("required check(s) failed");
  });

  it("installs each missing skill bundle, then re-checks", () => {
    const { out, text } = capture();
    const installed: string[] = [];
    const code = install(
      out,
      deps({
        installBundle: (bundle) => {
          installed.push(bundle);
          return true;
        },
        skillInstalled: () => false,
      })
    );
    expect(installed).toHaveLength(2);
    expect(installed).toContain("mblode/agent-skills");
    expect(installed).toContain("mblode/captain");
    // recommended-only gaps still exit 0; the report renders after the install
    expect(code).toBe(0);
    expect(text()).toContain("Installing fleet skills");
    expect(text()).toContain("Captain setup");
  });

  it("reports each bundle whose install fails", () => {
    const { out, text } = capture();
    install(
      out,
      deps({
        // agent-skills fails, captain succeeds — both are still attempted.
        installBundle: (bundle) => bundle !== "mblode/agent-skills",
        skillInstalled: () => false,
      })
    );
    expect(text()).toContain("failed to install mblode/agent-skills");
    expect(text()).not.toContain("failed to install mblode/captain");
  });

  it("skips the installer when every skill is present", () => {
    const { out, text } = capture();
    let calls = 0;
    install(
      out,
      deps({
        installBundle: () => {
          calls += 1;
          return true;
        },
      })
    );
    expect(calls).toBe(0);
    expect(text()).toContain("skills already installed");
  });
});

describe("realDeps skill detection", () => {
  it("finds a skill in any of the install dirs, off HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "captain-doctor-"));
    mkdirSync(join(home, ".claude", "skills", "captain"), { recursive: true });
    const probe = realDeps({ HOME: home } as NodeJS.ProcessEnv).skillInstalled;
    expect(probe("captain")).toBe(true);
    expect(probe("pr-creator")).toBe(false);
  });
});
