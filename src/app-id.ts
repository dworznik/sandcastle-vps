/**
 * What the Harness calls itself to the Orchestrator.
 *
 * Its own module so the creator CLI can check that the two have found each
 * other without importing the Inngest client — which the CLI has no use for,
 * and which would build one in every `npx` invocation.
 */
export const APP_ID = 'sandcastle-vps'
