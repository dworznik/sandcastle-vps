import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { evaluateProbe, parseProbe, probeScript } from "../preflight.js";
import { shellQuote } from "../shell.js";
import type { Connector, ExecOptions, ExecResult, Preflight } from "./types.js";

/**
 * The argv after `ssh`. Two decisions live here:
 *
 * - The script is handed to `bash -c`, not to whatever login shell the
 *   operator has on the Target: a script written for `sh` is not a script fish
 *   will run. The quoting `shellQuote` produces is read identically by sh,
 *   bash, zsh and fish, so the outer hop is shell-agnostic too.
 * - Elevation is `sudo -n`. A Connector has no terminal to answer a password
 *   prompt on, and a prompt with nowhere to go is a hang; preflight reports
 *   whether elevation is passwordless before the wizard offers to use it.
 */
export const sshArgs = (host: string, script: string, opts?: ExecOptions): string[] => {
  const remote = opts?.sudo ? `sudo -n bash -c ${shellQuote(script)}` : script;
  return [host, `bash -c ${shellQuote(remote)}`];
};

/** A tar arrives on stdin; nothing on either end needs rsync. */
const extractCommand = (destDir: string): string =>
  `mkdir -p ${shellQuote(destDir)} && tar -xzf - -C ${shellQuote(destDir)} --strip-components=1`;

const run = (host: string, script: string, opts?: ExecOptions): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(host, script, opts), {
      // ssh reads a passphrase or password from /dev/tty rather than stdin, so
      // an interactive login still works while stdin carries a payload.
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", (error) =>
      reject(
        new Error(
          `Could not run ssh. Is an ssh client installed on this machine? (${error.message})`,
          { cause: error },
        ),
      ),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));

    const { stdin } = opts ?? {};
    if (stdin === undefined) {
      child.stdin.end();
    } else if (typeof stdin === "string") {
      child.stdin.end(stdin);
    } else {
      stdin.on("error", reject);
      stdin.pipe(child.stdin);
    }
  });

export const sshConnector = (host: string, installDir: string): Connector => ({
  kind: "ssh",
  description: `ssh: ${host}`,
  exec: (script, opts) => run(host, script, opts),
  putTar: async (stream: Readable, destDir: string): Promise<void> => {
    const { code, stderr } = await run(host, extractCommand(destDir), { stdin: stream });
    if (code !== 0) {
      throw new Error(`Delivering the package to ${host}:${destDir} failed: ${stderr.trim()}`);
    }
  },
  preflight: async (): Promise<Preflight> => {
    const { code, stdout, stderr } = await run(host, probeScript(installDir));
    // The probe's own checks never fail the script — a non-zero exit with
    // nothing on stdout means the hop itself failed, which is not a preflight
    // result to report but an error to raise.
    if (code !== 0 && stdout.trim() === "") {
      throw new Error(`Could not reach ${host} over ssh: ${stderr.trim() || `ssh exited ${code}`}`);
    }
    return evaluateProbe(parseProbe(stdout));
  },
});
