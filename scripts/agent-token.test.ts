import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const LIB = join(import.meta.dirname, "vps", "lib", "common.sh");

const TOKEN = "sk-ant-oat01-AbCdEf0123456789_abcdefghijklmnop-qrstuv";

/**
 * Drive the real function the Target runs. stdin comes from a file: it is
 * still not a terminal — the branch under test — and it is closed the moment
 * the command starts, which a pipe from this process would not be.
 */
const readToken = async (stdin: string, env: Record<string, string> = {}): Promise<string> => {
  const file = join(await mkdtemp(join(tmpdir(), "sandcastle-token-")), "stdin");
  await writeFile(file, stdin);
  const { stdout } = await exec(
    "bash",
    ["-c", `source "${LIB}"; read_agent_token < "$1"`, "_", file],
    { env: { ...process.env, ...env }, timeout: 10_000 },
  );
  return stdout.trim();
};

describe("read_agent_token", () => {
  it("takes a token supplied on its own", async () => {
    expect(await readToken(`${TOKEN}\n`)).toBe(TOKEN);
  });

  // `claude setup-token` prints explanatory text around the token. Reading all
  // of stdin and stripping whitespace — which this used to do — concatenated
  // the banner onto the token, and the first sign of it was an authentication
  // failure inside a Run.
  it("finds the token in the noise the CLI prints around it", async () => {
    const noisy = [
      "Create a long-lived authentication token for Claude Code.",
      "",
      `  ${TOKEN}`,
      "",
      "Store this securely — it will not be shown again.",
    ].join("\n");

    expect(await readToken(noisy)).toBe(TOKEN);
  });

  it("prefers the real token to instructions that merely mention one", async () => {
    const withExample = `Paste your sk-ant-oat01-EXAMPLE0000000000000000 here\n${TOKEN}\n`;

    expect(await readToken(withExample)).toBe(TOKEN);
  });

  it("lets the environment win without reading the stream at all", async () => {
    expect(await readToken("noise with no token in it", { CLAUDE_CODE_OAUTH_TOKEN: TOKEN })).toBe(TOKEN);
  });

  it("fails rather than stamping something that cannot work", async () => {
    await expect(readToken("Login failed; no token for you.\n")).rejects.toThrow();
  });
});
