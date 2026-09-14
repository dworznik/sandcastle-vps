import { describe, expect, it } from 'vitest'
import { readEnv, upsertAllEnv, upsertEnv } from './target-env.js'

describe('upsertEnv', () => {
  describe('seed mode', () => {
    it('adds the key to an empty file', () => {
      expect(upsertEnv('', 'WORKSPACE_ROOT', '/home/op/work', 'seed')).toBe(
        'WORKSPACE_ROOT=/home/op/work\n',
      )
    })

    it('appends the key when the file has others', () => {
      expect(upsertEnv('GH_TOKEN=ghp_existing\n', 'WORKSPACE_ROOT', '/w', 'seed')).toBe(
        'GH_TOKEN=ghp_existing\nWORKSPACE_ROOT=/w\n',
      )
    })

    // This is the whole of what makes a re-run idempotent, and what a newer
    // package upgrading in place relies on.
    it('never overwrites a value the operator already set', () => {
      expect(upsertEnv('WORKSPACE_ROOT=/mine\n', 'WORKSPACE_ROOT', '/theirs', 'seed')).toBe(
        'WORKSPACE_ROOT=/mine\n',
      )
    })

    it('fills in a key that is present but empty — the scaffolded placeholder', () => {
      expect(upsertEnv('WORKSPACE_ROOT=\nGH_TOKEN=\n', 'WORKSPACE_ROOT', '/w', 'seed')).toBe(
        'WORKSPACE_ROOT=/w\nGH_TOKEN=\n',
      )
    })
  })

  describe('rotate mode', () => {
    it('replaces an existing value', () => {
      expect(upsertEnv('GH_TOKEN=old\n', 'GH_TOKEN', 'new', 'rotate')).toBe('GH_TOKEN=new\n')
    })

    it('adds the key when it is absent', () => {
      expect(upsertEnv('WORKSPACE_ROOT=/w\n', 'GH_TOKEN', 'new', 'rotate')).toBe(
        'WORKSPACE_ROOT=/w\nGH_TOKEN=new\n',
      )
    })
  })

  it('leaves every other line byte-for-byte alone', () => {
    const original = [
      '# The Claude Code token — the wizard captures this one.',
      'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-old',
      '',
      '#AGENT_MODEL=claude-opus-4-8',
      'GH_TOKEN=keepme',
      'CUSTOM_URL=https://example.com/a=b?c=d',
    ].join('\n')

    expect(upsertEnv(`${original}\n`, 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-new', 'rotate')).toBe(
      `${original.replace('sk-ant-old', 'sk-ant-new')}\n`,
    )
  })

  it('does not corrupt a file whose last line has no newline', () => {
    expect(upsertEnv('GH_TOKEN=keepme', 'WORKSPACE_ROOT', '/w', 'rotate')).toBe(
      'GH_TOKEN=keepme\nWORKSPACE_ROOT=/w\n',
    )
  })

  it('does not grow a blank line on every rewrite', () => {
    const once = upsertEnv('GH_TOKEN=a\n', 'A', '1', 'rotate')
    expect(upsertEnv(once, 'B', '2', 'rotate')).toBe('GH_TOKEN=a\nA=1\nB=2\n')
  })

  // `KEY=` is a literal prefix, not a pattern — the awk this replaces made the
  // same choice for the same reason.
  it('only matches the whole key, not a suffix of another key', () => {
    expect(upsertEnv('MY_GH_TOKEN=untouched\n', 'GH_TOKEN', 'new', 'rotate')).toBe(
      'MY_GH_TOKEN=untouched\nGH_TOKEN=new\n',
    )
  })

  it('leaves a commented-out key commented out', () => {
    expect(upsertEnv('#PORT=3000\n', 'PORT', '3399', 'rotate')).toBe('#PORT=3000\nPORT=3399\n')
  })

  it('writes values containing regex and shell metacharacters literally', () => {
    const hostile = 'a/b&c\\d$e`f"g\'h|i.*j[k]'
    expect(upsertEnv('GH_TOKEN=old\n', 'GH_TOKEN', hostile, 'rotate')).toBe(`GH_TOKEN=${hostile}\n`)
  })
})

describe('upsertAllEnv', () => {
  it('applies every key in one pass over the file', () => {
    expect(
      upsertAllEnv(
        'WORKSPACE_ROOT=/mine\n',
        { WORKSPACE_ROOT: '/theirs', DOCKER_GID: '999' },
        'seed',
      ),
    ).toBe('WORKSPACE_ROOT=/mine\nDOCKER_GID=999\n')
  })
})

describe('readEnv', () => {
  it('reads a value back', () => {
    expect(readEnv('WORKSPACE_ROOT=/w\nGH_TOKEN=t\n', 'GH_TOKEN')).toBe('t')
  })

  it('reads an absent key as unset', () => {
    expect(readEnv('WORKSPACE_ROOT=/w\n', 'GH_TOKEN')).toBeUndefined()
  })

  // The scaffolded placeholder means "not captured yet" everywhere else, so it
  // has to mean that here too.
  it('reads a scaffolded, empty key as unset', () => {
    expect(readEnv('GH_TOKEN=\n', 'GH_TOKEN')).toBeUndefined()
  })

  it('does not mistake a key that ends with the one asked for', () => {
    expect(readEnv('MY_GH_TOKEN=other\n', 'GH_TOKEN')).toBeUndefined()
  })
})
