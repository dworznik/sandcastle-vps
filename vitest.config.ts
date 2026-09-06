import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The scripts/ suite drives the real bash the VPS runs rather than a
    // reimplementation, so each test costs a process spawn — comfortably over
    // vitest's 5s default on a loaded machine, and flaky just under it.
    testTimeout: 30_000,
  },
});
