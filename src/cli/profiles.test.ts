import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTargets, readTarget, targetsDir, validateTargetName, writeTarget } from "./profiles.js";

describe("target profiles", () => {
  const saved = process.env.XDG_CONFIG_HOME;
  let config: string;

  beforeEach(async () => {
    config = await mkdtemp(join(tmpdir(), "sandcastle-profiles-"));
    process.env.XDG_CONFIG_HOME = config;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  });

  const profile = {
    name: "vps",
    connector: "ssh",
    host: "op@vps.example",
    installDir: "/home/op/.sandcastle-vps",
    workspaceRoot: "/home/op/work",
  } as const;

  it("round trips a profile through the operator's config directory", async () => {
    await writeTarget(profile);
    expect(await readTarget("vps")).toEqual(profile);
    expect(targetsDir()).toBe(join(config, "sandcastle-vps", "targets"));
  });

  it("names the profile by its file, not by a field inside it", async () => {
    await writeTarget(profile);
    const stored = JSON.parse(await readFile(join(targetsDir(), "vps.json"), "utf8"));
    expect(stored).toEqual({
      connector: "ssh",
      host: "op@vps.example",
      installDir: "/home/op/.sandcastle-vps",
      workspaceRoot: "/home/op/work",
    });
  });

  // The profile is not a secret store, and the way to keep it from becoming
  // one is to have nowhere to put a secret.
  it("refuses to write a field that isn't part of a Target profile", async () => {
    await expect(
      writeTarget({ ...profile, token: "sk-ant-secret" } as never),
    ).rejects.toThrow(/token/);
  });

  it("refuses to read a profile that grew a field out of band", async () => {
    await mkdir(targetsDir(), { recursive: true });
    await writeFile(
      join(targetsDir(), "tampered.json"),
      JSON.stringify({ ...profile, name: undefined, token: "sk-ant-secret" }),
    );
    await expect(readTarget("tampered")).rejects.toThrow();
  });

  it("insists on absolute paths, which is what a Target's shell will be given", async () => {
    await expect(writeTarget({ ...profile, installDir: "~/.sandcastle-vps" })).rejects.toThrow();
  });

  it("lists the Targets the operator has, newest last, and nothing else", async () => {
    await writeTarget(profile);
    await writeTarget({ ...profile, name: "orb" });
    await writeFile(join(targetsDir(), "notes.txt"), "not a profile");
    expect(await listTargets()).toEqual(["orb", "vps"]);
  });

  it("has no Targets before the operator makes one", async () => {
    expect(await listTargets()).toEqual([]);
  });

  it("says which Target is missing rather than surfacing a file path error", async () => {
    await expect(readTarget("nope")).rejects.toThrow(/nope/);
  });

  // The name is a filename, so anything that could climb out of the directory
  // is rejected before it is used as one.
  it("rejects a name that isn't a plain slug", () => {
    for (const name of ["", ".", "..", "a/b", "-lead", "Upper", "with space"]) {
      expect(() => validateTargetName(name)).toThrow();
    }
    expect(() => validateTargetName("vps-2")).not.toThrow();
  });
});
