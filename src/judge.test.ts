import { describe, expect, it } from "vitest";

import { TRIAGE_QUESTIONS } from "./captain/triage";
import { CliError, EXIT } from "./errors";
import {
  DEFAULT_JUDGE_MODEL,
  judgeConfigured,
  judgeModel,
  realJudge,
  TYPESAFE_ENDPOINT,
} from "./judge";

// A fetch fake that records the one request and returns a canned response.
const fakeFetch = (
  reply: { status?: number; body?: unknown; text?: string } = {}
): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ init: init ?? {}, url: String(url) });
    const status = reply.status ?? 200;
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return Promise.resolve(
      new Response(text, {
        headers: { "Content-Type": "application/json" },
        status,
      })
    );
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
};

describe("realJudge — the TypeSafe wire", () => {
  // WIRE TEST: pins POST /v1/systemone's request shape as documented Sept 2026
  // (docs.typesafe.ai/api): bearer auth, {model, questions, state}. Re-verify
  // here when the API changes — the triage command trusts this shape.
  it("posts {model, questions, state} with a bearer key to the systemone endpoint", async () => {
    const { fetch: f, calls } = fakeFetch({
      body: {
        answers: { inScope: { noul: 0.9, type: "noul" } },
        model: "jev-1.13.0",
      },
    });
    const judge = realJudge({ TYPESAFE_API_KEY: "sk-test" }, f);
    const result = await judge.systemOne(
      { contract: "c", plan: "p" },
      TRIAGE_QUESTIONS
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TYPESAFE_ENDPOINT);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(calls[0].init.body)) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe(DEFAULT_JUDGE_MODEL);
    expect(body.state).toEqual({ contract: "c", plan: "p" });
    expect(body.questions).toEqual(TRIAGE_QUESTIONS);
    // every question carries only the documented fields
    for (const q of Object.values(body.questions as Record<string, object>)) {
      expect(Object.keys(q).toSorted()).toEqual(
        ["criteria", "instructions", "type"].filter((k) => k in q)
      );
    }
    expect(result.model).toBe("jev-1.13.0");
    expect(result.answers).toEqual({ inScope: { noul: 0.9, type: "noul" } });
  });

  it("refuses without a key, before any network call", async () => {
    const { fetch: f, calls } = fakeFetch();
    const judge = realJudge({}, f);
    await expect(judge.systemOne({}, TRIAGE_QUESTIONS)).rejects.toMatchObject({
      errorType: "JUDGE_UNAVAILABLE",
      exitCode: EXIT.JUDGE_UNAVAILABLE,
    });
    expect(calls).toHaveLength(0);
  });

  it("honours TYPESAFE_MODEL and TYPESAFE_ENDPOINT overrides", async () => {
    const { fetch: f, calls } = fakeFetch({ body: { answers: {} } });
    const judge = realJudge(
      {
        TYPESAFE_API_KEY: "k",
        TYPESAFE_ENDPOINT: "https://example.test/v1/systemone",
        TYPESAFE_MODEL: "jev-preview",
      },
      f
    );
    await judge.systemOne({}, TRIAGE_QUESTIONS);
    expect(calls[0].url).toBe("https://example.test/v1/systemone");
    expect(JSON.parse(String(calls[0].init.body)).model).toBe("jev-preview");
  });

  it("an HTTP error is a JUDGE_UNAVAILABLE CliError carrying the status", async () => {
    const { fetch: f } = fakeFetch({ status: 401, text: "bad key" });
    const judge = realJudge({ TYPESAFE_API_KEY: "k" }, f);
    const error = await judge
      .systemOne({}, TRIAGE_QUESTIONS)
      .catch((error_) => error_);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/HTTP 401: bad key/u);
    expect((error as CliError).exitCode).toBe(EXIT.JUDGE_UNAVAILABLE);
  });

  it("a non-JSON body is an error, never a silent empty answer set", async () => {
    const { fetch: f } = fakeFetch({ text: "<html>gateway</html>" });
    const judge = realJudge({ TYPESAFE_API_KEY: "k" }, f);
    await expect(judge.systemOne({}, TRIAGE_QUESTIONS)).rejects.toMatchObject({
      errorType: "JUDGE_UNAVAILABLE",
    });
  });

  it("a thrown fetch (network down) is a JUDGE_UNAVAILABLE CliError", async () => {
    const judge = realJudge({ TYPESAFE_API_KEY: "k" }, (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch);
    const error = await judge
      .systemOne({}, TRIAGE_QUESTIONS)
      .catch((error_) => error_);
    expect((error as CliError).message).toMatch(/not reachable: ECONNREFUSED/u);
  });
});

describe("judge config", () => {
  it("is configured only by a non-blank key", () => {
    expect(judgeConfigured({})).toBe(false);
    expect(judgeConfigured({ TYPESAFE_API_KEY: "  " })).toBe(false);
    expect(judgeConfigured({ TYPESAFE_API_KEY: "k" })).toBe(true);
  });

  it("defaults the model to the flagship alias", () => {
    expect(judgeModel({})).toBe("jev-latest");
    expect(judgeModel({ TYPESAFE_MODEL: " jev-1.13.0 " })).toBe("jev-1.13.0");
  });
});
