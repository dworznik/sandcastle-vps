import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The Harness reads its settings once, at import, and exits if they are
    // incomplete — so importing anything that reaches env.ts needs a workspace
    // root here. It is never touched: every test that cares injects its own.
    env: {
      WORKSPACE_ROOT: '/workspace-root-for-tests',
    },
    // The scripts/ suite drives the real bash the VPS runs rather than a
    // reimplementation, so each test costs a process spawn — comfortably over
    // vitest's 5s default on a loaded machine, and flaky just under it.
    testTimeout: 30_000,
  },
})
