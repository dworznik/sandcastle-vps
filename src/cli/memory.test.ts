import { describe, expect, it } from 'vitest'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import {
  DATA_DIR_KEY,
  MEMORY_DATA_MOUNT,
  MEMORY_OFF,
  MEMORY_PORT,
  MEMORY_PROJECT,
  MEMORY_SERVICE,
  MEMORY_VOLUME,
  ensureMemoryVolumeScript,
  formatMemory,
  gatherMemory,
  memoryCompose,
  memoryDataDir,
  memoryDown,
  memoryDownScript,
  memoryHealthScript,
  memoryStateScript,
  memoryUp,
  parseHealth,
  writeMemoryFileScript,
} from './memory.js'
import { PLATFORM_NETWORK } from './network.js'
import { CLAUDE_HOME, CLAUDE_VOLUME } from './session-files.js'

const INSTALL_DIR = '/home/op/.sandcastle-vps'

const ON = ['WORKSPACE_ROOT=/home/op/work', 'SESSIONS_ENABLED=true', ''].join('\n')

/** The keys the compose file sets on the container, read the way compose
 *  reads them: the indented `KEY:` lines under `environment:`. */
const environmentKeys = (compose: string): string[] =>
  (compose.split('    environment:\n')[1]?.split(/\n {4}\S/u)[0] ?? '')
    .split('\n')
    .flatMap((line) => {
      const match = /^ {6}([A-Z_]+):/u.exec(line)
      return match?.[1] ? [match[1]] : []
    })

describe('MEMORY_DATA_MOUNT', () => {
  // The plugin's default store is `~/.claude-mem`, beside the config
  // directory the Sessions mount; the two constants must name the same home.
  it('is the plugin’s default, beside the shared login directory', () => {
    expect(MEMORY_DATA_MOUNT).toBe(`${CLAUDE_HOME.replace(/\/\.claude$/u, '')}/.claude-mem`)
  })
})

describe('memoryDataDir', () => {
  it('is the volume when the Local Config says nothing', () => {
    expect(memoryDataDir('')).toBeUndefined()
    expect(memoryDataDir(`${DATA_DIR_KEY}=\n`)).toBeUndefined()
  })

  it('is the directory the operator named, as is', () => {
    expect(memoryDataDir(`${DATA_DIR_KEY}=/home/op/.claude-mem\n`)).toBe('/home/op/.claude-mem')
  })

  // Compose resolves a relative path against the generated file, which is
  // not what `~/.claude-mem` in a hand-edited file meant.
  it('refuses a relative path rather than resolving it somewhere surprising', () => {
    expect(() => memoryDataDir(`${DATA_DIR_KEY}=~/.claude-mem\n`)).toThrow(/absolute path/u)
  })
})

describe('memoryCompose', () => {
  const compose = memoryCompose(INSTALL_DIR)

  it('is a compose project of its own, separate from the stack and the Sessions', () => {
    expect(compose).toContain(`name: ${MEMORY_PROJECT}`)
    expect(MEMORY_PROJECT).not.toBe(PLATFORM_NETWORK)
    expect(compose.match(/^  [a-z]+:\n    build:/gmu)).toHaveLength(1)
  })

  it('joins the platform network by name, and is reached there by service name', () => {
    expect(compose).toContain(`name: ${PLATFORM_NETWORK}\n    external: true`)
    expect(compose).toContain(`  ${MEMORY_SERVICE}:\n`)
    expect(compose).toContain(`hostname: ${MEMORY_SERVICE}`)
  })

  // The forwarder (#93) and the proxy (#94) are the only things that reach
  // the worker; a published port would be a third, on the Target itself.
  it('publishes no port', () => {
    expect(compose).not.toContain('ports:')
  })

  // The whole point: the worker script is the installed plugin's, out of the
  // same volume every Session mounts, so plugin and worker cannot drift.
  it('mounts the shared login volume, external, and points the plugin at it', () => {
    expect(compose).toContain(`- ${CLAUDE_VOLUME}:${CLAUDE_HOME}`)
    expect(compose).toContain(`  ${CLAUDE_VOLUME}:\n    external: true`)
    expect(compose).toContain(`CLAUDE_CONFIG_DIR: ${CLAUDE_HOME}`)
  })

  it('builds the platform image from the delivered package, as the same account the Sessions run as', () => {
    expect(compose).toContain(`context: "${INSTALL_DIR}/docker/memory"`)
    expect(compose).toContain('OPERATOR_UID: ${OPERATOR_UID:?')
    expect(compose).toContain('OPERATOR_GID: ${OPERATOR_GID:?')
  })

  // Unattended, like a Run: the worker summarises with the claude CLI and an
  // OAuth flow has nowhere to happen (ADR 0010).
  it('gives the worker the Run token under the name Claude Code reads, filled at up', () => {
    expect(environmentKeys(compose)).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(compose).toContain('CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}')
    expect(compose).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN: [^$]/u)
  })

  // Every CLAUDE_MEM_* variable overrides the plugin's settings file, which
  // is what lets a store carried over from claude-tmux — whose settings name
  // that container's paths — run here unchanged.
  it('binds the worker to every interface in its namespace, on its own port, over its settings file', () => {
    expect(compose).toContain('CLAUDE_MEM_WORKER_HOST: 0.0.0.0')
    expect(compose).toContain(`CLAUDE_MEM_WORKER_PORT: "${MEMORY_PORT}"`)
    expect(compose).toContain(`CLAUDE_MEM_DATA_DIR: ${MEMORY_DATA_MOUNT}`)
  })

  it('keeps the store in the named volume, external, when no directory is set', () => {
    expect(compose).toContain(`- ${MEMORY_VOLUME}:${MEMORY_DATA_MOUNT}`)
    expect(compose).toContain(`  ${MEMORY_VOLUME}:\n    external: true`)
  })

  it('mounts the directory the operator named as the store, as is, and declares no volume for it', () => {
    const own = memoryCompose(INSTALL_DIR, '/home/op/.claude-mem')
    expect(own).toContain(`"/home/op/.claude-mem:${MEMORY_DATA_MOUNT}"`)
    expect(own).not.toContain(`${MEMORY_VOLUME}:`)
  })

  it('comes back after a restart of the Target', () => {
    expect(compose).toContain('restart: unless-stopped')
  })
})

describe('scripts', () => {
  it('runs compose with the Target’s environment file, where the uid and the token are', () => {
    expect(memoryStateScript(INSTALL_DIR)).toContain(`--env-file '${INSTALL_DIR}/.env'`)
    expect(memoryDownScript(INSTALL_DIR)).toContain(`--env-file '${INSTALL_DIR}/.env'`)
  })

  it('moves the compose file into place rather than writing over it', () => {
    const script = writeMemoryFileScript(INSTALL_DIR, 'compose.yaml')
    expect(script).toContain('cat > "$tmp"')
    expect(script).toMatch(/mv "\$tmp" '[^']*\/memory\/compose\.yaml'/u)
  })

  it('creates the store volume only when it is not there', () => {
    expect(ensureMemoryVolumeScript()).toContain(`docker volume inspect ${MEMORY_VOLUME}`)
    expect(ensureMemoryVolumeScript()).toContain(`|| docker volume create ${MEMORY_VOLUME}`)
  })

  // The criterion: the health endpoint answers over the platform network by
  // service name — so it is asked from a container on that network, not
  // from the Target's shell, which is not.
  it('asks the worker’s health over the platform network, by service name', () => {
    const script = memoryHealthScript(INSTALL_DIR)
    expect(script).toContain(`--network ${PLATFORM_NETWORK}`)
    expect(script).toContain(`http://${MEMORY_SERVICE}:${MEMORY_PORT}/api/health`)
    expect(script).toContain('--rm')
  })

  it('tolerates a service that was never brought up, on down', () => {
    expect(memoryDownScript(INSTALL_DIR)).toContain('[ -f compose.yaml ] || exit 0')
    expect(memoryDownScript(INSTALL_DIR)).not.toContain('down -v')
  })
})

describe('parseHealth', () => {
  it('reads the version the worker reports, which is the version it runs', () => {
    expect(parseHealth('{"status":"ok","version":"10.6.2","pid":12}\n')).toEqual({
      ok: true,
      version: '10.6.2',
    })
  })

  it('is not ok for anything but the worker’s own answer', () => {
    expect(parseHealth('')).toEqual({ ok: false })
    expect(parseHealth('curl: (6) Could not resolve host')).toEqual({ ok: false })
    expect(parseHealth('{"status":"initializing"}')).toEqual({ ok: false, version: undefined })
  })
})

// -------------------------------------------------------------- up and down

interface Ran {
  readonly script: string
  readonly stdin: string
}

const fakeConnector = (
  { state = '', health = '' }: { state?: string; health?: string } = {},
  overrides: Partial<Record<string, ExecResult>> = {},
) => {
  const ran: Ran[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      ran.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : '' })
      for (const [fragment, result] of Object.entries(overrides)) {
        if (result && script.includes(fragment)) return Promise.resolve(result)
      }
      const ok = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (script.includes('/api/health')) return ok(health)
      if (script.includes("ps --format '{{.Service}}")) return ok(state)
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, ran }
}

const silent = () => {}

describe('memoryUp', () => {
  it('writes the compose file, makes the volume, and builds and starts the service', async () => {
    const { connector, ran } = fakeConnector()
    await memoryUp(connector, INSTALL_DIR, ON, silent)
    const written = ran.find((call) => call.script.includes('memory/compose.yaml'))
    expect(written?.stdin).toContain(`name: ${MEMORY_PROJECT}`)
    expect(ran.map((call) => call.script)).toContainEqual(ensureMemoryVolumeScript())
    expect(ran.map((call) => call.script)).toContainEqual(
      expect.stringContaining(`cd '${INSTALL_DIR}/memory' && docker compose --env-file`),
    )
    expect(ran.at(-1)?.script).toContain('up -d --build')
  })

  // An existing directory is used as is: no volume is made for it, and the
  // compose file bind-mounts it.
  it('uses the operator’s directory as is, and makes no volume', async () => {
    const { connector, ran } = fakeConnector()
    await memoryUp(connector, INSTALL_DIR, `${ON}${DATA_DIR_KEY}=/home/op/.claude-mem\n`, silent)
    expect(ran.map((call) => call.script)).not.toContainEqual(ensureMemoryVolumeScript())
    expect(ran.find((call) => call.stdin !== '')?.stdin).toContain('/home/op/.claude-mem:')
  })

  it('stops rather than starting a service it could not configure', async () => {
    const { connector } = fakeConnector(
      {},
      { mktemp: { code: 1, stdout: '', stderr: 'Read-only file system' } },
    )
    await expect(memoryUp(connector, INSTALL_DIR, ON, silent)).rejects.toThrow(/Read-only/u)
  })

  it('refuses a relative store path before writing anything', async () => {
    const { connector, ran } = fakeConnector()
    await expect(
      memoryUp(connector, INSTALL_DIR, `${ON}${DATA_DIR_KEY}=data\n`, silent),
    ).rejects.toThrow(/absolute path/u)
    expect(ran).toEqual([])
  })
})

describe('memoryDown', () => {
  it('stops the service and keeps the store', async () => {
    const { connector, ran } = fakeConnector()
    await memoryDown(connector, INSTALL_DIR)
    expect(ran).toHaveLength(1)
    expect(ran[0]?.script).toContain('docker compose --env-file')
    expect(ran[0]?.script).toContain(' down')
    expect(ran[0]?.script).not.toContain('down -v')
  })
})

// --------------------------------------------------------------------- status

describe('gatherMemory', () => {
  it('reads off when sessions is off, and asks the worker nothing', async () => {
    const { connector, ran } = fakeConnector({ state: '' })
    const status = await gatherMemory(connector, INSTALL_DIR, 'SESSIONS_ENABLED=false\n')
    expect(status).toMatchObject(MEMORY_OFF)
    expect(ran.some((call) => call.script.includes('/api/health'))).toBe(false)
  })

  it('reports a running worker with the version it answered', async () => {
    const { connector } = fakeConnector({
      state: 'memory\trunning\n',
      health: '{"status":"ok","version":"10.6.2"}',
    })
    const status = await gatherMemory(connector, INSTALL_DIR, ON)
    expect(status).toEqual({
      enabled: true,
      service: 'memory\trunning',
      health: { ok: true, version: '10.6.2' },
      dataDir: undefined,
    })
  })

  it('does not probe a service that is not running', async () => {
    const { connector, ran } = fakeConnector({ state: '' })
    const status = await gatherMemory(connector, INSTALL_DIR, ON)
    expect(status.health).toEqual({ ok: false })
    expect(ran.some((call) => call.script.includes('/api/health'))).toBe(false)
  })

  it('reports the store the operator named', async () => {
    const { connector } = fakeConnector()
    const status = await gatherMemory(
      connector,
      INSTALL_DIR,
      `${ON}${DATA_DIR_KEY}=/home/op/.claude-mem\n`,
    )
    expect(status.dataDir).toBe('/home/op/.claude-mem')
  })
})

describe('formatMemory', () => {
  const running = {
    enabled: true,
    service: 'memory\trunning',
    health: { ok: true, version: '10.6.2' },
  }

  it('says off, and why, on a Run-only Target', () => {
    expect(formatMemory(MEMORY_OFF).join('\n')).toContain('off — comes up with sessions')
  })

  it('names the version the worker runs and where it answers', () => {
    const said = formatMemory(running).join('\n')
    expect(said).toContain('claude-mem 10.6.2')
    expect(said).toContain(`${MEMORY_SERVICE}:${MEMORY_PORT}`)
    expect(said).toContain(MEMORY_VOLUME)
  })

  // The criterion: a Target where the plugin is not installed yet says so
  // plainly. The service is up — the entrypoint waits — and the worker is not
  // answering, and the difference is what the operator needs to hear.
  it('points at installing the plugin when the service is up but the worker is silent', () => {
    const said = formatMemory({ ...running, health: { ok: false } }).join('\n')
    expect(said).toContain('not answering')
    expect(said).toContain('claude plugin install claude-mem@thedotmack')
  })

  it('says when the service is not running at all', () => {
    expect(formatMemory({ ...running, service: '' }).join('\n')).toContain('not running')
  })

  it('names the operator’s own store', () => {
    expect(formatMemory({ ...running, dataDir: '/home/op/.claude-mem' }).join('\n')).toContain(
      '/home/op/.claude-mem',
    )
  })

  it('flags a service left up after sessions was turned off', () => {
    expect(formatMemory({ ...MEMORY_OFF, service: 'memory\trunning' }).join('\n')).toContain(
      'still up',
    )
  })
})
