import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSandbox, SANDBOX_SIGNING_KEY_PATH, SIGNING_KEY_FILE } from "./agent.js";
import type { Project } from "./projects.js";

describe("agentSandbox", () => {
  let dir: string;
  let project: Project;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandcastle-agent-"));
    await mkdir(join(dir, ".sandcastle"));
    project = { name: "app", path: dir, imageName: "sandcastle:app" };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("always configures git from the Project's env, even with no signing key", () => {
    const { mounts, hooks } = agentSandbox(project);
    expect(mounts).toEqual([]);
    const [hook] = hooks.sandbox.onSandboxReady;
    expect(hook?.command).toContain('git config --global user.name "$AGENT_GIT_NAME"');
    expect(hook?.command).toContain("credential.helper '!gh auth git-credential'");
  });

  // sandcastle refuses to start a sandbox whose mount source is missing, so the
  // key is mounted only when the Project has one — and then read-only.
  it("mounts the Project's signing key read-only when it exists", async () => {
    await writeFile(join(dir, ".sandcastle", SIGNING_KEY_FILE), "not-really-a-key\n");
    const { mounts } = agentSandbox(project);
    expect(mounts).toEqual([
      {
        hostPath: join(dir, ".sandcastle", SIGNING_KEY_FILE),
        sandboxPath: SANDBOX_SIGNING_KEY_PATH,
        readonly: true,
      },
    ]);
  });

  it("turns on SSH signing only if the key is present in the sandbox", () => {
    const [hook] = agentSandbox(project).hooks.sandbox.onSandboxReady;
    expect(hook?.command).toContain(`if [ -f ${SANDBOX_SIGNING_KEY_PATH} ]`);
    expect(hook?.command).toContain("gpg.format ssh");
    expect(hook?.command).toContain("commit.gpgsign true");
  });
});
