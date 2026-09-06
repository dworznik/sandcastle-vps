import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

const LIB = join(import.meta.dirname, "vps", "lib", "env-file.sh");

/** Drive the real script the VPS runs, rather than a reimplementation of it. */
const upsert = async (
  file: string,
  key: string,
  value: string,
  mode: "seed" | "rotate",
): Promise<void> => {
  await exec("bash", ["-c", `source "${LIB}"; env_file_upsert "$1" "$2" "$3" "$4"`, "_", file, key, value, mode]);
};

describe("env_file_upsert", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandcastle-envfile-"));
    file = join(dir, ".env");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("seed mode", () => {
    it("adds the key when the file does not exist yet", async () => {
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "seed");
      expect(await readFile(file, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\n");
    });

    it("adds the key when the file exists but the key is absent", async () => {
      await writeFile(file, "GH_TOKEN=ghp_existing\n");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "seed");
      expect(await readFile(file, "utf8")).toBe(
        "GH_TOKEN=ghp_existing\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\n",
      );
    });

    it("never overwrites a value the operator already set", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-mine\n");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "seed");
      expect(await readFile(file, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-mine\n");
    });

    it("fills in a key that is present but empty (the scaffolded placeholder)", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=\nGH_TOKEN=\n");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "seed");
      expect(await readFile(file, "utf8")).toBe(
        "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\nGH_TOKEN=\n",
      );
    });

    it("creates the file private to the operator", async () => {
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "seed");
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    });
  });

  describe("when the rewrite fails", () => {
    // Shadow awk after sourcing, so the rewrite fails the way a real awk
    // error would rather than a simulated one.
    const upsertWithBrokenAwk = (): Promise<{ stdout: string }> =>
      exec("bash", [
        "-c",
        `source "${LIB}"; awk() { return 1; }; env_file_upsert "$1" CLAUDE_CODE_OAUTH_TOKEN new rotate`,
        "_",
        file,
      ]);

    it("reports the failure instead of reporting success", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-precious\n");
      await expect(upsertWithBrokenAwk()).rejects.toThrow();
    });

    it("leaves the operator's file intact rather than truncating it", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-precious\n");
      await upsertWithBrokenAwk().catch(() => {});
      expect(await readFile(file, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-precious\n");
    });

    it("leaves no temp file behind holding the token", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-precious\n");
      await upsertWithBrokenAwk().catch(() => {});
      // .gitignore covers `.env`, not `.env.a1B2c3` — a stray temp here gets
      // committed by the documented `git add .sandcastle/`.
      expect(await readdir(dir)).toEqual([".env"]);
    });
  });

  // The deploy wraps this in `ensure_env_key() { env_file_upsert ...; }` and
  // runs under `set -euo pipefail`, which is the shape that catches cleanup
  // leaking out of the function into its caller's scope.
  it("survives being called from a wrapper function under set -euo pipefail", async () => {
    await writeFile(file, "GH_TOKEN=ghp_keepme\n");
    const script = `
      set -euo pipefail
      source "${LIB}"
      ensure_env_key() { env_file_upsert "${file}" "$1" "$2" seed; }
      after() { echo "still running"; }
      ensure_env_key CLAUDE_CODE_OAUTH_TOKEN sk-ant-one
      ensure_env_key OTHER_KEY value-two
      after
    `;
    const { stdout } = await exec("bash", ["-c", script]);
    expect(stdout).toContain("still running");
    expect(await readFile(file, "utf8")).toBe(
      "GH_TOKEN=ghp_keepme\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-one\nOTHER_KEY=value-two\n",
    );
  });

  it("leaves no temp file behind on success", async () => {
    await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "seed");
    expect(await readdir(dir)).toEqual([".env"]);
  });

  describe("rotate mode", () => {
    it("replaces an existing value", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-old\n");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "rotate");
      expect(await readFile(file, "utf8")).toBe("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\n");
    });

    it("touches nothing else in the file", async () => {
      const original = [
        "# Claude Code OAuth token — get one by running `claude setup-token`.",
        "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-old",
        "# Or use an Anthropic API key instead:",
        "# ANTHROPIC_API_KEY=",
        "GH_TOKEN=ghp_keepme",
        "",
        "CUSTOM_URL=https://example.com/a=b?c=d",
      ].join("\n");
      await writeFile(file, `${original}\n`);

      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "rotate");

      expect(await readFile(file, "utf8")).toBe(
        `${original.replace("sk-ant-old", "sk-ant-new")}\n`,
      );
    });

    it("adds the key when it is absent", async () => {
      await writeFile(file, "GH_TOKEN=ghp_keepme\n");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "rotate");
      expect(await readFile(file, "utf8")).toBe(
        "GH_TOKEN=ghp_keepme\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\n",
      );
    });

    it("does not corrupt a file whose last line has no newline", async () => {
      await writeFile(file, "GH_TOKEN=ghp_keepme");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "rotate");
      expect(await readFile(file, "utf8")).toBe(
        "GH_TOKEN=ghp_keepme\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\n",
      );
    });

    it("only matches the whole key, not a suffix of another key", async () => {
      await writeFile(file, "MY_CLAUDE_CODE_OAUTH_TOKEN=untouched\n");
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-new", "rotate");
      expect(await readFile(file, "utf8")).toBe(
        "MY_CLAUDE_CODE_OAUTH_TOKEN=untouched\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-new\n",
      );
    });

    it("writes values containing regex and shell metacharacters literally", async () => {
      await writeFile(file, "CLAUDE_CODE_OAUTH_TOKEN=old\n");
      const hostile = "a/b&c\\d$e`f\"g'h|i.*j[k]";
      await upsert(file, "CLAUDE_CODE_OAUTH_TOKEN", hostile, "rotate");
      expect(await readFile(file, "utf8")).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${hostile}\n`);
    });
  });
});
