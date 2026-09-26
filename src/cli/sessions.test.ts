import { describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import { PLATFORM_NETWORK } from './network.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import {
  SESSION_LABEL,
  attachScript,
  devcontainer,
  listScript,
  parseSessions,
  sessionCompose,
  sessionProject,
  startScript,
  stopScript,
  writeComposeScript,
  writeDevcontainerScript,
  writeSessionArtifacts,
  type SessionSpec,
} from './session-files.js'
import { sessionsMenu } from './sessions.js'

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
}

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

  // ADR 0010: a session container with the Run token in its environment
  // silently ignores the operator's own login. Credentials are #88's slice,
  // and until then nothing at all is injected.
  it('injects no credential, and never the Run token', () => {
    expect(compose).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(compose).not.toContain('GH_TOKEN')
    expect(compose).not.toContain('AGENT_SIGNING_KEY')
  })

  it('quotes a name a shell or YAML would otherwise read', () => {
    expect(sessionCompose({ ...spec, name: 'my.app' })).toContain('hostname: "my.app"')
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

describe('writeComposeScript', () => {
  it('writes under the install directory, from stdin', () => {
    const script = writeComposeScript('/home/op/.sandcastle-vps', 'todo')
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
    expect(script).toContain('docker compose up -d')
  })

  it('says the image is not built rather than letting compose try to pull it', () => {
    expect(script).toContain("docker image inspect 'sandcastle:todo'")
    expect(script).toContain('is not built')
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
      "cd '/home/op/.sandcastle-vps/sessions/todo' && docker compose down",
    )
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
      if (script.includes('/.env')) return ok(env)
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

    expect(ran.some((call) => call.script.includes('docker compose up -d'))).toBe(true)
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
    expect(ran.some((call) => call.script.includes('docker compose down'))).toBe(true)
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
})
