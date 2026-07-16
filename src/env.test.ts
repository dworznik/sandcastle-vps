import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "./env.js";

describe("env", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.HOST;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  describe("host", () => {
    // The harness runs as a plain process on the VPS host, so an all-interfaces
    // bind would put the keyless dispatch surface on the public internet.
    it("binds loopback by default", () => {
      expect(env.host).toBe("127.0.0.1");
    });

    it("can be overridden deliberately", () => {
      process.env.HOST = "0.0.0.0";
      expect(env.host).toBe("0.0.0.0");
    });
  });

  describe("port", () => {
    it("defaults to 3000", () => {
      expect(env.port).toBe(3000);
    });

    it("reads PORT", () => {
      process.env.PORT = "3399";
      expect(env.port).toBe(3399);
    });
  });
});
