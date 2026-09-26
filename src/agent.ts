import { existsSync } from 'node:fs'
import type { SandboxHooks } from '@ai-hero/sandcastle'
import type { DockerOptions } from '@ai-hero/sandcastle/sandboxes/docker'
import { CREDENTIAL_KEYS, type AgentCredentials } from './env.js'
import { SANDBOX_SIGNING_KEY_PATH, gitSetupCommand } from './git-setup.js'
import { INSTALL_HOOKS_COMMAND, SANDBOX_HOOKS_FILE } from './run-logs/hooks.js'

/** sandcastle names this `MountConfig` but does not export it; take it from
 *  the one option that does, so the shape can never drift from the caller. */
type Mount = NonNullable<DockerOptions['mounts']>[number]

/**
 * The agent's identity inside a Sandbox — whose commits they are, how they are
 * signed, how they are pushed — is the Harness's, injected for the life of one
 * Run (ADR 0006). Nothing is written into the Project checkout, and a Project
 * carries no credentials of its own.
 */

/** The Sandbox's git configuration: the shared command (src/git-setup.ts)
 *  with the key where a Sandbox mounts it. A Session runs the same command
 *  with the key where it mounts it, which is why the command is a function
 *  of the path rather than a constant with a second copy for Sessions. */
export const GIT_SETUP_COMMAND = gitSetupCommand(SANDBOX_SIGNING_KEY_PATH)
export { SANDBOX_SIGNING_KEY_PATH }

/** What a Run hands sandcastle so the Sandbox can commit, sign and push. */
export interface AgentSandbox {
  /** Passed to the sandbox provider, which puts them on the container itself —
   *  so the hook above and the agent both see them. */
  readonly env: Readonly<Record<string, string>>
  readonly mounts: readonly Mount[]
  readonly hooks: SandboxHooks
  /** The identity, whole — established by this function refusing to return
   *  without it. A Run needs the token for its own work as well as the
   *  Sandbox's: Delivery pushes and opens the pull request from the Harness. */
  readonly credentials: AgentCredentials
}

/** What a Run gives the Sandbox to write its own account of itself into. */
export interface Observation {
  /** The Run's hooks file on the Target, already created: Docker makes a
   *  directory for a bind source that does not exist. */
  readonly hooksFile: string
}

/** Every credential, in the order they are reported in — which is the order
 *  `CREDENTIAL_KEYS` declares them, so adding one there is the whole change. */
const REQUIRED = Object.keys(CREDENTIAL_KEYS) as (keyof AgentCredentials)[]

const MISSING_HINT =
  'Capture them with the wizard (`npx @dworznik/sandcastle-vps`), which writes them into ' +
  "the Target's environment file and restarts the Harness."

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
  observe: Observation,
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
      // The one file of the run directory the Sandbox may write: the agent
      // appends its own account of the Run there, and cannot touch the
      // Harness's records beside it.
      { hostPath: observe.hooksFile, sandboxPath: SANDBOX_HOOKS_FILE, readonly: false },
    ],
    hooks: {
      sandbox: {
        onSandboxReady: [{ command: GIT_SETUP_COMMAND }, { command: INSTALL_HOOKS_COMMAND }],
      },
    },
    credentials: complete,
  }
}
