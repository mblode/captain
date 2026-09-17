// 100% PURE (lint-enforced: no fs/subprocess/network) — the plan-gate triage.
//
// A System One judge (TypeSafe's Jev — a model that returns calibrated
// probabilities over answers the caller defines, never prose) reads the issue
// contract next to the plan an agent presented at its gate and answers a fixed
// set of narrow questions. This module owns both halves that are captain's:
// the QUESTIONS (so the standard is set once, not improvised per driver) and
// the CARD derived from the answers (so the thresholds live in code where they
// are testable, not in a prompt). The HTTP call lives in ../judge.ts; the
// command that reads the rubric and prints the card lives in commands.ts.
//
// This is a TRIAGE, not a decision. It sorts plans into "clean" (nothing a
// System One judge could see is off, and it is confident about that) and
// "review" (something is off, or it is unsure, or an answer is missing). The
// human still approves every plan; the driver's deep reviewer now reads only
// what lands in "review". A missing or malformed answer can never produce
// "clean" — the same fail-safe rule as parseVerdict.

// The wire shapes of TypeSafe's POST /v1/systemone, as documented Sept 2026
// (docs.typesafe.ai/api, /primitives/{noul,choice,score}). Pinned by a wire
// test in ../judge.test.ts — re-verify there when the API changes.
export type SystemOneQuestion =
  | {
      type: "noul";
      instructions: string;
      criteria?: { true: string; false: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend?: Record<string, string>;
      probabilities: Record<string, number>;
    };

// The state every question is asked over. Two named fields, per the TypeSafe
// guidance for context with several parts: the contract is the rubric's issue
// context + acceptance criteria exactly as the verifier will see them; the plan
// is the text the agent presented at its gate (captured by the driver — the
// cmux exitPlan feed item carries no plan body, so captain cannot read it).
export interface TriageState {
  contract: string;
  plan: string;
}

// Plans longer than this are cut before they reach the judge, and the card says
// so. Well above the driver's own 6,000-char reviewer bound; a plan this long
// is itself a reason for a human read, which the `truncated` flag forces.
export const PLAN_CHARS_MAX = 32_000;

// The blast-radius vocabulary the auto-pickup contract already uses
// (skills/captain/references/auto-pickup.md): low is the only tier that
// auto-dispatches; elevated names money/tax/PII/auth/permissions.
export const RISK_LEVELS = ["low", "moderate", "elevated"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type TriageKey =
  | "inScope"
  | "risk"
  | "namesFiles"
  | "namesOrder"
  | "namesTests"
  | "silentAssumption";

// One narrow judgment per question, all over the same state, asked together so
// they run in parallel (they cannot see one another). Instructions carry the
// full meaning — question ids are for code and are not sent to the model.
export const TRIAGE_QUESTIONS: Record<TriageKey, SystemOneQuestion> = {
  inScope: {
    criteria: {
      false:
        "`plan` adds work `contract` does not ask for (extra features, unrelated refactors, new dependencies the contract never implies), or leaves out an acceptance criterion the contract lists.",
      true: "Every piece of work in `plan` traces to something `contract` asks for, and every acceptance criterion in `contract` has a step in `plan` that would satisfy it.",
    },
    instructions:
      "`contract` is an issue's definition of done: its description and numbered acceptance criteria. `plan` is the implementation plan an agent proposes for it. Does `plan` stay within what `contract` asks for — no added scope, nothing required left out?",
    type: "noul",
  },
  namesFiles: {
    criteria: {
      false:
        "`plan` describes the change only in terms of features, areas, or components, with no concrete file paths or module names.",
      true: "`plan` names the specific files or modules it will create or edit.",
    },
    instructions:
      "Does `plan` name the specific files or modules it will change? Speaking only of features or areas does not count.",
    type: "noul",
  },
  namesOrder: {
    criteria: {
      false:
        "`plan` is a flat list of changes, or a single paragraph, with no stated sequence.",
      true: "`plan` states the order the work will be done in — numbered steps or an explicit first/then/finally sequence.",
    },
    instructions:
      "Does `plan` state the order in which the work will be done — a numbered sequence or an explicit first/then/finally?",
    type: "noul",
  },
  namesTests: {
    criteria: {
      false:
        "`plan` promises to 'add tests' or 'verify' in general terms, or says nothing about proof, or says tests are not needed without naming what evidence replaces them.",
      true: "`plan` names the specific tests, test files, or checks that will prove the change works (a named test case, a test file, a command with its expected outcome).",
    },
    instructions:
      "Does `plan` name the specific tests or checks that will prove the change works? A bare promise to 'add tests' does not count.",
    type: "noul",
  },
  risk: {
    criteria: [
      "low: copy, labels, docs, configuration, an isolated refactor, or a self-contained change with no new behaviour that others depend on; fully reversible by reverting the PR.",
      "moderate: new behaviour, a new API surface, a schema or data-shape change, or edits across several areas of one codebase; reversible by a revert but with follow-on effects to check.",
      "elevated: touches money, tax, billing, payments, PII or customer data, authentication, authorization or permissions, data deletion, production configuration, or irreversible migrations.",
    ],
    instructions:
      "Judge the blast radius of the change `plan` describes, given what `contract` asks for: how much could go wrong for users or data if the implementation had a bug, and how hard it would be to undo.",
    type: "score",
  },
  silentAssumption: {
    criteria: {
      false:
        "`plan` either flags each ambiguity it resolves (states the assumption, or lists it as a question for the reviewer), or `contract` leaves no such ambiguity.",
      true: "`plan` picks one reading of something `contract` leaves ambiguous — a behaviour, a scope boundary, a default — and proceeds on it without naming that a choice was made.",
    },
    instructions:
      "Does `plan` resolve an ambiguity in `contract` by silently assuming one reading, rather than naming the assumption or asking about it?",
    type: "noul",
  },
};

// A noul at or above DECISIVE reads as yes, at or below DECISIVE_NO as no;
// anything between is uncertain and sends the plan to review. The judge's own
// docs describe a noul near 0.5 as "similar probability for yes and no" — so
// the band is where the model is telling us it does not know. Two literals
// rather than `1 - DECISIVE`: that expression is 0.19999999999999996, which
// would push an answer of exactly 0.20 into the wrong band.
export const DECISIVE = 0.8;
export const DECISIVE_NO = 0.2;
// P(elevated) above this flags the plan whatever the argmax level says: an
// elevated-blast-radius plan that was merely likely-moderate still gets a
// human read, because that is the tier auto-pickup never dispatches.
export const ELEVATED_MAX = 0.2;
// Below this Score confidence the risk tier is spread over several levels —
// treat it as unknown rather than pick the argmax.
export const RISK_CONFIDENCE_MIN = 0.5;

const isProbability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;

const isProbabilities = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(isProbability);

const parseAnswer = (raw: unknown): SystemOneAnswer | null => {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const a = raw as Record<string, unknown>;
  if (a.type === "noul" && isProbability(a.noul)) {
    return { noul: a.noul, type: "noul" };
  }
  if (
    a.type === "choice" &&
    typeof a.choice === "string" &&
    isProbability(a.confidence) &&
    isProbabilities(a.probabilities)
  ) {
    return {
      choice: a.choice,
      confidence: a.confidence,
      probabilities: a.probabilities,
      type: "choice",
    };
  }
  if (
    a.type === "score" &&
    typeof a.score === "number" &&
    Number.isFinite(a.score) &&
    isProbability(a.confidence) &&
    isProbabilities(a.probabilities)
  ) {
    return {
      confidence: a.confidence,
      probabilities: a.probabilities,
      score: a.score,
      type: "score",
    };
  }
  return null;
};

// Fail-safe parse of a systemone response's `answers` map: anything whose shape
// does not match its declared type is dropped, never coerced. A dropped answer
// surfaces on the card as "unanswered" and forces review.
export const parseAnswers = (
  raw: unknown
): Partial<Record<TriageKey, SystemOneAnswer>> => {
  const out: Partial<Record<TriageKey, SystemOneAnswer>> = {};
  if (typeof raw !== "object" || raw === null) {
    return out;
  }
  for (const key of Object.keys(TRIAGE_QUESTIONS) as TriageKey[]) {
    const answer = parseAnswer((raw as Record<string, unknown>)[key]);
    if (answer && answer.type === TRIAGE_QUESTIONS[key].type) {
      out[key] = answer;
    }
  }
  return out;
};

// The card the driver reads. Raw probabilities ride along untouched so a
// driver (or a later threshold change) can re-derive without re-asking; the
// `note` is a one-line mechanical rendering fit for `captain approve --note`.
export interface TriageCard {
  triage: "clean" | "review";
  // why it is "review", in the order the questions are asked; empty on clean
  flags: string[];
  // P(the plan stays within the contract); absent when unanswered
  inScope?: number;
  risk?: {
    level: RiskLevel;
    // probability-weighted position, 0 (low) … 2 (elevated)
    score: number;
    confidence: number;
    // P(elevated) on its own, the number ELEVATED_MAX gates
    elevated: number;
  };
  // P(the plan names files / work order / proof tests)
  shape: { files?: number; order?: number; tests?: number };
  // P(the plan resolves a contract ambiguity without saying so)
  silentAssumption?: number;
  // the plan was cut at PLAN_CHARS_MAX before the judge saw it
  truncated: boolean;
  note: string;
}

const noulOf = (
  answers: Partial<Record<TriageKey, SystemOneAnswer>>,
  key: TriageKey
): number | undefined => {
  const a = answers[key];
  return a?.type === "noul" ? a.noul : undefined;
};

const pct = (p: number): string => p.toFixed(2);

// Judge a yes-expected noul: undefined → unanswered, decisive yes → ok,
// decisive no → the named flag, in between → uncertain. Returns the flag to
// record, or null when the dimension is clean.
const expectYes = (
  p: number | undefined,
  what: string,
  missing: string
): string | null => {
  if (p === undefined) {
    return `${what} unanswered`;
  }
  if (p >= DECISIVE) {
    return null;
  }
  if (p <= DECISIVE_NO) {
    return `${missing} (${pct(p)})`;
  }
  return `${what} uncertain (${pct(p)})`;
};

const riskOf = (
  answers: Partial<Record<TriageKey, SystemOneAnswer>>
): TriageCard["risk"] | undefined => {
  const a = answers.risk;
  if (a?.type !== "score") {
    return undefined;
  }
  let level: RiskLevel = "low";
  let best = -1;
  for (const [i, name] of RISK_LEVELS.entries()) {
    const p = a.probabilities[String(i)] ?? 0;
    if (p > best) {
      best = p;
      level = name;
    }
  }
  return {
    confidence: a.confidence,
    elevated: a.probabilities[String(RISK_LEVELS.indexOf("elevated"))] ?? 0,
    level,
    score: a.score,
  };
};

// PURE: answers → card. Clean requires EVERY dimension answered and decisive
// in the safe direction; anything else is review, with the reasons listed.
export const triageCard = (
  answers: Partial<Record<TriageKey, SystemOneAnswer>>,
  context: { truncated: boolean; contractMissing?: boolean }
): TriageCard => {
  const flags: string[] = [];
  if (context.contractMissing) {
    flags.push("no rubric on disk — judged against an empty contract");
  }
  if (context.truncated) {
    flags.push(`plan truncated at ${PLAN_CHARS_MAX} chars`);
  }

  const inScope = noulOf(answers, "inScope");
  const scopeFlag = expectYes(inScope, "scope", "scope drift");
  if (scopeFlag) {
    flags.push(scopeFlag);
  }

  const risk = riskOf(answers);
  if (!risk) {
    flags.push("risk unanswered");
  } else if (risk.elevated > ELEVATED_MAX) {
    flags.push(`elevated blast radius (${pct(risk.elevated)})`);
  } else if (risk.confidence < RISK_CONFIDENCE_MIN) {
    flags.push(`risk tier uncertain (confidence ${pct(risk.confidence)})`);
  }

  const shape = {
    files: noulOf(answers, "namesFiles"),
    order: noulOf(answers, "namesOrder"),
    tests: noulOf(answers, "namesTests"),
  };
  for (const [what, p, missing] of [
    ["files", shape.files, "names no files"],
    ["work order", shape.order, "states no work order"],
    ["proof tests", shape.tests, "names no proof tests"],
  ] as const) {
    const flag = expectYes(p, what, missing);
    if (flag) {
      flags.push(flag);
    }
  }

  const silentAssumption = noulOf(answers, "silentAssumption");
  if (silentAssumption === undefined) {
    flags.push("assumptions unanswered");
  } else if (silentAssumption >= DECISIVE) {
    flags.push(`resolves an ambiguity silently (${pct(silentAssumption)})`);
  } else if (silentAssumption > DECISIVE_NO) {
    flags.push(`assumptions uncertain (${pct(silentAssumption)})`);
  }

  const triage = flags.length === 0 ? "clean" : "review";
  const note =
    triage === "clean"
      ? `triage clean: in scope ${pct(inScope ?? 0)} · risk ${risk?.level ?? "?"} (${pct(risk?.confidence ?? 0)}) · names files, order, tests`
      : `triage review: ${flags.join("; ")}`;
  return {
    flags,
    inScope,
    note,
    risk,
    shape,
    silentAssumption,
    triage,
    truncated: context.truncated,
  };
};

// PURE: build the state the judge is asked over, cutting an over-long plan.
export const triageState = (
  contract: string,
  plan: string
): { state: TriageState; truncated: boolean } => {
  const truncated = plan.length > PLAN_CHARS_MAX;
  return {
    state: {
      contract,
      plan: truncated ? plan.slice(0, PLAN_CHARS_MAX) : plan,
    },
    truncated,
  };
};
