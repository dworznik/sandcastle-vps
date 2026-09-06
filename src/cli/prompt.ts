import { createInterface } from "node:readline/promises";

export interface Choice<T> {
  readonly label: string;
  readonly value: T;
}

export interface Prompter {
  text(question: string, fallback?: string): Promise<string>;
  select<T>(question: string, choices: readonly Choice<T>[]): Promise<T>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  close(): void;
}

/**
 * The wizard's questions. Deliberately plain readline: the answers to these
 * are Target names and paths, and the ones that are secrets are not asked
 * here — credential capture owns its own hidden prompts.
 */
export const createPrompter = (): Prompter => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Lines are buffered as they arrive rather than pulled one question at a
  // time: piped input reaches EOF long before the last question is asked, and
  // a reader that only listens while a question is pending would drop every
  // answer that had already been read. Typed input behaves the same way, one
  // line at a time.
  const pending: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;

  rl.on("line", (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length > 0) waiting.shift()?.(null);
  });

  const ask = async (query: string): Promise<string> => {
    process.stdout.write(query);
    const buffered = pending.shift();
    if (buffered !== undefined) {
      // Echo it: a piped answer never appeared on the terminal by itself, and
      // a transcript with questions and no answers is unreadable.
      if (!process.stdin.isTTY) process.stdout.write(`${buffered}\n`);
      return buffered.trim();
    }
    if (ended) throw new Error("Input ended before the question was answered.");
    const line = await new Promise<string | null>((resolve) => waiting.push(resolve));
    if (line === null) throw new Error("Input ended before the question was answered.");
    return line.trim();
  };

  const text: Prompter["text"] = async (question, fallback) => {
    for (;;) {
      const answer = await ask(fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `);
      if (answer) return answer;
      if (fallback !== undefined) return fallback;
      console.log("  An answer is needed.");
    }
  };

  const select: Prompter["select"] = async <T>(question: string, choices: readonly Choice<T>[]) => {
    console.log(`\n${question}`);
    choices.forEach((choice, index) => console.log(`  ${index + 1}) ${choice.label}`));
    for (;;) {
      const answer = await ask("  > ");
      const choice = choices[Number(answer) - 1];
      if (choice) return choice.value;
      console.log(`  Pick a number between 1 and ${choices.length}.`);
    }
  };

  const confirm: Prompter["confirm"] = async (question, fallback = false) => {
    for (;;) {
      const answer = (await ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
      if (!answer) return fallback;
      if (["y", "yes"].includes(answer)) return true;
      if (["n", "no"].includes(answer)) return false;
    }
  };

  return { text, select, confirm, close: () => rl.close() };
};
