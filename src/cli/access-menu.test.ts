import { describe, expect, it } from 'vitest'
import { addPeer, applyAccess, keypairScript, parseKeypair } from './access-menu.js'
import { parsePeers, renderPeer, type Peer } from './access.js'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import type { Choice, Prompter } from './prompt.js'
import type { TargetProfile } from './profiles.js'
import { readEnv } from './target-env.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps.example.com',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

// Key-shaped, valid base64 for 32 bytes, and obviously not keys.
const PRIVATE = `${'P'.repeat(42)}A=`
const PUBLIC = `${'Q'.repeat(42)}A=`
const SERVER = `${'S'.repeat(42)}A=`
const OTHER = `${'O'.repeat(42)}A=`

const KEYPAIR = `private\t${PRIVATE}\npublic\t${PUBLIC}\nserver\t${SERVER}\n`

const laptop: Peer = {
  name: 'laptop',
  publicKey: OTHER,
  address: '10.13.13.2',
  added: '2026-09-01',
}

interface Call {
  readonly script: string
  readonly stdin?: string
}

interface TargetState {
  readonly env?: string
  readonly peers?: string
  readonly failing?: string
}

const ON = 'ACCESS_ENABLED=true\nACCESS_ENDPOINT=vps.example.com\n'

const fakeConnector = ({ env = ON, peers = '', failing }: TargetState = {}) => {
  const calls: Call[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : undefined })
      const ok = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (failing && script.includes(failing)) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'it broke' })
      }
      if (script.includes('/.env') && script.startsWith('cat ')) return ok(env)
      if (script.includes('peers.conf') && script.startsWith('cat ')) return ok(peers)
      if (script.includes('wg genkey')) return ok(KEYPAIR)
      if (script.includes('qrencode')) return ok('▄▄▄ a qr code ▄▄▄\n')
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, calls }
}

interface Answers {
  readonly name?: string
  readonly how?: 'qr' | 'file'
  readonly endpoint?: string
}

const fakePrompter = ({ name = 'phone', how = 'qr', endpoint }: Answers = {}) => {
  const asked: string[] = []
  const prompter: Prompter = {
    text: (question, fallback) => {
      asked.push(question)
      if (question.startsWith('A name')) return Promise.resolve(name)
      if (question.startsWith('The address')) return Promise.resolve(endpoint ?? fallback ?? '')
      return Promise.resolve(fallback ?? 'typed')
    },
    secret: () => Promise.reject(new Error('nothing here is secret to ask for')),
    select: <T>(question: string, choices: readonly Choice<T>[]) => {
      asked.push(question)
      return Promise.resolve(choices[how === 'qr' ? 0 : 1]?.value as T)
    },
    multi: () => Promise.resolve([]),
    confirm: () => Promise.resolve(true),
    suspended: (work) => work(),
    close: () => {},
  }
  return { prompter, asked }
}

describe('parseKeypair', () => {
  it('reads the three keys the container printed', () => {
    expect(parseKeypair(KEYPAIR)).toEqual({
      privateKey: PRIVATE,
      publicKey: PUBLIC,
      serverPublicKey: SERVER,
    })
  })

  it('refuses an answer that is not three keys', () => {
    expect(() => parseKeypair('private\tnope\n')).toThrow(/Not a WireGuard key/u)
    expect(() => parseKeypair('')).toThrow(/Not a WireGuard key/u)
  })
})

describe('keypairScript', () => {
  // The private key leaves the container on stdout and nowhere else.
  it('generates inside the Access container and never puts a key on a command line', () => {
    const script = keypairScript(profile.installDir)
    expect(script).toContain('wg genkey')
    expect(script).toContain('wg show wg0 public-key')
    expect(script).not.toContain(PRIVATE)
  })
})

describe('applyAccess', () => {
  const lines: string[] = []
  const log = (line: string) => lines.push(line)

  it('asks for the endpoint the first time, seeds it, and brings the service up', async () => {
    const { connector, calls } = fakeConnector({ env: 'ACCESS_ENABLED=true\n' })
    const { prompter, asked } = fakePrompter({ endpoint: 'vps.example.com' })
    await applyAccess({ profile, connector, prompter }, true, log)
    expect(asked.some((question) => question.startsWith('The address'))).toBe(true)
    const env = calls.find((call) => call.script.includes('.env') && call.stdin !== undefined)
    expect(readEnv(env?.stdin ?? '', 'ACCESS_ENDPOINT')).toBe('vps.example.com')
    expect(calls.map((call) => call.script)).toContainEqual(
      expect.stringContaining('compose up -d --build'),
    )
  })

  it('defaults the endpoint to the host in the profile', async () => {
    const { connector, calls } = fakeConnector({ env: 'ACCESS_ENABLED=true\n' })
    const { prompter } = fakePrompter()
    await applyAccess({ profile, connector, prompter }, true, log)
    const env = calls.find((call) => call.script.includes('.env') && call.stdin !== undefined)
    expect(readEnv(env?.stdin ?? '', 'ACCESS_ENDPOINT')).toBe('vps.example.com')
  })

  it('asks nothing when the endpoint is already recorded', async () => {
    const { connector, calls } = fakeConnector()
    const { prompter, asked } = fakePrompter()
    await applyAccess({ profile, connector, prompter }, true, log)
    expect(asked).toEqual([])
    expect(calls.some((call) => call.script.includes('.env') && call.stdin !== undefined)).toBe(
      false,
    )
  })

  // `down` and not `down -v`: the server key is what a Peer config trusts.
  it('takes the service down on disable, keeping the server key', async () => {
    const { connector, calls } = fakeConnector()
    const { prompter } = fakePrompter()
    await applyAccess({ profile, connector, prompter }, false, log)
    const down = calls.find((call) => call.script.includes('compose down'))
    expect(down).toBeDefined()
    expect(down?.script).not.toMatch(/down -v|--volumes/u)
  })
})

const run = async (target: TargetState = {}, answers: Answers = {}) => {
  const { connector, calls } = fakeConnector(target)
  const { prompter, asked } = fakePrompter(answers)
  const lines: string[] = []
  const local: { path: string; content: string }[] = []
  const peer = await addPeer({ profile, connector, prompter }, (line) => lines.push(line), {
    writeLocal: (path, content) => {
      local.push({ path, content })
      return Promise.resolve()
    },
    today: () => '2026-09-26',
  })
  const recorded = calls.find(
    (call) => call.script.includes('peers.conf') && call.stdin !== undefined,
  )
  return { peer, calls, asked, shown: lines.join('\n'), recorded: recorded?.stdin, local }
}

describe('addPeer', () => {
  it('records the Peer on the Target with the public key only, at the next address', async () => {
    const { peer, recorded } = await run()
    expect(peer).toEqual({
      name: 'phone',
      publicKey: PUBLIC,
      address: '10.13.13.2',
      added: '2026-09-26',
    })
    expect(parsePeers(recorded ?? '')).toEqual([peer])
    expect(recorded).not.toContain(PRIVATE)
  })

  it('appends to the Peers already recorded', async () => {
    const { peer, recorded } = await run({ peers: renderPeer(laptop) })
    expect(peer?.address).toBe('10.13.13.3')
    expect(parsePeers(recorded ?? '')).toEqual([laptop, peer])
  })

  it('restarts the service after recording, so the interface picks the Peer up', async () => {
    const { calls } = await run()
    const scripts = calls.map((call) => call.script)
    const recorded = scripts.findIndex((script) => script.includes('mv "$tmp"'))
    const restarted = scripts.findIndex((script) => script.includes('restart access'))
    expect(restarted).toBeGreaterThan(recorded)
  })

  it('shows a QR code holding the config, rendered on the Target', async () => {
    const { calls, shown } = await run({}, { how: 'qr' })
    const qr = calls.find((call) => call.script.includes('qrencode'))
    expect(qr?.stdin).toContain(`PrivateKey = ${PRIVATE}`)
    expect(qr?.stdin).toContain('Endpoint = vps.example.com:51820')
    expect(shown).toContain('a qr code')
  })

  it('writes a config file here, once, when asked for a file', async () => {
    const { local, shown, calls } = await run({}, { how: 'file' })
    expect(local).toHaveLength(1)
    expect(local[0]?.path).toBe('./vps-phone.conf')
    expect(local[0]?.content).toContain(`PrivateKey = ${PRIVATE}`)
    expect(shown).toContain('mode 600')
    expect(calls.some((call) => call.script.includes('qrencode'))).toBe(false)
  })

  // The private key exists for a moment and is then gone: the Target keeps
  // the public half, and nothing on this machine keeps it either.
  it('never puts the private key in a script', async () => {
    const { calls } = await run()
    for (const { script } of calls) expect(script).not.toContain(PRIVATE)
  })

  it('uses the pinned port in the config', async () => {
    const { calls } = await run({ env: `${ON}ACCESS_PORT=51821\n` })
    const qr = calls.find((call) => call.script.includes('qrencode'))
    expect(qr?.stdin).toContain('Endpoint = vps.example.com:51821')
  })

  it('refuses when access is off, pointing at the toggle', async () => {
    const { peer, shown, calls } = await run({ env: 'ACCESS_ENABLED=false\n' })
    expect(peer).toBeUndefined()
    expect(shown).toContain('Access is off')
    expect(calls.some((call) => call.script.includes('wg genkey'))).toBe(false)
  })

  it('refuses a name already recorded rather than adding a second device under it', async () => {
    const { peer, shown, recorded } = await run({ peers: renderPeer(laptop) }, { name: 'laptop' })
    expect(peer).toBeUndefined()
    expect(shown).toContain('already recorded')
    expect(recorded).toBeUndefined()
  })

  it('says the service is not running when the keypair cannot be generated', async () => {
    await expect(run({ failing: 'wg genkey' })).rejects.toThrow(/Access service running/u)
  })
})
