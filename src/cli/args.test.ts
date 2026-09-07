import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("defaults to the menu with no Target chosen", () => {
    expect(parseArgs([])).toEqual({ target: undefined, help: false });
  });

  it("takes a Target either way round", () => {
    expect(parseArgs(["--target", "vps"]).target).toBe("vps");
    expect(parseArgs(["--target=vps"]).target).toBe("vps");
  });

  it("asks for help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  // A typo that silently became "use the default Target" would be an install
  // pointed at the wrong machine.
  it("refuses what it does not understand", () => {
    expect(() => parseArgs(["--targt", "vps"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--target"])).toThrow(/needs a Target name/);
  });
});
