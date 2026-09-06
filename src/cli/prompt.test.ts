import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createPrompter } from "./prompt.js";

/** A prompter wired to streams a test can drive, the way the CLI wires it to
 *  the terminal. */
const harness = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString()));
  return {
    prompter: createPrompter(input, output),
    answer: (...lines: string[]) => input.write(lines.map((line) => `${line}\n`).join("")),
    end: () => input.end(),
    get shown() {
      return written;
    },
  };
};

describe("createPrompter", () => {
  it("takes an answer typed after the question", async () => {
    const { prompter, answer } = harness();
    const asked = prompter.text("Name");
    answer("vps");
    expect(await asked).toBe("vps");
    prompter.close();
  });

  // Piped input reaches EOF long before the last question is asked. A reader
  // that only listened while a question was pending would drop every answer
  // that had already arrived — which is exactly how this first behaved.
  it("answers questions from input that arrived all at once, and ended", async () => {
    const { prompter, answer, end } = harness();
    answer("vps", "2", "yes");
    end();
    expect(await prompter.text("Name")).toBe("vps");
    expect(await prompter.select("Pick", [{ label: "a", value: "a" }, { label: "b", value: "b" }])).toBe("b");
    expect(await prompter.confirm("Sure?")).toBe(true);
    prompter.close();
  });

  it("falls back when the operator just presses enter", async () => {
    const { prompter, answer } = harness();
    const asked = prompter.text("Where", "/home/op/work");
    answer("");
    expect(await asked).toBe("/home/op/work");
    prompter.close();
  });

  it("re-asks rather than guessing at an answer it cannot read", async () => {
    // Not destructured: `shown` is a getter, and pulling it out would snapshot
    // an empty string before anything was written.
    const cli = harness();
    const asked = cli.prompter.select("Pick", [{ label: "a", value: "a" }]);
    cli.answer("7", "1");
    expect(await asked).toBe("a");
    cli.prompter.close();
    expect(cli.shown).toContain("Pick a number between 1 and 1");
  });

  it("takes a confirmation's default from the shape of the question", async () => {
    const { prompter, answer } = harness();
    const yes = prompter.confirm("Run it?", true);
    answer("");
    expect(await yes).toBe(true);
    const no = prompter.confirm("Run it?");
    answer("");
    expect(await no).toBe(false);
    prompter.close();
  });

  // Input that runs out mid-question would otherwise hang the wizard forever.
  it("gives up when the input ends with a question outstanding", async () => {
    const { prompter, end } = harness();
    const asked = prompter.text("Name");
    end();
    await expect(asked).rejects.toThrow(/Input ended/);
    prompter.close();
  });
});
