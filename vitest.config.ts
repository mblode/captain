import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The runner suite drives real git (init + worktree add) in tmpdir; under
    // the parallel run those fs/git calls occasionally blow the default 5s
    // ceiling on a loaded machine. Raise it so a slow disk reads as slow, not
    // as a failure.
    testTimeout: 20_000,
  },
});
