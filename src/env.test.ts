import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "./env.js";

describe("env", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.HOST;
    delete process.env.PORT;
    delete process.env.DOCKER_BRIDGE_IP;
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

  describe("hosts", () => {
    it("is loopback only when no bridge address is configured", () => {
      expect(env.hosts).toEqual(["127.0.0.1"]);
    });

    // The Orchestrator is a bridged container: it cannot reach host loopback,
    // but it can reach the docker bridge gateway, which nothing off the host
    // can route to.
    it("adds the docker bridge gateway so the Orchestrator can reach the harness", () => {
      process.env.DOCKER_BRIDGE_IP = "172.17.0.1";
      expect(env.hosts).toEqual(["127.0.0.1", "172.17.0.1"]);
    });

    it("treats an empty bridge value as unset", () => {
      process.env.DOCKER_BRIDGE_IP = "";
      expect(env.hosts).toEqual(["127.0.0.1"]);
    });

    it("does not double-bind when the bridge address equals the host", () => {
      process.env.HOST = "172.17.0.1";
      process.env.DOCKER_BRIDGE_IP = "172.17.0.1";
      expect(env.hosts).toEqual(["172.17.0.1"]);
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
