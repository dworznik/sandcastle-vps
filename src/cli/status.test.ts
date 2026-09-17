import { describe, expect, it } from 'vitest'
import type { Connector, ExecResult } from './connectors/types.js'
import type { TargetProfile } from './profiles.js'
import {
  formatStatus,
  gatherStatus,
  imagesScript,
  versionScript,
  type StatusReport,
} from './status.js'

const profile: TargetProfile = {
  name: 'vps',
  connector: 'ssh',
  host: 'op@vps',
  installDir: '/home/op/.sandcastle-vps',
  workspaceRoot: '/home/op/work',
}

const FULL_ENV = [
  'WORKSPACE_ROOT=/home/op/work',
  'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-short',
  'GH_TOKEN=github_pat_short',
  'AGENT_GIT_NAME=Patryk',
  'AGENT_GIT_EMAIL=op@example.com',
  '',
].join('\n')

const SYNCED = JSON.stringify({
  data: { apps: [{ name: 'sandcastle-vps', connected: true, functionCount: 1, error: null }] },
})

const LOOPBACK_ONLY = [
  '  sl  local_address rem_address   st',
  '   0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
  '   1: 0100007F:2060 00000000:0000 0A 0 0 0 0 0 1000 0 1 1',
  '',
].join('\n')

interface TargetState {
  readonly version?: string
  readonly env?: string
  readonly projects?: unknown
  readonly images?: string
  readonly apps?: string
}

const fakeConnector = (state: TargetState = {}) => {
  const ran: string[] = []
  const connector: Connector = {
    kind: 'ssh',
    exec: (script: string): Promise<ExecResult> => {
      ran.push(script)
      const ok = (stdout: string): Promise<ExecResult> =>
        Promise.resolve({ code: 0, stdout, stderr: '' })
      if (script.includes('"version"')) return ok(`version\t${state.version ?? '0.1.0'}`)
      if (script.includes('/.env')) return ok(state.env ?? FULL_ENV)
      if (script.includes('/projects')) {
        return ok(
          typeof state.projects === 'string'
            ? state.projects
            : JSON.stringify({
                projects: state.projects ?? [
                  { name: 'todo', imageName: 'sandcastle:todo', onboarded: true },
                ],
              }),
        )
      }
      if (script.includes('docker images')) return ok(state.images ?? 'sandcastle:todo\n')
      if (script.includes('/v0/gql')) return ok(state.apps ?? SYNCED)
      if (script.includes('/proc/net/tcp')) return ok(LOOPBACK_ONLY)
      if (script.includes('compose ps')) return ok('NAME      STATUS\nharness   Up 2 hours')
      return ok('')
    },
    putTar: () => Promise.resolve(),
    preflight: () => Promise.reject(new Error('not used here')),
  }
  return { connector, ran }
}

const gather = async (state: TargetState = {}) => {
  const { connector, ran } = fakeConnector(state)
  return { report: await gatherStatus({ profile, connector }), ran }
}

describe('versionScript', () => {
  // Preflight asks a Target for Docker and nothing else, so there is no node
  // on it to parse JSON with.
  it('reads the version without needing anything but a shell', () => {
    const script = versionScript(profile.installDir)
    expect(script).toContain('sed')
    expect(script).not.toContain('node')
  })

  it('quotes the path rather than pasting it into a command', () => {
    expect(versionScript("/home/o'brien/x")).toContain(`'/home/o'\\''brien/x/package.json'`)
  })
})

describe('gatherStatus', () => {
  // The whole contract: it can be run against a Target mid-Run without
  // thinking about it. A redirect into a file, a compose verb that starts or
  // stops something, a key being generated — none of those belong in a report.
  it('changes nothing on the Target', async () => {
    const mutating = [
      'up -d',
      'compose down',
      'compose restart',
      // Not a bare `rm -`: the loopback probe is `docker run --rm`, which
      // removes its own throwaway container and touches nothing else.
      'rm -f',
      'rm -rf',
      'mv ',
      'mkdir',
      'chmod',
      'tee ',
      '>>',
      'ssh-keygen',
      'git clone',
      'build-image',
      '/dispatch',
    ]
    const { ran } = await gather()
    for (const script of ran) {
      for (const verb of mutating) expect(script).not.toContain(verb)
    }
    expect(ran.some((script) => script.includes('compose ps'))).toBe(true)
  })

  it('reports the Target version against the CLI’s own', async () => {
    const { report } = await gather({ version: '0.0.9' })
    expect(report.targetVersion).toBe('0.0.9')
    expect(report.cliVersion).toBeTruthy()
  })

  it('carries the sync and exposure checks', async () => {
    const { report } = await gather()
    expect(report.checks.map((check) => check.label)).toEqual(['Harness synced', 'loopback only'])
    expect(report.checks.every((check) => check.ok)).toBe(true)
  })

  it('marks a Project whose image has not been built', async () => {
    const { report } = await gather({ images: 'something:else\n' })
    expect(report.projects).toEqual([
      { name: 'todo', imageName: 'sandcastle:todo', onboarded: true, imageBuilt: false },
    ])
  })

  it('names the missing credentials', async () => {
    const { report } = await gather({ env: 'WORKSPACE_ROOT=/home/op/work\nGH_TOKEN=\n' })
    expect(report.missingCredentials).toContain('githubToken')
    expect(report.missingCredentials).toContain('agentToken')
  })

  // A Target worth running this against is usually one where something is
  // already wrong. A report that gave up at the first bad answer would never
  // reach the part that explains it.
  it('keeps reporting when the Harness cannot be asked about Projects', async () => {
    const { report } = await gather({ projects: 'curl: (7) Failed to connect' })
    expect(report.projectsError).toContain('did not answer')
    expect(report.checks).toHaveLength(2)
    expect(report.containers).toContain('harness')
  })

  // The criterion this exists for: against a Target that has never been
  // installed, say so plainly rather than failing obscurely.
  it('says plainly that nothing is installed, rather than failing', async () => {
    const { report } = await gather({ version: '', env: '' })
    expect(report.installed).toBe(false)
    expect(report.reachable).toBe(true)
    expect(formatStatus(report)).toContain('Nothing is installed here')
  })

  // A Target that cannot be reached and one with nothing installed answer
  // identically — both silent. Telling the operator to run the install when
  // ssh is what is broken sends them at the wrong thing.
  it('tells an unreachable Target apart from an empty one', async () => {
    const connector: Connector = {
      kind: 'ssh',
      exec: () =>
        Promise.resolve({ code: 255, stdout: '', stderr: 'ssh: connect to host vps port 22' }),
      putTar: () => Promise.resolve(),
      preflight: () => Promise.reject(new Error('not used here')),
    }
    const report = await gatherStatus({ profile, connector })
    expect(report.reachable).toBe(false)
    const said = formatStatus(report)
    expect(said).toContain('did not answer')
    expect(said).toContain('connect to host')
    expect(said).not.toContain('Nothing is installed here')
  })
})

describe('formatStatus', () => {
  const report = (overrides: Partial<StatusReport> = {}): StatusReport => ({
    target: 'vps',
    installed: true,
    targetVersion: '0.1.0',
    cliVersion: '0.1.0',
    containers: 'harness   Up 2 hours',
    checks: [{ ok: true, label: 'Harness synced', detail: 'sandcastle-vps, 1 function' }],
    projects: [{ name: 'todo', imageName: 'sandcastle:todo', onboarded: true, imageBuilt: true }],
    missingCredentials: [],
    ...overrides,
  })

  // "But I fixed that" is usually a Target running something older than the
  // CLI in the operator's hand, which is why the versions lead.
  it('says when the Target is behind the CLI, and what to do about it', () => {
    const said = formatStatus(report({ targetVersion: '0.0.9' }))
    expect(said).toContain('0.0.9 on the Target')
    expect(said).toContain('install/upgrade')
  })

  it('says so when they match, rather than staying silent', () => {
    expect(formatStatus(report())).toContain('same as this CLI')
  })

  // A status that reads as healthy on a Target that cannot execute anything is
  // worse than one that says nothing.
  it('does not read as healthy when a credential is missing', () => {
    const said = formatStatus(report({ missingCredentials: ['githubToken'] }))
    expect(said).toContain('GitHub token')
    expect(said).toContain('a Run would refuse to start')
  })

  it('tells a checkout apart from an Onboarded Project, and from one with no image', () => {
    const said = formatStatus(
      report({
        projects: [
          { name: 'bare', imageName: 'sandcastle:bare', onboarded: false, imageBuilt: false },
          { name: 'todo', imageName: 'sandcastle:todo', onboarded: true, imageBuilt: false },
        ],
      }),
    )
    expect(said).toContain('not Onboarded')
    expect(said).toContain('not built yet')
  })

  it('points at the menu when there are no Projects at all', () => {
    expect(formatStatus(report({ projects: [] }))).toContain('add one from the menu')
  })
})

describe('imagesScript', () => {
  it('asks the Target engine what it holds', () => {
    expect(imagesScript()).toContain('docker images')
  })
})
