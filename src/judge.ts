import type { SystemOneQuestion } from "./captain/triage";
import { CliError, EXIT } from "./errors";

// The one network edge to a System One judge: TypeSafe's POST /v1/systemone
// (Jev). Opt-in — nothing in captain calls it unless `captain triage` is run,
// and that command needs TYPESAFE_API_KEY. status/approve/reject/gain never
// touch it: the offline read path stays offline.
//
// Like CmuxPort, this is an injectable seam so the tests drive the REAL triage
// command with an in-memory fake (no mocking library). `realJudge(env)` folds
// the env in once at the entrypoint.

export interface JudgePort {
  systemOne(
    state: unknown,
    questions: Record<string, SystemOneQuestion>
  ): Promise<{ model?: string; answers: unknown }>;
}

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
// The flagship alias per docs.typesafe.ai/models (resolves to a pinned version
// server-side; the response echoes the version that answered).
export const DEFAULT_JUDGE_MODEL = "jev-latest";

export const judgeModel = (env: NodeJS.ProcessEnv): string =>
  env.TYPESAFE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;

export const judgeConfigured = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.TYPESAFE_API_KEY?.trim());

const unavailable = (message: string): CliError =>
  new CliError(message, EXIT.JUDGE_UNAVAILABLE, "JUDGE_UNAVAILABLE");

// The default port: one fetch per call. `fetchImpl` is injectable for the wire
// test only — production always uses the global.
export const realJudge = (
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = globalThis.fetch
): JudgePort => ({
  systemOne: async (state, questions) => {
    const key = env.TYPESAFE_API_KEY?.trim();
    if (!key) {
      throw unavailable(
        "TYPESAFE_API_KEY is not set — `captain triage` needs a TypeSafe key (https://typesafe.ai); the driver's read-only reviewer still works without it"
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(
        env.TYPESAFE_ENDPOINT?.trim() || TYPESAFE_ENDPOINT,
        {
          body: JSON.stringify({ model: judgeModel(env), questions, state }),
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        }
      );
    } catch (error) {
      throw unavailable(
        `TypeSafe is not reachable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      const detail = raw.trim();
      throw unavailable(
        `TypeSafe returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw unavailable("TypeSafe returned a non-JSON body");
    }
    const body = (parsed ?? {}) as { model?: unknown; answers?: unknown };
    return {
      answers: body.answers,
      model: typeof body.model === "string" ? body.model : undefined,
    };
  },
});
