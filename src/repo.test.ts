import { describe, expect, it } from 'vitest'
import { repoSlug, repoUrl, slugFromRemote, slugOwner } from './repo.js'

describe('repoUrl', () => {
  it('takes the short form an operator is most likely to type', () => {
    expect(repoUrl('dworznik/sandcastle-todo-app')).toBe(
      'https://github.com/dworznik/sandcastle-todo-app.git',
    )
  })

  it('takes a full URL unchanged', () => {
    expect(repoUrl('https://github.com/dworznik/todo.git')).toBe(
      'https://github.com/dworznik/todo.git',
    )
  })

  // A Sandbox pushes with the PAT through a credential helper. An ssh remote
  // there would need a deploy key this platform does not issue, so an ssh
  // remote is converted rather than refused — it is a normal thing to paste.
  it('converts an ssh remote to HTTPS rather than refusing it', () => {
    expect(repoUrl('git@github.com:dworznik/todo.git')).toBe('https://github.com/dworznik/todo.git')
  })

  it('refuses what it cannot read as a repository', () => {
    expect(() => repoUrl('not a repo')).toThrow(/Not a repository/)
    expect(() => repoUrl('  ')).toThrow(/No repository/)
  })

  // The clone sends the PAT to this host. Over plain HTTP that is a token in
  // cleartext on the wire — a worse outcome than refusing to start.
  it('refuses plain HTTP, which would put the token on the wire', () => {
    expect(() => repoUrl('http://github.com/dworznik/todo.git')).toThrow(/in the clear/)
  })
})

describe('repoSlug', () => {
  it('names the repository GitHub can be asked about', () => {
    expect(repoSlug('https://github.com/dworznik/todo.git')).toBe('dworznik/todo')
    expect(repoSlug('https://github.com/dworznik/todo')).toBe('dworznik/todo')
  })

  // Only GitHub can be asked about a token's permissions, so anywhere else
  // skips the check rather than failing it.
  it('declines anything that is not a GitHub repository URL', () => {
    expect(repoSlug('https://gitlab.com/a/b.git')).toBeUndefined()
    expect(repoSlug('https://github.com/dworznik')).toBeUndefined()
    expect(repoSlug('https://github.com/a/b/c')).toBeUndefined()
    expect(repoSlug('not a url')).toBeUndefined()
  })
})

describe('slugFromRemote', () => {
  // Onboarding clones over HTTPS, so this is the shape a Project's origin has.
  it('reads the slug out of the remote Onboarding configures', () => {
    expect(slugFromRemote('https://github.com/dworznik/todo.git')).toBe('dworznik/todo')
  })

  // An operator can reconfigure a checkout's remote by hand, and an ssh remote
  // still names the same repository — the GitHub API takes the slug either way.
  it('reads it out of an ssh remote too', () => {
    expect(slugFromRemote('git@github.com:dworznik/todo.git')).toBe('dworznik/todo')
  })

  // Answering `undefined` rather than throwing, because the caller is the only
  // thing that knows what it wanted the slug for.
  it('answers with nothing for a remote GitHub does not host', () => {
    expect(slugFromRemote('https://gitlab.com/a/b.git')).toBeUndefined()
    expect(slugFromRemote('/srv/mirrors/todo.git')).toBeUndefined()
    expect(slugFromRemote('')).toBeUndefined()
  })
})

describe('slugOwner', () => {
  it('names the owner a head branch is qualified by', () => {
    expect(slugOwner('dworznik/todo')).toBe('dworznik')
  })
})
