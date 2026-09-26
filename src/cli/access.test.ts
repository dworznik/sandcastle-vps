import { describe, expect, it } from 'vitest'
import {
  ACCESS_PROJECT,
  EXPOSED_SERVICES,
  TUNNEL_ADDRESS,
  TUNNEL_SUBNET,
  WIREGUARD_PORT,
  accessCompose,
  accessDownScript,
  accessPort,
  accessStateScript,
  accessUp,
  endpointFrom,
  ensurePeersFileScript,
  expose,
  formatAccess,
  gatherAccess,
  nextPeerAddress,
  parsePeers,
  parseUdpTables,
  peerConfig,
  renderPeer,
  validateKey,
  validatePeerName,
  writeAccessFileScript,
  type AccessStatus,
  type Peer,
} from './access.js'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import { PLATFORM_NETWORK } from './network.js'

const INSTALL_DIR = '/home/op/.sandcastle-vps'

// Key-shaped and valid base64 for 32 bytes, but obviously not keys: the
// secret scanner reads a high-entropy value next to the word "key" as one.
const KEY_A = `${'A'.repeat(42)}A=`
const KEY_B = `${'B'.repeat(42)}A=`
const KEY_S = `${'S'.repeat(42)}A=`

const phone: Peer = { name: 'phone', publicKey: KEY_A, address: '10.13.13.2', added: '2026-09-26' }
const laptop: Peer = {
  name: 'laptop',
  publicKey: KEY_B,
  address: '10.13.13.3',
  added: '2026-09-26',
}

describe('expose', () => {
  it('writes one service:port per Exposed Service', () => {
    expect(expose(EXPOSED_SERVICES)).toContain('inngest:8288\n')
  })

  // The criterion this exists for: the Dispatch surface is keyless by design,
  // and it is the one endpoint that does work on the operator's behalf.
  it.each([3000, 3399, 80])('refuses the Dispatch surface on port %i', (port) => {
    expect(() => expose([{ label: 'Dispatch', service: 'harness', port }])).toThrow(
      /Dispatch surface .* can never be exposed/u,
    )
  })

  it('refuses rather than filters, so a mistake in the list is loud', () => {
    expect(() =>
      expose([...EXPOSED_SERVICES, { label: 'x', service: 'harness', port: 3000 }]),
    ).toThrow()
  })

  it('refuses a service name that is not one, before it reaches an iptables rule', () => {
    expect(() => expose([{ label: 'x', service: 'inngest; rm -rf /', port: 8288 }])).toThrow(
      /Not a compose service name/u,
    )
    expect(() => expose([{ label: 'x', service: 'inngest', port: 70000 }])).toThrow(/Not a port/u)
  })

  it('exposes nothing but the Orchestrator dashboard on day one', () => {
    expect(EXPOSED_SERVICES.map((service) => `${service.service}:${service.port}`)).toEqual([
      'inngest:8288',
    ])
  })
})

describe('accessCompose', () => {
  const compose = accessCompose(INSTALL_DIR, 51820)

  it('is its own compose project, joined to the platform network', () => {
    expect(compose).toContain(`name: ${ACCESS_PROJECT}`)
    expect(compose).toMatch(new RegExp(`name: ${PLATFORM_NETWORK}\\n\\s+external: true`, 'u'))
  })

  // The one intended public listener, and UDP so the exposure check — which
  // reads TCP listen tables — is unchanged.
  it('publishes the WireGuard port on every interface, as UDP', () => {
    expect(compose).toContain('"51820:51820/udp"')
    expect(accessCompose(INSTALL_DIR, 51821)).toContain('"51821:51820/udp"')
  })

  it('keeps the server key in a named volume, so it survives down and up', () => {
    expect(compose).toContain('access_keys:/etc/wireguard')
    expect(compose).toMatch(/volumes:\n\s+access_keys:/u)
  })

  it('mounts the CLI-written files read-only at absolute paths', () => {
    expect(compose).toContain(`"${INSTALL_DIR}/access/peers.conf:/config/peers.conf:ro"`)
    expect(compose).toContain(`"${INSTALL_DIR}/access/allowlist:/config/allowlist:ro"`)
  })

  it('builds from the image the package delivers', () => {
    expect(compose).toContain(`context: "${INSTALL_DIR}/docker/access"`)
  })

  it('quotes an install directory an operator could have chosen', () => {
    expect(accessCompose("/home/o'brien/x", 51820)).toContain(`"/home/o'brien/x/docker/access"`)
  })
})

describe('accessPort', () => {
  it('takes a pinned port and falls back to WireGuard’s own', () => {
    expect(accessPort('ACCESS_PORT=51821\n')).toBe(51821)
    expect(accessPort('')).toBe(WIREGUARD_PORT)
    expect(accessPort('ACCESS_PORT=abc\n')).toBe(WIREGUARD_PORT)
  })
})

describe('peers.conf', () => {
  it('round-trips a Peer through the file the entrypoint reads', () => {
    expect(parsePeers(renderPeer(phone))).toEqual([phone])
    expect(parsePeers(renderPeer(phone) + renderPeer(laptop))).toEqual([phone, laptop])
  })

  it('renders a section wg-quick accepts', () => {
    expect(renderPeer(phone)).toBe(
      `# peer: phone, added 2026-09-26\n[Peer]\nPublicKey = ${KEY_A}\nAllowedIPs = 10.13.13.2/32\n`,
    )
  })

  it('reads an empty file as no Peers', () => {
    expect(parsePeers('')).toEqual([])
    expect(parsePeers('\n')).toEqual([])
  })

  // The file is the CLI's. A section it did not write is reported rather than
  // silently counted or silently dropped: either would misstate who can reach
  // the Target.
  it('refuses a section without the CLI’s header', () => {
    expect(() => parsePeers(`[Peer]\nPublicKey = ${KEY_A}\nAllowedIPs = 10.13.13.9/32\n`)).toThrow(
      /without the CLI/u,
    )
  })

  it('refuses a section with a key and no address', () => {
    expect(() => parsePeers(`# peer: x, added 2026-09-26\n[Peer]\nPublicKey = ${KEY_A}\n`)).toThrow(
      /incomplete/u,
    )
  })
})

describe('nextPeerAddress', () => {
  it('starts at .2, because .1 is the server', () => {
    expect(nextPeerAddress([])).toBe('10.13.13.2')
  })

  it('fills the lowest gap, so a revoked address is reused', () => {
    expect(nextPeerAddress([laptop])).toBe('10.13.13.2')
    expect(nextPeerAddress([phone, laptop])).toBe('10.13.13.4')
  })

  it('stops at the end of the subnet', () => {
    const full = Array.from({ length: 253 }, (_, index) => ({
      ...phone,
      address: `10.13.13.${index + 2}`,
    }))
    expect(() => nextPeerAddress(full)).toThrow(/no free address/u)
  })
})

describe('peerConfig', () => {
  const config = peerConfig({
    privateKey: KEY_B,
    address: '10.13.13.2',
    serverPublicKey: KEY_S,
    endpoint: 'vps.example.com',
    port: 51820,
  })

  it('is a stock WireGuard client config', () => {
    expect(config).toContain('[Interface]')
    expect(config).toContain(`PrivateKey = ${KEY_B}`)
    expect(config).toContain('Address = 10.13.13.2/32')
    expect(config).toContain(`PublicKey = ${KEY_S}`)
    expect(config).toContain('Endpoint = vps.example.com:51820')
  })

  // The Peer routes only the tunnel: the device's other traffic is untouched,
  // and nothing on the Target but the allowlist is reachable anyway.
  it('routes the tunnel subnet and nothing else', () => {
    expect(config).toContain(`AllowedIPs = ${TUNNEL_SUBNET}`)
    expect(config).not.toContain('0.0.0.0/0')
  })

  it('keeps the tunnel alive through a phone’s NAT', () => {
    expect(config).toContain('PersistentKeepalive = 25')
  })
})

describe('endpointFrom', () => {
  it('takes the host out of an ssh destination', () => {
    expect(endpointFrom('op@vps.example.com')).toBe('vps.example.com')
    expect(endpointFrom('vps.example.com:2222')).toBe('vps.example.com')
    expect(endpointFrom('203.0.113.7')).toBe('203.0.113.7')
  })
})

describe('validatePeerName', () => {
  it('accepts a device name and refuses one that is not a file name', () => {
    expect(validatePeerName('my-phone')).toBe('my-phone')
    expect(() => validatePeerName('My Phone')).toThrow(/Invalid Peer name/u)
    expect(() => validatePeerName('../x')).toThrow(/Invalid Peer name/u)
  })
})

describe('validateKey', () => {
  it('accepts a base64 32-byte key and refuses anything else, before it reaches wg-quick', () => {
    expect(validateKey(`${KEY_A}\n`, 'public')).toBe(KEY_A)
    expect(() => validateKey('not a key', 'public')).toThrow(/Not a WireGuard key/u)
    expect(() => validateKey(`${KEY_A}\nPrivateKey = x`, 'public')).toThrow()
  })
})

describe('scripts', () => {
  it('writes an Access file the way the environment file is written', () => {
    const script = writeAccessFileScript(INSTALL_DIR, 'allowlist')
    expect(script).toContain('umask 077')
    expect(script).toContain('cat > "$tmp"')
    expect(script).toContain(`mv "$tmp" '${INSTALL_DIR}/access/allowlist'`)
  })

  // A bind mount of a missing file makes Docker create a directory there.
  it('creates peers.conf empty when it is missing and leaves it alone otherwise', () => {
    const script = ensurePeersFileScript(INSTALL_DIR)
    expect(script).toContain(`[ -f '${INSTALL_DIR}/access/peers.conf' ] ||`)
    expect(script).not.toContain('cat >')
  })

  // A toggle set by hand, or an enable whose `up` failed early, leaves no
  // compose file; disabling then has nothing to stop and must not fail.
  it('takes the service down, and does nothing where it was never brought up', () => {
    const script = accessDownScript(INSTALL_DIR)
    expect(script).toContain('docker compose down')
    expect(script).not.toMatch(/down -v|--volumes/u)
    expect(script).toContain('[ -f compose.yaml ] || exit 0')
    expect(script).toContain('|| exit 0')
  })

  it('reads the service state without starting it', () => {
    expect(accessStateScript(INSTALL_DIR)).toContain('compose ps')
    expect(accessStateScript(INSTALL_DIR)).not.toContain('up')
  })

  it('quotes the install directory', () => {
    expect(writeAccessFileScript("/home/o'brien/x", 'allowlist')).toContain(
      "'/home/o'\\''brien/x/access'",
    )
  })
})

describe('parseUdpTables', () => {
  const row = (local: string): string =>
    `   0: ${local} 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 12345 2 0000000000000000 0`

  it('reads both tables', () => {
    const stdout = `  sl  local_address\n${row('00000000:CA6C')}\n=====\n${row(
      '00000000000000000000000000000000:CA6C',
    )}\n`
    expect(parseUdpTables(stdout).map((l) => l.address)).toEqual(['0.0.0.0', '::'])
  })
})

// ------------------------------------------------------------- with a Target

interface Call {
  readonly script: string
  readonly stdin?: string
}

interface TargetState {
  readonly peers?: string
  readonly service?: string
  readonly udp?: string
  readonly failing?: string
}

const BOUND = `  sl  local_address\n   0: 00000000:CA6C 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 1 2 0 0\n=====\n`

const fakeConnector = (state: TargetState = {}) => {
  const calls: Call[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string, opts?: ExecOptions): Promise<ExecResult> => {
      calls.push({ script, stdin: typeof opts?.stdin === 'string' ? opts.stdin : undefined })
      const ok = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (state.failing && script.includes(state.failing)) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'it broke' })
      }
      if (script.includes('peers.conf') && script.startsWith('cat ')) return ok(state.peers ?? '')
      if (script.includes('compose ps')) return ok(state.service ?? 'access\trunning\n')
      if (script.includes('/proc/net/udp')) return ok(state.udp ?? BOUND)
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, calls }
}

const ENABLED = 'ACCESS_ENABLED=true\nACCESS_ENDPOINT=vps.example.com\n'

describe('accessUp', () => {
  it('writes the compose file and the allowlist, then builds and starts the service', async () => {
    const { connector, calls } = fakeConnector()
    await accessUp(connector, INSTALL_DIR, ENABLED, () => {})
    const written = calls.filter((call) => call.stdin !== undefined)
    expect(written.map((call) => call.script)).toEqual([
      expect.stringContaining('access/compose.yaml'),
      expect.stringContaining('access/allowlist'),
    ])
    expect(written[0]?.stdin).toContain(`name: ${ACCESS_PROJECT}`)
    expect(written[1]?.stdin).toContain('inngest:8288')
    const scripts = calls.map((call) => call.script)
    const peers = scripts.findIndex((script) => script.includes('[ -f'))
    const up = scripts.findIndex((script) => script.includes('compose up -d --build'))
    expect(peers).toBeGreaterThanOrEqual(0)
    expect(up).toBeGreaterThan(peers)
  })

  it('never touches the environment file or the stack', async () => {
    const { connector, calls } = fakeConnector()
    await accessUp(connector, INSTALL_DIR, ENABLED, () => {})
    for (const { script } of calls) {
      expect(script).not.toContain('/.env')
      expect(script).not.toContain(`cd '${INSTALL_DIR}' &&`)
    }
  })

  it('stops rather than starting a service it could not configure', async () => {
    const { connector, calls } = fakeConnector({ failing: 'access/allowlist' })
    await expect(accessUp(connector, INSTALL_DIR, ENABLED, () => {})).rejects.toThrow(/it broke/u)
    expect(calls.map((call) => call.script)).not.toContainEqual(
      expect.stringContaining('compose up'),
    )
  })
})

describe('gatherAccess', () => {
  it('reads the toggle, the endpoint, the Peers, the service and the UDP listener', async () => {
    const { connector, calls } = fakeConnector({ peers: renderPeer(phone) })
    const status = await gatherAccess(connector, INSTALL_DIR, ENABLED)
    expect(status).toMatchObject({
      enabled: true,
      endpoint: 'vps.example.com',
      port: 51820,
      peers: [phone],
      service: 'access\trunning',
    })
    expect(status.listening).toEqual([{ address: '0.0.0.0', port: 51820, loopback: false }])
    for (const { script } of calls) {
      expect(script).not.toContain('up ')
      expect(script).not.toContain('down')
      expect(script).not.toContain('restart')
    }
  })

  it('reads a fresh Target as access off with nothing listening', async () => {
    const { connector } = fakeConnector({ service: '', udp: '' })
    expect(await gatherAccess(connector, INSTALL_DIR, '')).toMatchObject({
      enabled: false,
      peers: [],
      service: '',
      listening: [],
    })
  })

  it('keeps reporting when peers.conf cannot be read', async () => {
    const { connector } = fakeConnector({ peers: '[Peer]\nPublicKey = x\n' })
    const status = await gatherAccess(connector, INSTALL_DIR, ENABLED)
    expect(status.peersError).toContain('without the CLI')
    expect(status.enabled).toBe(true)
  })
})

describe('formatAccess', () => {
  const on: AccessStatus = {
    enabled: true,
    endpoint: 'vps.example.com',
    port: 51820,
    peers: [phone],
    service: 'access\trunning',
    listening: [{ address: '0.0.0.0', port: 51820, loopback: false }],
  }

  it('names the WireGuard UDP port as the one intended public listener', () => {
    const said = formatAccess(on).join('\n')
    expect(said).toContain('udp/51820')
    expect(said).toContain('the one intended public listener')
    expect(said).toContain('vps.example.com:51820')
  })

  it('lists the Peers and where the Exposed Services are', () => {
    const said = formatAccess(on).join('\n')
    expect(said).toContain('phone')
    expect(said).toContain('10.13.13.2')
    expect(said).toContain(`http://${TUNNEL_ADDRESS}:8288`)
  })

  it('says when access is on but nothing is listening', () => {
    const said = formatAccess({ ...on, service: '', listening: [] }).join('\n')
    expect(said).toContain('not running')
    expect(said).toContain('not listening')
  })

  it('reads a fresh Target as off, in one line', () => {
    expect(formatAccess({ ...on, enabled: false, service: '', peers: [] })).toEqual(['  off'])
  })

  // Disabling stops the service; a service still up with the toggle off is a
  // state nothing here produces, and the report says so rather than hiding it.
  it('flags a service still up after access was disabled', () => {
    expect(formatAccess({ ...on, enabled: false }).join('\n')).toContain('still up')
  })
})
