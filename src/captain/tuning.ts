import { ADVANCING_STAGES } from "./metrics";
import type { FleetMetrics, PipelineTuning, Stage } from "./types";

// A reliable stage gets this many retry attempts before escalating to a human.
const BASE_BUDGET = 4;
const MIN_BUDGET = 1;
// Don't tune a stage until we've seen enough advance attempts to trust the rate.
const MIN_SAMPLES = 3;

// Pure: turn observed reliability into a driving policy. Only stages that have
// actually bounced get a finite (and shrinking) retry budget — everything else is
// left uncapped, so an empty/young log reproduces today's behaviour exactly.
export const deriveTuning = (m: FleetMetrics): PipelineTuning => {
  const maxRetries: Partial<Record<Stage, number>> = {};
  for (const stage of ADVANCING_STAGES) {
    const sm = m.stages[stage];
    if (!sm) {
      continue;
    }
    const attempts = sm.advances + sm.reworks;
    if (attempts < MIN_SAMPLES || sm.reworks === 0) {
      continue;
    }
    const bounceRate = sm.reworks / attempts;
    maxRetries[stage] = Math.max(
      MIN_BUDGET,
      Math.round(BASE_BUDGET * (1 - bounceRate))
    );
  }
  return { maxRetries };
};
