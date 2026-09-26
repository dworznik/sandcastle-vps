import { describe, expect, it } from 'vitest'
import {
  ACCESS_PROJECT,
  EXPOSED_SERVICES,
  MEMORY_UI,
  accessRefresh,
  accessRestartScript,
  exposedServices,
  TUNNEL_ADDRESS,
  TUNNEL_SUBNET,
  WIREGUARD_PORT,
  accessCompose,
  accessDownScript,
  accessPort,
  accessStateScript,
  accessUp,
  ddclientConf,
  defaultDnsNames,
  dnsRecordScript,
  endpointFrom,
  exposedAt,
  parseDnsRecord,
  peerEndpoint,
  readDns,
  validateDnsName,
  ensurePeersFileScript,
  expose,
  formatAccess,
  gatherAccess,
  nextPeerAddress,
  parsePeers,
  parseUdpTables,
  peerConfig,
  removePeerScript,
  renderPeer,
  renderPeersFile,
  validateKey,
  validatePeerName,
  writeAccessFileScript,
  type AccessDns,
  type AccessStatus,
  type Peer,
} from './access.js'
import type { Connector, ExecOptions, ExecResult } from './connectors/types.js'
import { MEMORY_PORT, MEMORY_SERVICE } from './memory.js'
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

const dns: AccessDns = {
  zone: 'example.com',
  publicName: 'vps.example.com',
  internalName: 'vps.in.example.com',
}
// Token-shaped enough to be handled like one, low-entropy enough that the
// secret scanner does not read a fixture as a leak.
const CF_TOKEN = 'cf-token-fixture-not-real'
const WITH_DNS = `ACCESS_ENABLED=true\nACCESS_ENDPOINT=203.0.113.7\nACCESS_DNS_ZONE=example.com\nACCESS_PUBLIC_NAME=vps.example.com\nACCESS_INTERNAL_NAME=vps.in.example.com\nCLOUDFLARE_API_TOKEN=${CF_TOKEN}\n`

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

  it('exposes nothing but the Orchestrator dashboard on a Run-only Target', () => {
    expect(EXPOSED_SERVICES.map((service) => `${service.service}:${service.port}`)).toEqual([
      'inngest:8288',
    ])
    expect(exposedServices('ACCESS_ENABLED=true\n')).toEqual(EXPOSED_SERVICES)
  })

  // The worker's origin check refuses writes from anywhere but loopback, so
  // what is exposed is the proxy that rewrites the Origin header (ADR 0010),
  // and never the worker: listing it would be a read-only UI at best.
  it('refuses the Memory worker itself, on any port', () => {
    expect(() => expose([{ label: 'x', service: MEMORY_SERVICE, port: MEMORY_PORT }])).toThrow(
      /Memory worker .* never exposed/u,
    )
    expect(() => expose([{ label: 'x', service: MEMORY_SERVICE, port: 80 }])).toThrow()
  })
})

describe('MEMORY_UI', () => {
  it('is the proxy in front of the worker, on the worker’s port, and not the worker', () => {
    expect(MEMORY_UI.service).not.toBe(MEMORY_SERVICE)
    expect(MEMORY_UI.port).toBe(MEMORY_PORT)
    expect(expose([MEMORY_UI])).toContain(`${MEMORY_UI.service}:${MEMORY_PORT}\n`)
  })
})

describe('exposedServices', () => {
  // The Memory UI follows the sessions toggle, not the access toggle: Memory
  // comes up with sessions (ADR 0010), and an allowlist entry for a service
  // that is not there would be a rule pointing at nothing.
  it('adds the Memory UI when sessions is on, after the dashboard', () => {
    expect(exposedServices('SESSIONS_ENABLED=true\nACCESS_ENABLED=true\n')).toEqual([
      ...EXPOSED_SERVICES,
      MEMORY_UI,
    ])
  })

  it('lists the Memory UI by the proxy and never the worker, in the allowlist', () => {
    const allowlist = expose(exposedServices('SESSIONS_ENABLED=true\n'))
    expect(allowlist).toContain(`${MEMORY_UI.service}:${MEMORY_PORT}\n`)
    expect(allowlist).not.toContain(`${MEMORY_SERVICE}:`)
  })

  it('drops the Memory UI when sessions is off', () => {
    expect(exposedServices('SESSIONS_ENABLED=false\n')).toEqual(EXPOSED_SERVICES)
    expect(exposedAt(exposedServices(''))).toEqual([
      `Orchestrator dashboard: http://${TUNNEL_ADDRESS}:8288`,
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

describe('accessCompose with DNS', () => {
  it('adds the ddclient service, reading the config the CLI writes, only with a domain', () => {
    const withDns = accessCompose(INSTALL_DIR, WIREGUARD_PORT, dns)
    expect(withDns).toContain('ddclient:')
    expect(withDns).toContain('dockerfile: ddclient.Dockerfile')
    expect(withDns).toContain(`${INSTALL_DIR}/access/ddclient.conf:/config/ddclient.conf:ro`)
    expect(accessCompose(INSTALL_DIR, WIREGUARD_PORT)).not.toContain('ddclient')
  })
})

describe('readDns', () => {
  it('reads the three names, and nothing when any is missing', () => {
    expect(readDns(WITH_DNS)).toEqual(dns)
    expect(readDns('ACCESS_DNS_ZONE=example.com\n')).toBeUndefined()
    expect(readDns('')).toBeUndefined()
  })
})

describe('defaultDnsNames', () => {
  it('names the Target under the zone, and the tunnel address under in.', () => {
    expect(defaultDnsNames('vps', 'example.com')).toEqual({
      publicName: 'vps.example.com',
      internalName: 'vps.in.example.com',
    })
  })
})

describe('validateDnsName', () => {
  it('accepts a hostname and refuses anything that is not one', () => {
    expect(validateDnsName('vps.in.example.com')).toBe('vps.in.example.com')
    expect(validateDnsName(' VPS.Example.com ')).toBe('vps.example.com')
    expect(() => validateDnsName('vps')).toThrow(/Not a DNS name/u)
    expect(() => validateDnsName('a b.example.com')).toThrow(/Not a DNS name/u)
    expect(() => validateDnsName('x;.example.com')).toThrow(/Not a DNS name/u)
  })
})

describe('ddclientConf', () => {
  it('keeps the public record current through the Cloudflare API, with the token in the file', () => {
    const conf = ddclientConf(dns, CF_TOKEN)
    expect(conf).toContain('protocol=cloudflare')
    expect(conf).toContain('zone=example.com')
    expect(conf).toContain('login=token')
    expect(conf).toContain(`password=${CF_TOKEN}`)
    expect(conf).toMatch(/\nvps\.example\.com\n$/u)
    // ddclient 3.11 retired `use=web`/`web-skip`; these are the current names.
    expect(conf).toContain('usev4=webv4')
    expect(conf).toContain("webv4=https://cloudflare.com/cdn-cgi/trace, webv4-skip='ip='")
  })
})

describe('dnsRecordScript', () => {
  // The token is on stdin. The names are not secrets, so they may be
  // arguments — quoted, because they came from the operator.
  it('runs the record writer inside the Access container with the token on stdin only', () => {
    const script = dnsRecordScript(INSTALL_DIR, dns.zone, dns.internalName, TUNNEL_ADDRESS)
    expect(script).toContain('exec -T access /dns-record.sh')
    expect(script).toContain("'example.com' 'vps.in.example.com' '10.13.13.1'")
    expect(script).not.toContain(CF_TOKEN)
  })

  it('refuses a name that is not one, before it reaches the API', () => {
    expect(() => dnsRecordScript(INSTALL_DIR, dns.zone, 'nope', 'auto')).toThrow(/Not a DNS name/u)
  })

  it('reads what the writer reported', () => {
    expect(parseDnsRecord('record\tvps.example.com\tcreated\t203.0.113.7\n')).toEqual({
      name: 'vps.example.com',
      action: 'created',
      content: '203.0.113.7',
    })
    expect(() => parseDnsRecord('')).toThrow(/did not report/u)
  })
})

describe('peerEndpoint and exposedAt with DNS', () => {
  it('names the Target by its public name once DNS is configured, and by address before', () => {
    expect(peerEndpoint(WITH_DNS)).toBe('vps.example.com')
    expect(peerEndpoint('ACCESS_ENDPOINT=203.0.113.7\n')).toBe('203.0.113.7')
    expect(peerEndpoint('')).toBeUndefined()
  })

  it('prints Exposed Services by internal name and port, and by address without DNS', () => {
    expect(exposedAt(EXPOSED_SERVICES, dns)).toEqual([
      'Orchestrator dashboard: http://vps.in.example.com:8288',
    ])
    expect(exposedAt()).toEqual([`Orchestrator dashboard: http://${TUNNEL_ADDRESS}:8288`])
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

describe('renderPeersFile', () => {
  // Revocation rewrites the whole file from the Peers that remain, so the
  // rendering has to be exactly what the parser reads back.
  it('round-trips every Peer, with a blank line between sections', () => {
    const file = renderPeersFile([phone, laptop])
    expect(parsePeers(file)).toEqual([phone, laptop])
    expect(file).toContain('/32\n\n# peer: laptop')
  })

  it('renders no Peers as an empty file', () => {
    expect(renderPeersFile([])).toBe('')
    expect(parsePeers(renderPeersFile([]))).toEqual([])
  })
})

describe('removePeerScript', () => {
  // Immediate: the Peer is dropped from the running interface rather than
  // waiting for a restart, so its config stops connecting at once and the
  // other Peers' tunnels are not touched.
  it('removes the Peer from the running interface, inside the Access container', () => {
    const script = removePeerScript(INSTALL_DIR, KEY_A)
    expect(script).toContain('exec -T access')
    expect(script).toContain(`wg set wg0 peer ${KEY_A} remove`)
    expect(script).not.toContain('restart')
  })

  it('refuses a key that is not one, before it reaches wg', () => {
    expect(() => removePeerScript(INSTALL_DIR, 'nope; rm -rf /')).toThrow(/Not a WireGuard key/u)
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

  // The entrypoint resolves each Exposed Service when it starts, so a
  // container compose left running would keep rules against addresses the
  // Memory proxy no longer has.
  it('starts the service afresh every time, so its rules match what is running', async () => {
    const { connector, calls } = fakeConnector()
    await accessUp(connector, INSTALL_DIR, ENABLED, () => {})
    expect(calls.map((call) => call.script)).toContainEqual(
      expect.stringContaining('up -d --build --force-recreate'),
    )
  })

  it('writes the ddclient config, mode 600, when DNS is configured and the token is held', async () => {
    const { connector, calls } = fakeConnector()
    await accessUp(connector, INSTALL_DIR, WITH_DNS, () => {})
    const conf = calls.find((call) => call.script.includes('access/ddclient.conf'))
    expect(conf?.stdin).toContain(`password=${CF_TOKEN}`)
    expect(conf?.script).toContain('chmod 600')
    expect(conf?.script).not.toContain(CF_TOKEN)
    const compose = calls.find((call) => call.script.includes('access/compose.yaml'))
    expect(compose?.stdin).toContain('ddclient:')
  })

  it('writes the Memory UI into the allowlist when sessions is on, and not otherwise', async () => {
    const both = fakeConnector()
    await accessUp(both.connector, INSTALL_DIR, `${ENABLED}SESSIONS_ENABLED=true\n`, () => {})
    const withSessions = both.calls.find((call) => call.script.includes('access/allowlist'))
    expect(withSessions?.stdin).toContain(`${MEMORY_UI.service}:${MEMORY_PORT}`)
    expect(withSessions?.stdin).not.toContain(`${MEMORY_SERVICE}:`)

    const alone = fakeConnector()
    await accessUp(alone.connector, INSTALL_DIR, ENABLED, () => {})
    const without = alone.calls.find((call) => call.script.includes('access/allowlist'))
    expect(without?.stdin).not.toContain(MEMORY_UI.service)
  })

  it('writes no ddclient config without a domain', async () => {
    const { connector, calls } = fakeConnector()
    await accessUp(connector, INSTALL_DIR, ENABLED, () => {})
    expect(calls.some((call) => call.script.includes('ddclient.conf'))).toBe(false)
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

  it('reads the DNS names when they are configured', async () => {
    const { connector } = fakeConnector()
    const status = await gatherAccess(connector, INSTALL_DIR, WITH_DNS)
    expect(status.dns).toEqual(dns)
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

// The allowlist follows the sessions toggle, and the Access service reads it
// only at start: flipping sessions with access on has to rewrite the file and
// restart the service, or the rules would not match what status says.
describe('accessRefresh', () => {
  it('rewrites the allowlist and restarts the service when access is on', async () => {
    const { connector, calls } = fakeConnector()
    await accessRefresh(connector, INSTALL_DIR, `${ENABLED}SESSIONS_ENABLED=true\n`, () => {})
    const allowlist = calls.find((call) => call.script.includes('access/allowlist'))
    expect(allowlist?.stdin).toContain(`${MEMORY_UI.service}:${MEMORY_PORT}`)
    const scripts = calls.map((call) => call.script)
    const restart = scripts.findIndex((script) => script.includes('restart access'))
    expect(restart).toBeGreaterThan(scripts.indexOf(allowlist?.script ?? ''))
  })

  it('does nothing when access is off', async () => {
    const { connector, calls } = fakeConnector()
    await accessRefresh(connector, INSTALL_DIR, 'SESSIONS_ENABLED=true\n', () => {})
    expect(calls).toEqual([])
  })

  it('tolerates a service that was never brought up, on restart', () => {
    const script = accessRestartScript(INSTALL_DIR)
    expect(script).toContain('[ -f compose.yaml ] || exit 0')
    expect(script).toContain('docker compose restart access')
  })

  it('stops rather than restarting a service whose allowlist it could not write', async () => {
    const { connector } = fakeConnector({ failing: 'access/allowlist' })
    await expect(accessRefresh(connector, INSTALL_DIR, ENABLED, () => {})).rejects.toThrow(
      /it broke/u,
    )
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
    exposed: EXPOSED_SERVICES,
  }

  it('lists the Memory UI among the Exposed Services when it is exposed', () => {
    const said = formatAccess({ ...on, exposed: [...EXPOSED_SERVICES, MEMORY_UI] }).join('\n')
    expect(said).toContain(`Memory UI: http://${TUNNEL_ADDRESS}:${MEMORY_PORT}`)
    expect(formatAccess(on).join('\n')).not.toContain('Memory UI')
  })

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

  it('says DNS is not configured, and where Peers reach the Target instead', () => {
    const said = formatAccess(on).join('\n')
    expect(said).toContain('dns')
    expect(said).toContain('not configured')
  })

  it('names the records and the Exposed Services by name once DNS is configured', () => {
    const said = formatAccess({ ...on, dns }).join('\n')
    expect(said).toContain('vps.example.com:51820')
    expect(said).toContain(`vps.in.example.com → ${TUNNEL_ADDRESS}`)
    expect(said).toContain('http://vps.in.example.com:8288')
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
