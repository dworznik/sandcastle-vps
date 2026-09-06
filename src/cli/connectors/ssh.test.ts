import { describe, expect, it } from "vitest";
import { extractCommand, sshArgs } from "./ssh.js";

describe("sshArgs", () => {
  it("addresses the Target and hands the script to bash, not to the login shell", () => {
    expect(sshArgs("op@vps", "echo hi")).toEqual(["op@vps", "bash -c 'echo hi'"]);
  });

  // A Target's login shell may be zsh or fish; the quoting below is the form
  // all three read identically.
  it("survives a script containing quotes", () => {
    expect(sshArgs("op@vps", "echo 'hi'")).toEqual(["op@vps", "bash -c 'echo '\\''hi'\\'''"]);
  });

  it("elevates without ever waiting for a password prompt it cannot answer", () => {
    expect(sshArgs("op@vps", "id -u", { sudo: true })).toEqual([
      "op@vps",
      "bash -c 'sudo -n bash -c '\\''id -u'\\'''",
    ]);
  });

  it("really does run the script under bash on the far end", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    // No ssh here: run the argv the connector would send, minus the hop.
    const [, remote] = sshArgs("ignored", "printf '%s' \"$BASH_VERSION\"");
    const { stdout } = await promisify(execFile)("sh", ["-c", remote as string]);
    expect(stdout).not.toBe("");
  });
});

describe("extractCommand", () => {
  it("creates the destination and unwraps the tarball's single root entry", () => {
    expect(extractCommand("/home/op/.sandcastle-vps")).toBe(
      "mkdir -p '/home/op/.sandcastle-vps' && tar -xzf - -C '/home/op/.sandcastle-vps' --strip-components=1",
    );
  });

  it("quotes a destination a shell would otherwise split", () => {
    expect(extractCommand("/home/op/my dir")).toContain("'/home/op/my dir'");
  });
});
