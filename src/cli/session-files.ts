// Not `../agent.js`: that module reads the Harness's environment when loaded,
// and this one is loaded by the CLI on the operator's machine.
import { gitSetupCommand } from '../git-setup.js'
import type { Connector } from './connectors/types.js'
import { fail, secretsDir } from './install.js'
import { PLATFORM_NETWORK } from './network.js'
import type { TargetProfile } from './profiles.js'
import { shellQuote } from './shell.js'
import { KEY_FILE } from './signing-key.js'
import { readEnv } from './target-env.js'

/**
 * What a Session is made of, on the Target: one long-lived container per
 * Project, built from that Project's own image, whose tmux server is what the
 * operator attaches to (ADR 0007).
 *
 * Each Session is its own compose project, so the stack's
 * `up --remove-orphans` can never reach it, and it joins the platform network
 * by name so it resolves the Harness and, later, the Memory. The container's
 * main process is an init script that configures git the way a Run does and
 * then becomes the image's own `sleep infinity`; tmux runs inside it and
 * outlives any attach, which is the whole point — a dropped connection loses
 * nothing.
 *
 * Credentials, per the clause ADR 0010 narrowed in ADR 0007: a Session gets
 * what a Sandbox gets for git — the GitHub token, the author identity and the
 * signing key, read-only — and *not* the Claude credential. Claude Code in a
 * Session runs on the operator's own login, kept in one external volume every
 * Session mounts, and a container carrying `CLAUDE_CODE_OAUTH_TOKEN` would
 * silently ignore that login. The Run token is present under a non-magic
 * name for the one thing that needs it: a Sandbox started from the Session.
 *
 * Pure, plus the one write both callers share: Onboarding generates these
 * files and the Sessions menu (sessions.ts) regenerates them, and `status`
 * lists what is running. None of the three should import the menu.
 */

/** The label every session container carries, and the only way `status`
 *  finds them: the engine, not the stack's compose project. */
export const SESSION_LABEL = 'sandcastle-vps.session'

/** What tmux calls the one thing its server holds per Session — its own
 *  term, not the glossary's. `new-session -A` attaches to it when it exists
 *  and creates it when it does not. */
const TMUX_SESSION = 'main'

/**
 * The one external volume holding the operator's Claude login, mounted into
 * every Session on the Target (ADR 0010). External because the Sessions are
 * separate compose projects (ADR 0007): a volume any one of them owned would
 * go down with it. Created when `sessions` is enabled, and again by every
 * start in case it is not there, which is the same one-liner.
 */
export const CLAUDE_VOLUME = 'sandcastle-vps-claude'

/** Where that volume mounts, and what Claude Code is told is its config
 *  directory, so `.claude.json` — the file it would otherwise keep beside
 *  the directory, in a home that does not persist — lands in the volume too.
 *  The same path it would use anyway, so skills the image linked under it
 *  are found where they were put. */
export const CLAUDE_HOME = '/home/agent/.claude'

/**
 * The name the Run token travels under. Not `CLAUDE_CODE_OAUTH_TOKEN`, which
 * Claude Code reads and would take over the operator's login; the profile
 * below hands it to a Sandbox started from here under the name that Sandbox
 * expects.
 */
export const RUN_TOKEN_KEY = 'SANDCASTLE_RUN_TOKEN'

/** The Target's secrets directory, mounted read-only. The directory rather
 *  than the key file, for the reason compose.yaml gives for the Harness:
 *  Docker creates a *directory* for a bind source that does not exist, and
 *  the key does not exist until the wizard has generated it. */
export const SESSION_SECRETS_DIR = '/home/agent/.sandcastle-agent'
export const SESSION_SIGNING_KEY_PATH = `${SESSION_SECRETS_DIR}/${KEY_FILE}`

/** Where the Session's generated directory is mounted inside the container,
 *  read-only, for the init script. */
export const SESSION_FILES_DIR = '/opt/sandcastle-vps'

export const INIT_FILE = 'session-init.sh'
export const PROFILE_FILE = 'profile.sh'

/** Compose project and container name, both. Distinct from the stack's
 *  project by construction, which is what keeps `--remove-orphans` away. */
export const sessionProject = (name: string): string => `sandcastle-session-${name}`

/** Where the Session's compose file lives, under the install directory. */
export const sessionDir = (installDir: string, name: string): string =>
  `${installDir}/sessions/${name}`

export interface SessionSpec {
  readonly name: string
  readonly imageName: string
  readonly installDir: string
  readonly workspaceRoot: string
  /** The Target's docker group, so the mounted socket is usable by the
   *  unprivileged agent user the image runs as. */
  readonly dockerGid: string
  /** Where the signing key lives on the Target. */
  readonly secretsDir: string
}

/** What the Target's environment file settles about every Session on it. */
export const specFor = (
  profile: TargetProfile,
  envContent: string,
  project: { readonly name: string; readonly imageName: string },
): SessionSpec => ({
  name: project.name,
  imageName: project.imageName,
  installDir: profile.installDir,
  workspaceRoot: readEnv(envContent, 'WORKSPACE_ROOT') ?? profile.workspaceRoot,
  dockerGid: readEnv(envContent, 'DOCKER_GID') ?? '',
  secretsDir: readEnv(envContent, 'SECRETS_DIR') ?? secretsDir(profile.installDir),
})

/** YAML-safe: a JSON string is a YAML string, and paths and names come from
 *  the operator. */
const quoted = (value: string): string => JSON.stringify(value)

/**
 * The Session's compose file. Regenerated on every start — it is derived from
 * the Target's environment and owns no state, so there is nothing in it to
 * preserve, and regenerating is how a changed docker group or workspace root
 * takes effect.
 *
 * No secret is written into it. The credentials are compose interpolations,
 * filled from the Target's own environment file at `up` — the start script
 * passes it with `--env-file` — so the generated file holds names and the
 * Target's `.env` stays the one place a token is.
 */
export const sessionCompose = ({
  name,
  imageName,
  installDir,
  workspaceRoot,
  dockerGid,
  secretsDir: secrets,
}: SessionSpec): string => {
  const dir = sessionDir(installDir, name)
  return `# The Session on ${name}: one container from the Project's own image, in its
# own compose project (ADR 0007). Generated by sandcastle-vps on every Session
# start — edit the Project's .sandcastle/Dockerfile, not this.
name: ${quoted(sessionProject(name))}

services:
  session:
    image: ${quoted(imageName)}
    container_name: ${quoted(sessionProject(name))}
    hostname: ${quoted(name)}
    labels:
      ${SESSION_LABEL}: ${quoted(name)}
    # tmux's server is reparented to PID 1 when an attach ends; the image's
    # own \`sleep infinity\` does not reap, so an init does.
    init: true
    # Configures git as a Run does, then becomes the image's own sleep.
    entrypoint: ["/bin/bash", ${quoted(`${SESSION_FILES_DIR}/${INIT_FILE}`)}]
    working_dir: ${quoted(`${workspaceRoot}/${name}`)}
    environment:
      # The Session shell is bash (ADR 0010); tmux reads this for new windows.
      SHELL: /bin/bash
      # What a Sandbox gets for git (ADR 0007), filled from the Target's
      # environment file at \`up\` and never written here.
      GH_TOKEN: \${GH_TOKEN:-}
      AGENT_GIT_NAME: \${AGENT_GIT_NAME:-}
      AGENT_GIT_EMAIL: \${AGENT_GIT_EMAIL:-}
      # The Run token under a non-magic name (ADR 0010): Claude Code in here
      # runs on the operator's own login, and a Sandbox started from here
      # gets this as CLAUDE_CODE_OAUTH_TOKEN through the profile.
      ${RUN_TOKEN_KEY}: \${CLAUDE_CODE_OAUTH_TOKEN:-}
      # So the login, and the .claude.json beside it, live in the volume.
      CLAUDE_CONFIG_DIR: ${CLAUDE_HOME}
    # The Target's docker group, so the socket below is usable by the agent
    # user. This is the exposure ADR 0007 gates behind the sessions toggle.
    group_add:
      - ${quoted(dockerGid)}
    volumes:
      # Path parity, as in the Harness: a Sandbox started from here bind-mounts
      # worktrees by the path the Target's daemon resolves.
      - ${quoted(`${workspaceRoot}:${workspaceRoot}`)}
      - /var/run/docker.sock:/var/run/docker.sock
      # The signing key, read-only, as a Sandbox has it.
      - ${quoted(`${secrets}:${SESSION_SECRETS_DIR}:ro`)}
      # This directory, for the init script; and the profile every login
      # shell sources, on the path Debian's /etc/profile reads.
      - ${quoted(`${dir}:${SESSION_FILES_DIR}:ro`)}
      - ${quoted(`${dir}/${PROFILE_FILE}:/etc/profile.d/sandcastle-vps.sh:ro`)}
      # The operator's Claude login, shared by every Session on the Target.
      - ${CLAUDE_VOLUME}:${CLAUDE_HOME}
    restart: unless-stopped

volumes:
  ${CLAUDE_VOLUME}:
    external: true

networks:
  # The platform network, created by the install; joined by name so the
  # Harness and the Memory resolve from inside (ADR 0010).
  default:
    name: ${PLATFORM_NETWORK}
    external: true
`
}

/**
 * The container's main process. Git is configured exactly as a Run's Sandbox
 * configures it — the same command, with the key where this container has
 * it — so a commit from a Session is authored, signed and pushed as the
 * agent's (ADR 0007). Every value is read from the environment, never
 * interpolated: this file lands on the Target's disk.
 */
export const sessionInit = (): string => `#!/bin/bash
# Generated by sandcastle-vps; written over on every Session start.
${gitSetupCommand(SESSION_SIGNING_KEY_PATH)}
exec sleep infinity
`

/**
 * Sourced by every login shell in the Session, which is every tmux window.
 * The one thing it does in this slice: hand the Run token to a Sandbox
 * started from here under the name that Sandbox reads, for that process
 * only — the shell itself never holds it under that name.
 */
export const sessionProfile =
  (): string => `# Generated by sandcastle-vps; written over on every Session start.
# A Sandbox started from this Session gets the Run token as the Claude
# credential it expects (ADR 0010). The Session itself never carries it under
# that name: Claude Code in here runs on your own login.
sandcastle() {
  CLAUDE_CODE_OAUTH_TOKEN="\${${RUN_TOKEN_KEY}:-}" command sandcastle "$@"
}
`

/**
 * The Dev Containers file, so an editor attaches to the same container. The
 * only thing written into the repository, because the spec requires that
 * path (ADR 0007) — and gitignored from inside its own directory, so the
 * Project's tracked .gitignore is left alone and the directory never shows
 * up for an agent to commit.
 */
export const devcontainer = ({ name, installDir, workspaceRoot }: SessionSpec): string =>
  `${JSON.stringify(
    {
      name,
      dockerComposeFile: [`${sessionDir(installDir, name)}/compose.yaml`],
      service: 'session',
      workspaceFolder: `${workspaceRoot}/${name}`,
      // The Session outlives the editor, as it outlives an ssh connection.
      shutdownAction: 'none',
    },
    null,
    2,
  )}\n`

/** Write one generated file under the Session's directory; the content
 *  arrives on stdin, as the environment file's does, so there is one way a
 *  file reaches the Target. */
export const writeSessionFileScript = (installDir: string, name: string, file: string): string => {
  const dir = shellQuote(sessionDir(installDir, name))
  return `set -eu
mkdir -p ${dir}
cat > ${dir}/${file}`
}

/** Seed the devcontainer file: written only when absent, since an operator
 *  may have tuned it, and self-ignored so git never sees the directory. */
export const writeDevcontainerScript = (workspaceRoot: string, name: string): string => {
  const dir = shellQuote(`${workspaceRoot}/${name}/.devcontainer`)
  return `set -eu
mkdir -p ${dir}
printf '*\\n' > ${dir}/.gitignore
if [ -e ${dir}/devcontainer.json ]; then
  cat > /dev/null
else
  cat > ${dir}/devcontainer.json
fi`
}

/** Every generated artifact, on the Target. Onboarding calls this, and so
 *  does every Session start — which is how a Project Onboarded before
 *  Sessions existed gets them without a step of its own. */
export const writeSessionArtifacts = async (
  connector: Connector,
  spec: SessionSpec,
): Promise<void> => {
  if (!spec.dockerGid) {
    throw new Error(
      'The Target’s environment file has no DOCKER_GID, so a Session could not use the ' +
        'Docker socket. Run install/upgrade first.',
    )
  }
  const files: readonly (readonly [string, string, string])[] = [
    ['compose.yaml', sessionCompose(spec), 'Writing the Session compose file'],
    [INIT_FILE, sessionInit(), 'Writing the Session init script'],
    [PROFILE_FILE, sessionProfile(), 'Writing the Session profile'],
  ]
  for (const [file, content, what] of files) {
    const written = await connector.exec(writeSessionFileScript(spec.installDir, spec.name, file), {
      stdin: content,
    })
    if (written.code !== 0) throw fail(what, written.code, written.stderr)
  }
  const dev = await connector.exec(writeDevcontainerScript(spec.workspaceRoot, spec.name), {
    stdin: devcontainer(spec),
  })
  if (dev.code !== 0) throw fail('Writing the devcontainer file', dev.code, dev.stderr)
}

/** Create the login volume unless it is there. Inspect first, so "already
 *  exists" is not mistaken for the daemon not answering. */
export const ensureClaudeVolumeScript = (): string =>
  `docker volume inspect ${CLAUDE_VOLUME} > /dev/null 2>&1 || docker volume create ${CLAUDE_VOLUME} > /dev/null`

/** The Session's compose project, with the Target's environment file for
 *  interpolation — that is where the credentials come from. */
const composeIn = (installDir: string, name: string, args: string): string =>
  `cd ${shellQuote(sessionDir(installDir, name))} && ` +
  `docker compose --env-file ${shellQuote(`${installDir}/.env`)} ${args}`

/**
 * Start the Session, or find it already started. `up -d` is idempotent on a
 * running project, which is what makes a second open attach to the same
 * container; the image check in front of it turns compose's attempt to pull
 * a nonexistent image into a sentence.
 */
export const startScript = (installDir: string, name: string, imageName: string): string =>
  `set -eu
if ! docker image inspect ${shellQuote(imageName)} > /dev/null 2>&1; then
  printf 'error\\tThe image %s is not built. A Run builds it, or retry the build from "Add a Project".\\n' ${shellQuote(imageName)}
  exit 0
fi
if [ -n "$(docker ps -q --filter ${shellQuote(`label=${SESSION_LABEL}=${name}`)})" ]; then
  printf 'state\\trunning\\n'
  exit 0
fi
${ensureClaudeVolumeScript()}
${composeIn(installDir, name, 'up -d')} > /dev/null 2>&1
printf 'state\\tstarted\\n'`

/**
 * What runs on the Target's terminal to land in the Session: exec into the
 * container with a TTY, and attach to its tmux server or start it. TERM is
 * the operator's, carried by ssh, so colours and keys inside match the
 * terminal outside.
 */
export const attachScript = (name: string): string =>
  `exec docker exec -it -e "TERM=\${TERM:-xterm}" ${shellQuote(sessionProject(name))} ` +
  `tmux new-session -A -s ${TMUX_SESSION}`

/** Explicit, and the only way a Session ends: the container and its tmux
 *  server go together. A detach is not this. The login volume is external
 *  and untouched by it. */
export const stopScript = (installDir: string, name: string): string =>
  `${composeIn(installDir, name, 'down')} > /dev/null 2>&1`

/** Every running Session on the Target, from the engine. `status` and the
 *  menu both use it; neither goes through the stack's compose project. */
export const listScript = (): string =>
  `docker ps --filter label=${SESSION_LABEL} --format '{{.Label "${SESSION_LABEL}"}}\t{{.Status}}'`

export interface RunningSession {
  readonly project: string
  /** As the engine reports it — "Up 2 hours". */
  readonly status: string
}

export const parseSessions = (stdout: string): RunningSession[] =>
  stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [project, ...status] = line.split('\t')
      return project ? [{ project, status: status.join(' ').trim() }] : []
    })

// -------------------------------------------------------------------- login

/** Whether the operator has logged Claude Code in, read off the shared
 *  volume. `no-volume` is a Target where sessions was never enabled, or was
 *  enabled before the volume existed and no Session has started since. */
export type ClaudeLogin = 'present' | 'absent' | 'no-volume'

/** The file Claude Code writes at login, inside its config directory. Only
 *  its presence is read — never its content, which is the login. */
const CREDENTIALS_FILE = '.credentials.json'

/**
 * Read-only, for `status`. Looks inside the volume through a throwaway
 * container on the Harness image — on the Target by definition — because a
 * volume's files are the daemon's, not the operator's, to read directly.
 * `test -s` needs the directory, not the file: the login stays unread.
 */
export const loginScript = (installDir: string): string => `set -u
if ! docker volume inspect ${CLAUDE_VOLUME} > /dev/null 2>&1; then
  printf 'volume\\tabsent\\n'
  exit 0
fi
printf 'volume\\tpresent\\n'
cd ${shellQuote(installDir)} || exit 0
if docker run --rm -v ${CLAUDE_VOLUME}:/claude:ro --entrypoint test \\
  "$(docker compose images -q harness | head -1)" -s /claude/${CREDENTIALS_FILE} > /dev/null 2>&1; then
  printf 'login\\tpresent\\n'
else
  printf 'login\\tabsent\\n'
fi`

export const parseLogin = (stdout: string): ClaudeLogin => {
  const fields = Object.fromEntries(
    stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((pair): pair is [string, string] => pair.length === 2),
  )
  if (fields.volume !== 'present') return 'no-volume'
  return fields.login === 'present' ? 'present' : 'absent'
}
