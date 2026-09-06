import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const LIB = join(import.meta.dirname, "vps", "lib");

describe("stamp_agent_identity", () => {
  let home: string;
  let sandcastle: string;

  /** Drive the real script with SANDCASTLE_HOME pointed at a scratch dir. */
  const stamp = async (mode: "seed" | "rotate") =>
    exec(
      "bash",
      ["-c", `source "${LIB}/env-file.sh"; source "${LIB}/agent-identity.sh"; stamp_agent_identity "$1" "$2"`, "_", sandcastle, mode],
      { env: { ...process.env, SANDCASTLE_HOME: home } },
    );

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sandcastle-home-"));
    sandcastle = join(await mkdtemp(join(tmpdir(), "sandcastle-project-")), ".sandcastle");
    await mkdir(sandcastle);
    // What `sandcastle init` + init-project leave behind before identity.
    await writeFile(join(sandcastle, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-x\nGH_TOKEN=\n");
    await writeFile(join(sandcastle, ".gitignore"), ".env\nlogs/\nworktrees/\n");
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(join(sandcastle, ".."), { recursive: true, force: true });
  });

  it("is a no-op with a note when no identity is configured yet", async () => {
    const { stderr } = await stamp("seed");
    expect(stderr).toContain("no agent identity configured yet");
    expect(await readFile(join(sandcastle, ".env"), "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-x\nGH_TOKEN=\n");
  });

  it("stamps the identity lines into the Project's .env", async () => {
    await writeFile(join(home, "agent.env"), "AGENT_GIT_NAME=Sandcastle Agent\nAGENT_GIT_EMAIL=1+me@users.noreply.github.com\nGH_TOKEN=github_pat_abc\n");
    await stamp("seed");
    expect(await readFile(join(sandcastle, ".env"), "utf8")).toBe(
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-x\nGH_TOKEN=github_pat_abc\nAGENT_GIT_NAME=Sandcastle Agent\nAGENT_GIT_EMAIL=1+me@users.noreply.github.com\n",
    );
  });

  it("in seed mode leaves a value the operator set; in rotate mode replaces it", async () => {
    await writeFile(join(sandcastle, ".env"), "GH_TOKEN=github_pat_mine\n");
    await writeFile(join(home, "agent.env"), "GH_TOKEN=github_pat_central\n");
    await stamp("seed");
    expect(await readFile(join(sandcastle, ".env"), "utf8")).toBe("GH_TOKEN=github_pat_mine\n");
    await stamp("rotate");
    expect(await readFile(join(sandcastle, ".env"), "utf8")).toBe("GH_TOKEN=github_pat_central\n");
  });

  it("copies the signing key at mode 600 and gitignores it exactly once", async () => {
    await writeFile(join(home, "agent_signing_key"), "PRIVATE\n");
    await chmod(join(home, "agent_signing_key"), 0o600);
    await stamp("seed");
    await stamp("rotate");
    const key = join(sandcastle, "agent_signing_key");
    expect(await readFile(key, "utf8")).toBe("PRIVATE\n");
    expect((await stat(key)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(sandcastle, ".gitignore"), "utf8")).toBe(".env\nlogs/\nworktrees/\nagent_signing_key\n");
  });
});
