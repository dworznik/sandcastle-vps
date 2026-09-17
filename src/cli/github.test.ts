import { describe, expect, it } from 'vitest'
import {
  REQUIRED_PERMISSIONS,
  checkToken,
  isRegistered,
  keyBody,
  readTokenCheck,
} from './github.js'

const PUBLIC_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH0000000000000000000000000000000000000 agent@example.com'

describe('readTokenCheck', () => {
  it('accepts a token GitHub answered for, and says whose it is', () => {
    const answer = readTokenCheck(200, JSON.stringify({ login: 'dworznik' }))
    expect(answer.ok).toBe(true)
    expect(answer.detail).toContain('dworznik')
  })

  // A 401 and an unreachable GitHub read the same to an operator staring at
  // "it didn't work", and only one of them is fixed by making a new token.
  it('separates a token GitHub rejected from one it never saw', async () => {
    expect(readTokenCheck(401, '')).toMatchObject({ ok: false, reached: true })
    const offline = await checkToken('irrelevant', () => Promise.reject(new Error('ENOTFOUND')))
    expect(offline).toMatchObject({ ok: false, reached: false })
    expect(offline.detail).toContain('ENOTFOUND')
  })

  it('names the status for anything it has no better answer for', () => {
    expect(readTokenCheck(503, '').detail).toContain('503')
  })

  // Only a classic token carries `x-oauth-scopes`. It does work, so it is not
  // refused — but it reaches every repository the account can, which is the
  // opposite of what the fine-grained page asked for, and worth knowing before
  // it becomes the credential an autonomous agent holds.
  it('says so when the token is a classic one rather than fine-grained', () => {
    const answer = readTokenCheck(200, JSON.stringify({ login: 'op' }), 'repo, workflow')
    expect(answer.ok).toBe(true)
    expect(answer.detail).toContain('classic token')
    expect(answer.detail).toContain('repo, workflow')
  })

  it('says nothing of the sort for a fine-grained token', () => {
    expect(readTokenCheck(200, JSON.stringify({ login: 'op' }), null).detail).not.toContain(
      'classic',
    )
  })

  // Pointing the CLI at something that answers 200 with anything at all would
  // otherwise accept a token that is not a GitHub token.
  it('refuses a 200 that names no account', () => {
    expect(readTokenCheck(200, 'not json').ok).toBe(false)
    expect(readTokenCheck(200, JSON.stringify({ login: '' })).ok).toBe(false)
  })
})

describe('checkToken', () => {
  // The token in a header and nowhere else: a curl command line carrying it
  // would put it in the process table and in the transcript.
  it('sends the token as a bearer header', async () => {
    let seen: Headers | undefined
    await checkToken('github_pat_example', (_url, init) => {
      seen = new Headers(init?.headers)
      return Promise.resolve(new Response(JSON.stringify({ login: 'op' }), { status: 200 }))
    })
    expect(seen?.get('authorization')).toBe('Bearer github_pat_example')
  })

  it('asks the account endpoint, which is what a token can always answer for', async () => {
    let url: unknown
    await checkToken('t', (requested) => {
      url = requested
      return Promise.resolve(new Response('{"login":"op"}', { status: 200 }))
    })
    expect(url).toBe('https://api.github.com/user')
  })
})

describe('keyBody', () => {
  // ssh-keygen puts the comment it was given at the end of the line; GitHub
  // drops it and shows the title typed on the page instead. Comparing whole
  // lines finds nothing, every time, for a correctly registered key.
  it('ignores the comment, which GitHub does not keep', () => {
    expect(keyBody(PUBLIC_KEY)).toBe(keyBody(`${PUBLIC_KEY.split(' ').slice(0, 2).join(' ')}\n`))
  })
})

describe('isRegistered', () => {
  const listed = (key: string) => JSON.stringify([{ id: 1, key, title: 'vps' }])

  it('finds the key GitHub stored without its comment', () => {
    const stored = PUBLIC_KEY.split(' ').slice(0, 2).join(' ')
    expect(isRegistered(listed(stored), PUBLIC_KEY)).toBe(true)
  })

  it('does not find a key that is not there', () => {
    expect(isRegistered(listed('ssh-ed25519 AAAAsomethingelse'), PUBLIC_KEY)).toBe(false)
    expect(isRegistered('[]', PUBLIC_KEY)).toBe(false)
  })

  // `gh api` prints an error object rather than a list when it cannot ask, and
  // reading that as "registered" would tell the operator their unregistered
  // key was fine.
  it('reads anything that is not a list of keys as "not registered"', () => {
    expect(isRegistered('{"message":"Bad credentials"}', PUBLIC_KEY)).toBe(false)
    expect(isRegistered('not json at all', PUBLIC_KEY)).toBe(false)
    expect(isRegistered(JSON.stringify([{ id: 1 }]), PUBLIC_KEY)).toBe(false)
  })
})

describe('REQUIRED_PERMISSIONS', () => {
  // A fine-grained token's own permissions are not readable through the API it
  // authenticates, so this text is the only thing standing between the
  // operator and finding a missing one inside a failed Run.
  it('names every permission a Run uses', () => {
    for (const permission of ['Contents', 'Pull requests', 'Issues', 'Metadata']) {
      expect(REQUIRED_PERMISSIONS).toContain(permission)
    }
  })
})
