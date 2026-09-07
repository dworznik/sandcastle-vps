import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

/** The one setting with no sensible default. */
const complete = { WORKSPACE_ROOT: "/home/op/work" };

describe("parseEnv", () => {
  it("needs only the workspace root, and fills in the rest", () => {
    expect(parseEnv(complete)).toEqual({
      workspaceRoot: "/home/op/work",
      defaultModel: "claude-opus-4-8",
      host: "127.0.0.1",
      port: 3000,
    });
  });

  // Compose sets 0.0.0.0 explicitly for the container, where exposure is
  // decided by port publishing. Everywhere else — a server run directly in
  // development — the keyless Dispatch surface stays on loopback.
  it("takes the address compose gives the container", () => {
    expect(parseEnv({ ...complete, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("reads the port as a number, not the string it arrives as", () => {
    expect(parseEnv({ ...complete, PORT: "3399" }).port).toBe(3399);
  });

  // `Number(process.env.PORT)` used to turn each of these into 0 or NaN, and a
  // bind to port 0 is a listener on a port nobody is dispatching to.
  it.each(["", "0", "abc", "70000", "3000.5"])("refuses PORT=%o rather than binding something else", (port) => {
    expect(() => parseEnv({ ...complete, PORT: port })).toThrow(/PORT/);
  });

  it("takes an agent model override, and defends the default from an empty one", () => {
    expect(parseEnv({ ...complete, AGENT_MODEL: "claude-sonnet-5" }).defaultModel).toBe("claude-sonnet-5");
    expect(() => parseEnv({ ...complete, AGENT_MODEL: "" })).toThrow(/AGENT_MODEL/);
  });

  it("names what is missing rather than failing later", () => {
    expect(() => parseEnv({})).toThrow(/WORKSPACE_ROOT/);
  });

  // The path is mounted into the Harness at the same path it has on the
  // Target; a relative one would resolve against whatever cwd happens to be.
  it("insists the workspace root is absolute", () => {
    expect(() => parseEnv({ WORKSPACE_ROOT: "work" })).toThrow(/absolute/);
  });
});
