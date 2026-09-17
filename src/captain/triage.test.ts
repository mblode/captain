import { describe, expect, it } from "vitest";

import {
  DECISIVE,
  DECISIVE_NO,
  ELEVATED_MAX,
  parseAnswers,
  PLAN_CHARS_MAX,
  RISK_LEVELS,
  TRIAGE_QUESTIONS,
  triageCard,
  triageState,
} from "./triage";
import type { SystemOneAnswer, TriageKey } from "./triage";

// A fully clean set of answers — every noul decisive in the safe direction,
// the risk Score concentrated on "low".
const clean = (): Record<TriageKey, SystemOneAnswer> => ({
  inScope: { noul: 0.96, type: "noul" },
  namesFiles: { noul: 0.93, type: "noul" },
  namesOrder: { noul: 0.9, type: "noul" },
  namesTests: { noul: 0.88, type: "noul" },
  risk: {
    confidence: 0.91,
    probabilities: { "0": 0.94, "1": 0.05, "2": 0.01 },
    score: 0.07,
    type: "score",
  },
  silentAssumption: { noul: 0.04, type: "noul" },
});

describe("TRIAGE_QUESTIONS", () => {
  it("asks one question per card dimension, each with full instructions", () => {
    for (const [key, q] of Object.entries(TRIAGE_QUESTIONS)) {
      expect(q.instructions.length, key).toBeGreaterThan(40);
      // state paths are referenced by name so the judge knows what it reads
      expect(q.instructions, key).toMatch(/`plan`|`contract`/u);
    }
  });

  it("the risk Score's levels are the auto-pickup blast-radius tiers, in order", () => {
    const { risk } = TRIAGE_QUESTIONS;
    expect(risk.type).toBe("score");
    if (risk.type === "score") {
      expect(risk.criteria).toHaveLength(RISK_LEVELS.length);
      for (const [i, level] of RISK_LEVELS.entries()) {
        expect(risk.criteria[i].startsWith(`${level}:`)).toBe(true);
      }
      // the tier auto-pickup never dispatches names the same surfaces
      expect(risk.criteria[2]).toMatch(/PII/u);
      expect(risk.criteria[2]).toMatch(/permissions/u);
    }
  });
});

describe("parseAnswers", () => {
  it("keeps well-formed answers of the declared type", () => {
    const parsed = parseAnswers(clean());
    expect(Object.keys(parsed).toSorted()).toEqual(
      Object.keys(TRIAGE_QUESTIONS).toSorted()
    );
  });

  it("drops an answer whose type does not match its question", () => {
    // a noul where a score was asked must not be read as a risk tier
    const parsed = parseAnswers({
      ...clean(),
      risk: { noul: 0.1, type: "noul" },
    });
    expect(parsed.risk).toBeUndefined();
    expect(parsed.inScope).toBeDefined();
  });

  it("drops malformed values instead of coercing them", () => {
    const parsed = parseAnswers({
      inScope: { noul: "0.9", type: "noul" },
      namesFiles: { noul: 1.4, type: "noul" },
      namesOrder: { type: "noul" },
      namesTests: null,
      risk: {
        confidence: 0.9,
        probabilities: { "0": "x" },
        score: 0,
        type: "score",
      },
      silentAssumption: { noul: Number.NaN, type: "noul" },
    });
    expect(parsed).toEqual({});
  });

  it("is empty for garbage", () => {
    expect(parseAnswers(null)).toEqual({});
    expect(parseAnswers("nope")).toEqual({});
    expect(parseAnswers([])).toEqual({});
  });
});

describe("triageCard", () => {
  it("is clean only when every dimension is answered and decisive", () => {
    const card = triageCard(clean(), { truncated: false });
    expect(card.triage).toBe("clean");
    expect(card.flags).toEqual([]);
    expect(card.risk).toMatchObject({ elevated: 0.01, level: "low" });
    expect(card.note).toBe(
      "triage clean: in scope 0.96 · risk low (0.91) · names files, order, tests"
    );
  });

  it("a missing answer can never be clean", () => {
    const { risk: _risk, ...withoutRisk } = clean();
    const card = triageCard(withoutRisk, { truncated: false });
    expect(card.triage).toBe("review");
    expect(card.flags).toEqual(["risk unanswered"]);
    expect(card.risk).toBeUndefined();
  });

  it("no answers at all is review with every dimension unanswered", () => {
    const card = triageCard({}, { truncated: false });
    expect(card.triage).toBe("review");
    expect(card.flags).toEqual([
      "scope unanswered",
      "risk unanswered",
      "files unanswered",
      "work order unanswered",
      "proof tests unanswered",
      "assumptions unanswered",
    ]);
    expect(card.note.startsWith("triage review: ")).toBe(true);
  });

  it("a decisive no on scope reads as drift, an in-between reads as uncertain", () => {
    const drift = triageCard(
      { ...clean(), inScope: { noul: 0.12, type: "noul" } },
      { truncated: false }
    );
    expect(drift.flags).toEqual(["scope drift (0.12)"]);
    const unsure = triageCard(
      { ...clean(), inScope: { noul: 0.55, type: "noul" } },
      { truncated: false }
    );
    expect(unsure.flags).toEqual(["scope uncertain (0.55)"]);
    // the band is exactly (DECISIVE_NO, DECISIVE): both ends are decisive.
    // The lower end is a literal on purpose — `1 - 0.8` is not 0.2 in floating
    // point, and an answer of exactly 0.20 must read as a decisive no.
    const atYes = triageCard(
      { ...clean(), inScope: { noul: DECISIVE, type: "noul" } },
      { truncated: false }
    );
    expect(atYes.triage).toBe("clean");
    const atNo = triageCard(
      { ...clean(), inScope: { noul: DECISIVE_NO, type: "noul" } },
      { truncated: false }
    );
    expect(atNo.flags).toEqual(["scope drift (0.20)"]);
  });

  it("flags elevated blast radius on P(elevated) even when the argmax is moderate", () => {
    const card = triageCard(
      {
        ...clean(),
        risk: {
          confidence: 0.6,
          probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
          score: 1.2,
          type: "score",
        },
      },
      { truncated: false }
    );
    expect(card.risk?.level).toBe("moderate");
    expect(card.flags).toEqual(["elevated blast radius (0.30)"]);
    expect(0.3).toBeGreaterThan(ELEVATED_MAX);
  });

  it("a spread-out risk distribution is uncertain, not the argmax", () => {
    const card = triageCard(
      {
        ...clean(),
        risk: {
          confidence: 0.3,
          probabilities: { "0": 0.45, "1": 0.45, "2": 0.1 },
          score: 0.65,
          type: "score",
        },
      },
      { truncated: false }
    );
    expect(card.flags).toEqual(["risk tier uncertain (confidence 0.30)"]);
  });

  it("names each missing plan-shape element", () => {
    const card = triageCard(
      {
        ...clean(),
        namesFiles: { noul: 0.1, type: "noul" },
        namesOrder: { noul: 0.5, type: "noul" },
        namesTests: { noul: 0.05, type: "noul" },
      },
      { truncated: false }
    );
    expect(card.flags).toEqual([
      "names no files (0.10)",
      "work order uncertain (0.50)",
      "names no proof tests (0.05)",
    ]);
  });

  it("a silent assumption is flagged when likely, uncertain in the band", () => {
    const likely = triageCard(
      { ...clean(), silentAssumption: { noul: 0.85, type: "noul" } },
      { truncated: false }
    );
    expect(likely.flags).toEqual(["resolves an ambiguity silently (0.85)"]);
    const band = triageCard(
      { ...clean(), silentAssumption: { noul: 0.4, type: "noul" } },
      { truncated: false }
    );
    expect(band.flags).toEqual(["assumptions uncertain (0.40)"]);
  });

  it("a truncated plan or a missing contract forces review even on clean answers", () => {
    const cut = triageCard(clean(), { truncated: true });
    expect(cut.triage).toBe("review");
    expect(cut.flags).toEqual([`plan truncated at ${PLAN_CHARS_MAX} chars`]);
    expect(cut.truncated).toBe(true);
    const noContract = triageCard(clean(), {
      contractMissing: true,
      truncated: false,
    });
    expect(noContract.flags[0]).toMatch(/no rubric on disk/u);
  });

  it("keeps the raw probabilities on the card for re-derivation", () => {
    const card = triageCard(clean(), { truncated: false });
    expect(card.inScope).toBe(0.96);
    expect(card.shape).toEqual({ files: 0.93, order: 0.9, tests: 0.88 });
    expect(card.silentAssumption).toBe(0.04);
  });
});

describe("triageState", () => {
  it("passes the contract and plan through as two named fields", () => {
    const { state, truncated } = triageState("the contract", "the plan");
    expect(state).toEqual({ contract: "the contract", plan: "the plan" });
    expect(truncated).toBe(false);
  });

  it("cuts an over-long plan at PLAN_CHARS_MAX and says so", () => {
    const { state, truncated } = triageState(
      "c",
      "x".repeat(PLAN_CHARS_MAX + 5)
    );
    expect(truncated).toBe(true);
    expect(state.plan).toHaveLength(PLAN_CHARS_MAX);
  });
});
