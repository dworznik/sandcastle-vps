/**
 * What to put in a message about a failure that came from somewhere else.
 *
 * One definition because every module that wraps a cause needs it, and three
 * copies of the same ternary is how they start disagreeing about whether a
 * non-Error cause is worth printing.
 */
export const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
