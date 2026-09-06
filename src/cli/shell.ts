/**
 * Quote a value so a POSIX shell reads it as exactly one word, whatever is in
 * it. Single quotes protect everything except a single quote, which is closed,
 * escaped, and reopened — the one form that also survives zsh and fish, which
 * an operator's login shell on a Target may well be.
 */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
