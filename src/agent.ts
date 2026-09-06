import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./projects.js";

/**
 * The agent's identity inside the sandbox — whose commits they are, how they
 * are signed, how they are pushed — comes entirely from the Project's own
 * `.sandcastle/`: the `AGENT_GIT_*` and `GH_TOKEN` lines of its `.env`, which
 * sandcastle already passes into the container, and a signing key file
 * stamped there by `init-project` / `sync-env`. The Harness holds none of it
 * (ADR 0003); it only wires what the Project carries into git.
 */

/** The signing key, as `init-project` / `sync-env` leave it in `.sandcastle/`. */
export const SIGNING_KEY_FILE = "agent_signing_key";
/** Where that key is mounted, read-only, inside the sandbox. */
export const SANDBOX_SIGNING_KEY_PATH = "/home/agent/.sandcastle-agent/signing_key";

export interface AgentMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: true;
}

export interface AgentSandbox {
  readonly mounts: readonly AgentMount[];
  readonly hooks: {
    readonly sandbox: { readonly onSandboxReady: readonly { readonly command: string }[] };
  };
}

/**
 * Runs inside the sandbox as the agent user before the agent starts; every
 * value it reads arrives through the Project's `.env`. Each step is
 * conditional so a Project with a partial identity still runs — it just
 * cannot sign, or cannot push, until the rest is stamped in.
 */
export const GIT_SETUP_COMMAND = `set -e
if [ -n "\${AGENT_GIT_NAME:-}" ]; then git config --global user.name "$AGENT_GIT_NAME"; fi
if [ -n "\${AGENT_GIT_EMAIL:-}" ]; then git config --global user.email "$AGENT_GIT_EMAIL"; fi
if [ -n "\${GH_TOKEN:-}" ]; then git config --global credential.helper '!gh auth git-credential'; fi
if [ -f ${SANDBOX_SIGNING_KEY_PATH} ]; then
  git config --global gpg.format ssh
  git config --global user.signingkey ${SANDBOX_SIGNING_KEY_PATH}
  git config --global commit.gpgsign true
fi`;

/** What a Run passes to sandcastle so the sandbox can commit, sign, and push as the agent. */
export const agentSandbox = (project: Project): AgentSandbox => {
  const keyPath = join(project.path, ".sandcastle", SIGNING_KEY_FILE);
  // sandcastle fails sandbox creation on a missing host path, so only mount
  // the key when the Project actually has one.
  const mounts: AgentMount[] = existsSync(keyPath)
    ? [{ hostPath: keyPath, sandboxPath: SANDBOX_SIGNING_KEY_PATH, readonly: true }]
    : [];
  return {
    mounts,
    hooks: { sandbox: { onSandboxReady: [{ command: GIT_SETUP_COMMAND }] } },
  };
};
