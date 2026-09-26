import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import { PLATFORM_NETWORK } from './network.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { SANDBOX_SIGNING_KEY_PATH, gitSetupCommand } from '../git-setup.js'
import {
  CLAUDE_HOME,
  CLAUDE_VOLUME,
  RUN_TOKEN_KEY,
  SESSION_LABEL,
  SESSION_SIGNING_KEY_PATH,
  STATE_DIR,
  STATE_VOLUME,
  TMUX_SEEDED_MARKER,
  attachScript,
  devcontainer,
  ensureClaudeVolumeScript,
  ensureStateVolumeScript,
  listScript,
  loginScript,
  parseLogin,
  parseSessions,
  sessionCompose,
  sessionInit,
  sessionProfile,
  sessionProject,
  sessionState,
  startScript,
  stateSetupCommand,
  stopScript,
  tmuxConf,
  writeDevcontainerScript,
  writeSessionArtifacts,
  writeSessionFileScript,
  type SessionSpec,
} from './session-files.js'

const exec = promisify(execFile)
import { FIRST_TIME, applySessions, sessionsMenu } from './sessions.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const spec: SessionSpec = {
  name: 'todo',
  imageName: 'sandcastle:todo',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
  dockerGid: '988',
  secretsDir: '/home/op/.sandcastle-vps/secrets',
}

/** The keys the compose file sets on the container, read the way compose
 *  reads them: the indented `KEY:` lines under `environment:`. */
const environmentKeys = (compose: string): string[] =>
  (compose.split('    environment:\n')[1]?.split(/\n {4}\S/u)[0] ?? '')
    .split('\n')
    .flatMap((line) => {
      const match = /^ {6}([A-Z_]+):/u.exec(line)
      return match?.[1] ? [match[1]] : []
    })

describe('sessionCompose', () => {
  const compose = sessionCompose(spec)

  it("is one container from the Project's own image", () => {
    expect(compose).toContain('image: "sandcastle:todo"')
    expect(compose.match(/^    image: /gmu)).toHaveLength(1)
  })

  // The stack's `up --remove-orphans` reaches every container in its own
  // compose project and no other; a Session in a project of its own is out of
  // reach by construction.
  it('is a compose project separate from the stack', () => {
    expect(compose).toContain(`name: "${sessionProject('todo')}"`)
    expect(sessionProject('todo')).not.toBe(PLATFORM_NETWORK)
  })

  it('mounts the workspace root at path parity and the Docker socket', () => {
    expect(compose).toContain('"/home/op/work:/home/op/work"')
    expect(compose).toContain('/var/run/docker.sock:/var/run/docker.sock')
    expect(compose).toContain('- "988"')
  })

  it('joins the platform network by name', () => {
    expect(compose).toContain(`name: ${PLATFORM_NETWORK}\n    external: true`)
  })

  it('carries the label status finds it by', () => {
    expect(compose).toContain(`${SESSION_LABEL}: "todo"`)
  })

  it('works in the Project checkout, with bash as the shell', () => {
    expect(compose).toContain('working_dir: "/home/op/work/todo"')
    expect(compose).toContain('SHELL: /bin/bash')
  })

  // ADR 0007's credentials clause as ADR 0010 narrowed it: what a Sandbox
  // gets for git, and not the Claude credential.
  it('carries what a Sandbox gets for git, filled from the Target’s environment file', () => {
    expect(environmentKeys(compose)).toEqual(
      expect.arrayContaining(['GH_TOKEN', 'AGENT_GIT_NAME', 'AGENT_GIT_EMAIL']),
    )
    expect(compose).toContain('GH_TOKEN: ${GH_TOKEN:-}')
    expect(compose).toContain('"/home/op/.sandcastle-vps/secrets:/home/agent/.sandcastle-agent:ro"')
  })

  // A session container with the Run token under the name Claude Code reads
  // silently ignores the operator's own login (ADR 0010).
  it('never sets CLAUDE_CODE_OAUTH_TOKEN on the container', () => {
    expect(environmentKeys(compose)).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('carries the Run token under its non-magic name, for a Sandbox started from here', () => {
    expect(environmentKeys(compose)).toContain(RUN_TOKEN_KEY)
    expect(compose).toContain(`${RUN_TOKEN_KEY}: \${CLAUDE_CODE_OAUTH_TOKEN:-}`)
  })

  // No token value ever lands in the generated file: the names are compose
  // interpolations, and the Target's .env stays the one place a token is.
  it('holds no secret itself', () => {
    expect(compose).not.toMatch(/(?:GH_TOKEN|AGENT_GIT_NAME|CLAUDE_CODE_OAUTH_TOKEN): [^$]/u)
  })

  // The second external volume (ADR 0010): shell state, shared by every
  // Session like the login is, and outside every Session's compose project.
  it('mounts the shared state volume, external', () => {
    expect(compose).toContain(`- ${STATE_VOLUME}:${STATE_DIR}`)
    expect(compose).toContain(`  ${STATE_VOLUME}:\n    external: true`)
  })

  it('mounts the shared login volume, external, and points Claude Code at it', () => {
    expect(compose).toContain(`- ${CLAUDE_VOLUME}:${CLAUDE_HOME}`)
    expect(compose).toContain(`volumes:\n  ${CLAUDE_VOLUME}:\n    external: true`)
    expect(compose).toContain(`CLAUDE_CONFIG_DIR: ${CLAUDE_HOME}`)
  })

  it('starts through the init script, mounted read-only from the Session directory', () => {
    expect(compose).toContain('entrypoint: ["/bin/bash", "/opt/sandcastle-vps/session-init.sh"]')
    expect(compose).toContain('"/home/op/.sandcastle-vps/sessions/todo:/opt/sandcastle-vps:ro"')
    expect(compose).toContain(
      '"/home/op/.sandcastle-vps/sessions/todo/profile.sh:/etc/profile.d/sandcastle-vps.sh:ro"',
    )
  })

  it('quotes a name a shell or YAML would otherwise read', () => {
    expect(sessionCompose({ ...spec, name: 'my.app' })).toContain('hostname: "my.app"')
  })
})

describe('sessionInit', () => {
  const init = sessionInit()

  // The same configuration a Run's Sandbox gets — the same command, with the
  // key where this container has it — so a commit from a Session is the
  // agent's (ADR 0007).
  it('configures git exactly as a Run does, with the key where the Session mounts it', () => {
    expect(init).toContain(gitSetupCommand(SESSION_SIGNING_KEY_PATH))
    expect(SESSION_SIGNING_KEY_PATH).not.toBe(SANDBOX_SIGNING_KEY_PATH)
    expect(init).toContain('gh auth git-credential')
    expect(init).toContain('commit.gpgsign true')
  })

  it('reads every value from the environment, since it lands on disk', () => {
    expect(init).toContain('"$AGENT_GIT_NAME"')
    expect(init).not.toMatch(/github_pat|sk-ant/u)
  })

  it('then becomes the image’s own main process', () => {
    expect(init.trim().split('\n').at(-1)).toBe('exec sleep infinity')
  })

  it('sets the shell state up between the two', () => {
    expect(init).toContain(stateSetupCommand())
  })
})

describe('sessionState', () => {
  const state = sessionState()

  // In bash's own format, in the volume, appended as it happens: a window
  // that dies with the container keeps what was typed in it.
  it('keeps bash history in the volume, appended as it happens', () => {
    expect(state).toContain(`export HISTFILE=${STATE_DIR}/bash_history`)
    expect(state).toContain('shopt -s histappend')
    expect(state).toContain('history -a')
  })

  it('sources the operator’s .bashrc only when there is one', () => {
    expect(state).toContain(`[ -f ${STATE_DIR}/.bashrc ] && . ${STATE_DIR}/.bashrc`)
  })
})

describe('tmuxConf', () => {
  // The login shell is bash by the image and by decision (ADR 0010); the
  // seed must not be a second place that decides it, or the operator's own
  // config would have a platform line to fight.
  it('sets no shell', () => {
    expect(tmuxConf()).not.toMatch(/default-shell|default-command/u)
    expect(tmuxConf()).not.toContain('zsh')
  })

  it('says it is the operator’s from now on', () => {
    expect(tmuxConf()).toContain('writes it again')
  })
})

/**
 * The seed-once rule is a property of the shell in the init script, so it is
 * tested by running that shell against a temporary directory standing in
 * for the volume and the container's home.
 */
describe('stateSetupCommand, run for real', () => {
  const made: string[] = []
  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  const scratch = async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-state-'))
    made.push(root)
    const home = join(root, 'home')
    const state = join(root, 'state')
    const files = join(root, 'files')
    await Promise.all([home, state, files].map((dir) => exec('mkdir', ['-p', dir])))
    await writeFile(join(home, '.bashrc'), '# the image’s own\n')
    await writeFile(join(files, 'tmux.conf'), tmuxConf())
    await writeFile(join(files, 'session-state.sh'), sessionState())
    const start = () =>
      exec('bash', ['-c', `set -eu\n${stateSetupCommand(state, files)}`], {
        env: { ...process.env, HOME: home },
      })
    const listing = async () => (await readdir(state)).sort()
    return { home, state, start, listing }
  }

  it('seeds the tmux config once, and never writes anything else', async () => {
    const { state, start, listing } = await scratch()
    await start()
    expect(await listing()).toEqual(['.tmux.conf', TMUX_SEEDED_MARKER])
    expect(await readFile(join(state, '.tmux.conf'), 'utf8')).toBe(tmuxConf())

    await writeFile(join(state, '.tmux.conf'), 'set -g mouse off\n')
    await start()
    await start()
    expect(await readFile(join(state, '.tmux.conf'), 'utf8')).toBe('set -g mouse off\n')
    expect(await listing()).toEqual(['.tmux.conf', TMUX_SEEDED_MARKER])
  })

  // Removing the file returns tmux to its defaults; a seed that came back on
  // the next start would make that impossible.
  it('leaves a removed tmux config removed', async () => {
    const { state, start, listing } = await scratch()
    await start()
    await rm(join(state, '.tmux.conf'))
    await start()
    expect(await listing()).toEqual([TMUX_SEEDED_MARKER])
  })

  it('links ~/.tmux.conf into the volume and hooks the state file into ~/.bashrc once', async () => {
    const { home, state, start } = await scratch()
    await start()
    await start()
    expect((await stat(join(home, '.tmux.conf'))).isFile()).toBe(true)
    const bashrc = await readFile(join(home, '.bashrc'), 'utf8')
    expect(bashrc.startsWith('# the image’s own')).toBe(true)
    expect(bashrc.match(/session-state\.sh/gu)).toHaveLength(2)
    expect(bashrc.match(/sandcastle-vps:/gu)).toHaveLength(1)
    expect(state).toBeTruthy()
  })

  it('does nothing at all when the volume is not writable', async () => {
    const { home, state, start, listing } = await scratch()
    await exec('chmod', ['555', state])
    await start()
    expect(await listing()).toEqual([])
    expect(await readFile(join(home, '.bashrc'), 'utf8')).toBe('# the image’s own\n')
    await exec('chmod', ['755', state])
  })
})

describe('ensureStateVolumeScript', () => {
  const script = ensureStateVolumeScript('sandcastle:todo')

  // A fresh named volume at a path the image lacks is root's, and the
  // Session runs as the agent user: without this, history and the seed
  // would fail silently.
  it('creates the volume owned by the operator, through the Project’s own image', () => {
    expect(script).toContain(`docker volume create ${STATE_VOLUME}`)
    expect(script).toContain(`--entrypoint chown -v ${STATE_VOLUME}:/state 'sandcastle:todo'`)
    expect(script).toContain('"$(id -u):$(id -g)" /state')
  })

  it('touches nothing when the volume is already there', () => {
    expect(script.startsWith(`if ! docker volume inspect ${STATE_VOLUME}`)).toBe(true)
  })
})

describe('sessionProfile', () => {
  const profileFile = sessionProfile()

  // The bridge from the non-magic name to the one a Sandbox reads, for that
  // process only.
  it('hands the Run token to a Sandbox started from the Session, and to nothing else', () => {
    expect(profileFile).toContain(
      `CLAUDE_CODE_OAUTH_TOKEN="\${${RUN_TOKEN_KEY}:-}" command sandcastle "$@"`,
    )
    expect(profileFile).not.toMatch(/^export CLAUDE_CODE_OAUTH_TOKEN/mu)
  })
})

describe('ensureClaudeVolumeScript', () => {
  it('creates the volume only when it is not already there', () => {
    expect(ensureClaudeVolumeScript()).toContain(`docker volume inspect ${CLAUDE_VOLUME}`)
    expect(ensureClaudeVolumeScript()).toContain(`|| docker volume create ${CLAUDE_VOLUME}`)
  })
})

describe('loginScript and parseLogin', () => {
  const script = loginScript('/home/op/.sandcastle-vps')

  // Presence, never content: the login is the operator's.
  it('reads whether the login file exists and never its content', () => {
    expect(script).toContain('test')
    expect(script).toContain('-s /claude/.credentials.json')
    expect(script).toContain(`${CLAUDE_VOLUME}:/claude:ro`)
    expect(script).not.toContain('cat ')
  })

  it('answers without a container when the volume is not there', () => {
    expect(script).toContain(`docker volume inspect ${CLAUDE_VOLUME}`)
    expect(parseLogin('volume\tabsent\n')).toBe('no-volume')
  })

  it('tells a logged-in volume from an empty one', () => {
    expect(parseLogin('volume\tpresent\nlogin\tpresent\n')).toBe('present')
    expect(parseLogin('volume\tpresent\nlogin\tabsent\n')).toBe('absent')
    expect(parseLogin('')).toBe('no-volume')
  })
})

describe('devcontainer', () => {
  const parsed = JSON.parse(devcontainer(spec)) as Record<string, unknown>

  it('points an editor at the same compose service', () => {
    expect(parsed.dockerComposeFile).toEqual([
      '/home/op/.sandcastle-vps/sessions/todo/compose.yaml',
    ])
    expect(parsed.service).toBe('session')
    expect(parsed.workspaceFolder).toBe('/home/op/work/todo')
  })

  it('leaves the Session running when the editor closes', () => {
    expect(parsed.shutdownAction).toBe('none')
  })
})

describe('writeSessionFileScript', () => {
  it('writes under the install directory, from stdin', () => {
    const script = writeSessionFileScript('/home/op/.sandcastle-vps', 'todo', 'compose.yaml')
    expect(script).toContain("mkdir -p '/home/op/.sandcastle-vps/sessions/todo'")
    expect(script).toContain("cat > '/home/op/.sandcastle-vps/sessions/todo'/compose.yaml")
  })
})

describe('writeDevcontainerScript', () => {
  const script = writeDevcontainerScript('/home/op/work', 'todo')

  // The only thing written into the repository — and ignored from inside its
  // own directory, so the tracked .gitignore is untouched and an agent
  // committing in the checkout never sees it.
  it('ignores itself rather than editing the Project’s .gitignore', () => {
    expect(script).toContain("printf '*\\n' > '/home/op/work/todo/.devcontainer'/.gitignore")
    expect(script).not.toContain('>> ')
  })

  it('seeds the file and never overwrites one that is there', () => {
    expect(script).toContain('if [ -e')
    expect(script).toContain('cat > /dev/null')
  })
})

describe('startScript', () => {
  const script = startScript('/home/op/.sandcastle-vps', 'todo', 'sandcastle:todo')

  it('is idempotent: a running Session is found, not started again', () => {
    expect(script).toContain(`label=${SESSION_LABEL}=todo`)
    expect(script).toContain("printf 'state\\trunning\\n'")
    expect(script).toContain(' up -d')
  })

  it('says the image is not built rather than letting compose try to pull it', () => {
    expect(script).toContain("docker image inspect 'sandcastle:todo'")
    expect(script).toContain('is not built')
  })

  // The credentials are compose interpolations; the Target's own environment
  // file is what fills them, and nothing else ever holds them.
  it('fills the credentials from the Target’s environment file at up', () => {
    expect(script).toContain("docker compose --env-file '/home/op/.sandcastle-vps/.env' up -d")
  })

  it('makes sure both volumes exist before compose looks for them', () => {
    expect(script.indexOf('docker volume inspect')).toBeLessThan(script.indexOf('compose'))
    expect(script).toContain(ensureClaudeVolumeScript())
    expect(script).toContain(ensureStateVolumeScript('sandcastle:todo'))
  })
})

describe('attachScript', () => {
  const script = attachScript('todo')

  it('execs into the container with a TTY and lands in tmux', () => {
    expect(script).toContain('docker exec -it')
    expect(script).toContain(`'${sessionProject('todo')}'`)
    expect(script).toContain('tmux new-session -A -s main')
  })

  it("carries the operator's TERM in", () => {
    expect(script).toContain('TERM=${TERM:-xterm}')
  })
})

describe('stopScript', () => {
  it('takes the compose project down, in its own directory', () => {
    expect(stopScript('/home/op/.sandcastle-vps', 'todo')).toContain(
      "cd '/home/op/.sandcastle-vps/sessions/todo' && docker compose --env-file " +
        "'/home/op/.sandcastle-vps/.env' down",
    )
  })

  it('never removes the login volume', () => {
    expect(stopScript('/home/op/.sandcastle-vps', 'todo')).not.toMatch(/down.*(?:-v|--volumes)/u)
  })
})

describe('listScript and parseSessions', () => {
  it('asks the engine, not the stack’s compose project', () => {
    expect(listScript()).toContain('docker ps')
    expect(listScript()).not.toContain('compose')
    expect(listScript()).toContain(`label=${SESSION_LABEL}`)
  })

  it('reads each running Session by Project', () => {
    expect(parseSessions('todo\tUp 2 hours\nblog\tUp 5 minutes\n')).toEqual([
      { project: 'todo', status: 'Up 2 hours' },
      { project: 'blog', status: 'Up 5 minutes' },
    ])
    expect(parseSessions('')).toEqual([])
  })
})

// ------------------------------------------------------------------- the flow

interface Ran {
  readonly script: string
  readonly stdin: string
}

const ENV = [
  'WORKSPACE_ROOT=/home/op/work',
  'DOCKER_GID=988',
  'SESSIONS_ENABLED=true',
  'ACCESS_ENABLED=false',
  '',
].join('\n')

interface TargetState {
  readonly env?: string
  readonly version?: string
  readonly running?: string
  readonly projects?: unknown[]
  readonly start?: string
  /** Whether the Connector can attach at all. */
  readonly attach?: boolean
}

const fakeConnector = ({
  env = ENV,
  version = '0.1.0',
  running = '',
  projects = [{ name: 'todo', imageName: 'sandcastle:todo', onboarded: true }],
  start = 'state\tstarted',
  attach = true,
}: TargetState = {}) => {
  const ran: Ran[] = []
  const attached: string[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      ran.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : '' })
      const ok = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (script.includes('"version"')) return ok(`version\t${version}\n`)
      // The environment file is read with `cat`; the start and stop scripts
      // name it too, as compose's `--env-file`, and are not reads of it.
      if (script.startsWith('cat ') && script.includes('/.env')) return ok(env)
      if (script.includes('/projects')) return ok(JSON.stringify({ projects }))
      if (script.includes('docker ps --filter')) return ok(running)
      if (script.includes('docker image inspect')) return ok(start)
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
    ...(attach
      ? {
          attach: (script: string) => {
            attached.push(script)
            return Promise.resolve(0)
          },
        }
      : {}),
  }
  return { connector, ran, attached }
}

type Pick = { open: string } | { stop: string } | null

const fakePrompter = (pick: Pick) => {
  const asked: string[] = []
  let suspendedDuring = false
  const prompter: Prompter = {
    text: () => Promise.reject(new Error('not asked')),
    secret: () => Promise.reject(new Error('not asked')),
    select: <T>(question: string, choices: readonly Choice<T>[]) => {
      asked.push(question)
      const choice = choices.find(
        (candidate) => JSON.stringify(candidate.value) === JSON.stringify(pick),
      )
      return Promise.resolve((choice ?? choices.at(-1))?.value as T)
    },
    multi: () => Promise.resolve([]),
    confirm: () => Promise.resolve(false),
    suspended: <T>(work: () => Promise<T>) => {
      suspendedDuring = true
      return work()
    },
    close: () => {},
  }
  return { prompter, asked, wasSuspended: () => suspendedDuring }
}

const run = async (pick: Pick, state: TargetState = {}) => {
  const { connector, ran, attached } = fakeConnector(state)
  const { prompter, asked, wasSuspended } = fakePrompter(pick)
  const lines: string[] = []
  const result = await sessionsMenu({ profile, connector, prompter }, (line) => lines.push(line))
  return { result, ran, attached, asked, wasSuspended, shown: lines.join('\n') }
}

describe('sessionsMenu', () => {
  // The gate of ADR 0007: with the toggle off the Target is Run-only, and the
  // action must say where the toggle is rather than start anything.
  it('refuses with a pointer to the toggle when sessions is off', async () => {
    const { result, ran, shown, asked } = await run(
      { open: 'todo' },
      { env: ENV.replace('SESSIONS_ENABLED=true', 'SESSIONS_ENABLED=false') },
    )
    expect(result).toBeUndefined()
    expect(shown).toContain('Sessions are off')
    expect(shown).toContain('Sessions and access')
    expect(asked).toEqual([])
    expect(ran.some((call) => call.script.includes('compose up'))).toBe(false)
  })

  it('says nothing is installed, as status does', async () => {
    const { result, shown } = await run({ open: 'todo' }, { env: '', version: '' })
    expect(result).toBeUndefined()
    expect(shown).toContain('Nothing is installed here')
  })

  it('writes both artifacts, starts the Session, and attaches with the terminal released', async () => {
    const { result, ran, attached, wasSuspended, shown } = await run({ open: 'todo' })
    expect(result).toEqual({ opened: 'todo' })

    const compose = ran.find((call) => call.script.includes('compose.yaml'))
    expect(compose?.stdin).toContain('image: "sandcastle:todo"')
    const dev = ran.find((call) => call.script.includes('devcontainer.json'))
    expect(dev?.stdin).toContain('"service": "session"')

    expect(ran.some((call) => call.script.includes(' up -d'))).toBe(true)
    expect(attached).toEqual([attachScript('todo')])
    expect(wasSuspended()).toBe(true)
    expect(shown).toContain('keeps running')
  })

  // The second open must reuse the container and its tmux server; the start
  // script answers `running` and the attach is the same command either way.
  it('attaches to a running Session rather than starting another', async () => {
    const { attached, shown } = await run(
      { open: 'todo' },
      { running: 'todo\tUp 2 hours\n', start: 'state\trunning' },
    )
    expect(attached).toEqual([attachScript('todo')])
    expect(shown).toContain('Attaching to todo')
    expect(shown).not.toContain('Started')
  })

  it('offers to stop a running Session, and stops it explicitly', async () => {
    const { result, ran, attached } = await run({ stop: 'todo' }, { running: 'todo\tUp 2 hours\n' })
    expect(result).toEqual({ stopped: 'todo' })
    expect(ran.some((call) => call.script.includes(' down'))).toBe(true)
    expect(attached).toEqual([])
  })

  // Attach is a capability. A Connector kind without a terminal leaves the
  // Session running and says how to reach it, rather than failing obscurely.
  it('reports a Connector that cannot attach, with the Session left running', async () => {
    const { result, attached, shown } = await run({ open: 'todo' }, { attach: false })
    expect(result).toEqual({ opened: 'todo' })
    expect(attached).toEqual([])
    expect(shown).toContain('cannot attach a terminal')
    expect(shown).toContain('tmux new-session -A')
  })

  it('surfaces an image that is not built as a sentence, not a compose error', async () => {
    await expect(
      run({ open: 'todo' }, { start: 'error\tThe image sandcastle:todo is not built.' }),
    ).rejects.toThrow(/not built/)
  })

  it('offers only Onboarded Projects', async () => {
    const { result, shown } = await run(
      { open: 'bare' },
      { projects: [{ name: 'bare', imageName: 'sandcastle:bare', onboarded: false }] },
    )
    expect(result).toBeUndefined()
    expect(shown).toContain('No Onboarded Projects')
  })
})

describe('writeSessionArtifacts', () => {
  it('refuses without the docker group, which the socket mount needs', async () => {
    const { connector } = fakeConnector()
    await expect(writeSessionArtifacts(connector, { ...spec, dockerGid: '' })).rejects.toThrow(
      /DOCKER_GID/,
    )
  })

  it('writes the compose file, the init script and the profile beside each other', async () => {
    const { connector, ran } = fakeConnector()
    await writeSessionArtifacts(connector, spec)
    const written = ran
      .filter((call) => call.script.includes("cat > '/home/op/.sandcastle-vps/sessions/todo'/"))
      .map((call) => call.script.split('/').at(-1))
    expect(written).toEqual([
      'compose.yaml',
      'session-init.sh',
      'profile.sh',
      'session-state.sh',
      'tmux.conf',
    ])
    expect(ran.find((call) => call.script.endsWith('session-init.sh'))?.stdin).toBe(sessionInit())
  })
})

describe('applySessions', () => {
  const apply = async (enabled: boolean) => {
    const { connector, ran } = fakeConnector()
    const lines: string[] = []
    await applySessions({ profile, connector }, enabled, (line) => lines.push(line))
    return { ran, shown: lines.join('\n') }
  }

  // The volume is external, so something outside every Session's compose
  // project has to make it: enabling the toggle is that something.
  it('creates the shared login volume when sessions is enabled, and prints the checklist', async () => {
    const { ran, shown } = await apply(true)
    expect(ran.some((call) => call.script === ensureClaudeVolumeScript())).toBe(true)
    expect(shown).toContain(FIRST_TIME)
    expect(shown).toContain('claude auth login')
  })

  // Disabling gates new Sessions; it neither stops running ones nor forgets
  // the login, which would make re-enabling a second first-time setup.
  it('keeps the volume and the running Sessions when sessions is disabled', async () => {
    const { ran, shown } = await apply(false)
    expect(ran).toEqual([])
    expect(shown).toContain('is kept')
    expect(shown).toContain('keep running')
  })
})
