import { execFile } from 'node:child_process'
import { chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { DeliveryPorts } from './delivery.js'

/**
 * The ports a Delivery actually reaches the world through: git in the Project
 * checkout, and the GitHub REST API.
 *
 * Separate from the decisions in `delivery.ts` because this file changes for
 * transport reasons — a timeout, a header, how a credential is supplied — and
 * that file changes for domain reasons. Neither function throws for an answer it
 * got: a non-zero git exit and a 404 are answers, and `delivery.ts` decides
 * which of them is fatal.
 */

const exec = promisify(execFile)

/** git in a Project checkout is local work plus one network round-trip; a minute
 *  is generous for both and short enough to fail a hung fetch legibly. */
const GIT_TIMEOUT_MS = 60 * 1000
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const GITHUB_TIMEOUT_MS = 30 * 1000

/**
 * What git calls to answer a credential prompt.
 *
 * The token is named, never interpolated. A credential on a command line
 * reaches `ps` and every log that echoes a command, which is the rule
 * `GIT_SETUP_COMMAND` and the Onboarding scripts already follow. The
 * consequence worth stating: this script holds no secret, so it can be written
 * once per process and left on disk.
 *
 * git asks twice — for a username and then a password — and distinguishes the
 * two only by the prompt text it passes as `$1`. A script that answered both
 * the same way would send the token as the username and then fail to
 * authenticate.
 */
export const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$GH_TOKEN" ;;
esac
`

const ASKPASS_PATH = join(tmpdir(), 'sandcastle-git-askpass.sh')

let written: Promise<string> | undefined

/** Write the askpass script once per process. `writeFile`'s mode applies only
 *  when it creates the file, so the mode is set separately — an askpass git
 *  cannot execute fails as an authentication failure, which reads as the wrong
 *  problem entirely. */
const askpassScript = (): Promise<string> =>
  (written ??= (async () => {
    await writeFile(ASKPASS_PATH, GIT_ASKPASS_SCRIPT)
    await chmod(ASKPASS_PATH, 0o700)
    return ASKPASS_PATH
  })())

/**
 * The real ports, for one Project.
 *
 * Every git call is authenticated, not only the push: `git fetch` against a
 * private Project needs the token too, and a fetch that silently failed would
 * resolve a Base from a stale remote ref.
 */
export const deliveryPorts = (checkout: string, githubToken: string): DeliveryPorts => ({
  git: async (args) => {
    const env = {
      ...process.env,
      GH_TOKEN: githubToken,
      GIT_ASKPASS: await askpassScript(),
      // No terminal to answer a prompt on, so a credential the askpass script
      // cannot supply must fail rather than hang until the timeout.
      GIT_TERMINAL_PROMPT: '0',
    }
    try {
      const { stdout, stderr } = await exec('git', [...args], {
        cwd: checkout,
        env,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
      })
      return { code: 0, stdout: stdout.trim(), stderr: stderr.trim() }
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string }
      // A numeric `code` is git's own exit status, which is an answer. Anything
      // else — ENOENT, a timeout kill — is this process failing to ask.
      if (typeof failed.code !== 'number') throw error
      return {
        code: failed.code,
        stdout: (failed.stdout ?? '').trim(),
        stderr: (failed.stderr ?? '').trim(),
      }
    }
  },
  github: async ({ method, path, body }) => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await fetch(`https://api.github.com${path}`, init)
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed }
  },
})
