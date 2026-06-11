import { homedir } from "node:os";
import { join } from "node:path";

// Captain's data home: where the log and fleet memory live. CAPTAIN_HOME
// overrides the root (tests point it at a temp dir to stay out of real $HOME).
// Note: the user-facing CONFIG lives under XDG (~/.config/captain), not here —
// see config.ts.
export const captainHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.CAPTAIN_HOME || join(homedir(), ".claude", "captain");
