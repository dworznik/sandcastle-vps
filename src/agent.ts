import { existsSync } from 'node:fs'
import type { SandboxHooks } from '@ai-hero/sandcastle'
import type { DockerOptions } from '@ai-hero/sandcastle/sandboxes/docker'
import { CREDENTIAL_KEYS, type AgentCredentials } from './env.js'

/** sandcastle names this `MountConfig` but does not export it; take it from
 *  the one option that does, so the shape can never drift from the caller. */
type Mount = NonNullable<DockerOptions['mounts']>[number]

/**
 * The agent's identity inside a Sandbox — whose commits they are, how they are
 * signed, how they are pushed — is the Harness's, injected for the life of one
 * Run (ADR 0006). Nothing is written into the Project checkout, and a Project
 * carries no credentials of its own.
 */

/** Where the signing key is mounted, read-only, inside the Sandbox. */
export const SANDBOX_SIGNING_KEY_PATH = '/home/agent/.sandcastle-agent/signing_key'

/**
 * Runs in the Sandbox as the agent user, after sandcastle's own git setup and
 * before the agent starts — so this wins where the two disagree, which is the
 * author identity sandcastle copies off the host checkout.
 *
 * Every secret is read from the environment rather than interpolated: sandcastle
 * prints each hook's command as it runs it, and a token in that string would be
 * a token in the Run's log.
 */
export const GIT_SETUP_COMMAND = `set -eu
git config --global user.name "$AGENT_GIT_NAME"
git config --global user.email "$AGENT_GIT_EMAIL"
git config --global credential.helper '!gh auth git-credential'
git config --global gpg.format ssh
git config --global user.signingkey ${SANDBOX_SIGNING_KEY_PATH}
git config --global commit.gpgsign true`

/** What a Run hands sandcastle so the Sandbox can commit, sign and push. */
export interface AgentSandbox {
  /** Passed to the sandbox provider, which puts them on the container itself —
   *  so the hook above and the agent both see them. */
  readonly env: Readonly<Record<string, string>>
  readonly mounts: readonly Mount[]
  readonly hooks: SandboxHooks
}

/** Order is the order they are reported in, so keep it useful to read. */
const REQUIRED: readonly (keyof AgentCredentials)[] = [
  'agentToken',
  'githubToken',
  'gitName',
  'gitEmail',
  'signingKeyPath',
]

const MISSING_HINT =
  'Capture them with the wizard (`npx @dworznik/sandcastle-vps` → Rotate credentials), ' +
  "which writes them into the Target's environment file and restarts the Harness."

/**
 * Build a Run's sandbox wiring, or refuse and name what is missing.
 *
 * Refusing is the point: an incomplete identity does not produce a slightly
 * worse Run, it produces unsigned commits or an agent that works for twenty
 * minutes and then cannot push. The Harness holds the credentials, so it is
 * also the only thing that can tell the operator which one it is short of.
 */
export const agentSandbox = (
  credentials: Partial<AgentCredentials>,
  exists: (path: string) => boolean = existsSync,
): AgentSandbox => {
  const missing = REQUIRED.filter((field) => !credentials[field])
  if (missing.length > 0) {
    throw new Error(
      `The Harness has no ${missing.length === 1 ? 'value for' : 'values for'} ` +
        `${missing.map((field) => CREDENTIAL_KEYS[field]).join(', ')}, so a Run would be ` +
        `unauthenticated. ${MISSING_HINT}`,
    )
  }
  const complete = credentials as AgentCredentials

  // The mount's host path is resolved twice: here, and by the Target's daemon
  // when it creates the Sandbox. Compose mounts the secrets directory into the
  // Harness at path parity so both see the same file — and so this check fails
  // loudly now rather than producing a container with an empty directory where
  // the key should be, which is what Docker creates for a missing bind source.
  if (!exists(complete.signingKeyPath)) {
    throw new Error(
      `${CREDENTIAL_KEYS.signingKeyPath} points at ${complete.signingKeyPath}, and there is no ` +
        `file there. On the Target it lives in the secrets directory compose mounts into the ` +
        `Harness; a Run cannot sign without it. ${MISSING_HINT}`,
    )
  }

  return {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: complete.agentToken,
      GH_TOKEN: complete.githubToken,
      AGENT_GIT_NAME: complete.gitName,
      AGENT_GIT_EMAIL: complete.gitEmail,
    },
    mounts: [
      { hostPath: complete.signingKeyPath, sandboxPath: SANDBOX_SIGNING_KEY_PATH, readonly: true },
    ],
    hooks: { sandbox: { onSandboxReady: [{ command: GIT_SETUP_COMMAND }] } },
  }
}
