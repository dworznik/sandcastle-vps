import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProject } from "./projects.js";

describe("resolveProject", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "sandcastle-vps-test-"));
    await mkdir(join(workspaceRoot, "my-app", ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, "not-a-repo"), { recursive: true });
    await mkdir(join(workspaceRoot, "custom-image", ".git"), { recursive: true });
    await mkdir(join(workspaceRoot, "custom-image", ".sandcastle"), { recursive: true });
    await mkdir(join(workspaceRoot, "custom-image", ".sandcastle", "Dockerfile"), {
      recursive: true,
    });
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("resolves a git checkout by directory name", async () => {
    const project = await resolveProject(workspaceRoot, "my-app");
    expect(project).toEqual({
      name: "my-app",
      path: join(workspaceRoot, "my-app"),
      hasOwnSandboxImage: false,
    });
  });

  it("detects a project-owned sandbox image", async () => {
    const project = await resolveProject(workspaceRoot, "custom-image");
    expect(project.hasOwnSandboxImage).toBe(true);
  });

  it("rejects directories that are not git checkouts", async () => {
    await expect(resolveProject(workspaceRoot, "not-a-repo")).rejects.toThrow(
      /not a git checkout/,
    );
  });

  it("rejects names that traverse out of the workspace root", async () => {
    for (const name of ["../etc", "a/b", "..", ".", "/abs"]) {
      await expect(resolveProject(workspaceRoot, name)).rejects.toThrow(
        /Invalid project name/,
      );
    }
  });
});
