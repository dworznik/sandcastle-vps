/**
 * The two things credential capture asks GitHub: whether the pasted token
 * works, and whether the signing key has been registered.
 *
 * Both are split into a call and a reading of its answer, so the reading —
 * which is where every mistake an operator can make shows up — is testable
 * without a network or an account.
 */

/** Where the operator makes the token. The fine-grained page, not the classic
 *  one: the permissions below are fine-grained names, and a classic token
 *  cannot be scoped to the Project repositories. */
export const TOKEN_PAGE = 'https://github.com/settings/personal-access-tokens/new'

/** Where the signing key is registered. The same page adds authentication keys
 *  and signing keys, and the type is a dropdown on it — which is why the
 *  instructions say so rather than trusting the default. */
export const SIGNING_KEY_PAGE = 'https://github.com/settings/ssh/new'

/**
 * What the token has to be able to do, in the words the page uses. Printed
 * rather than checked: a fine-grained token's own permissions are not readable
 * through the API it authenticates, so the alternative to printing them is
 * discovering a missing one inside a failed Run.
 */
export const REQUIRED_PERMISSIONS = [
  '  Repository access   Only select repositories — the repos you will Onboard as Projects',
  '  Contents            Read and write   — push the Task Branch',
  '  Pull requests       Read and write   — open the pull request',
  '  Issues              Read and write   — read the task and comment on it',
  '  Metadata            Read-only        — mandatory, GitHub grants it with the others',
].join('\n')

export interface Answer {
  readonly ok: boolean
  readonly detail: string
  /** Whether GitHub answered at all. A token GitHub rejected and a token
   *  GitHub was never asked about are different situations: the first is a bad
   *  token, the second is a bad network, and only one of them is the
   *  operator's to fix. */
  readonly reached: boolean
}

/**
 * `GET /user`, read as an answer about the token rather than about the
 * account. Each status is a different mistake, and saying which one it was is
 * the difference between fixing it and making another token.
 */
export const readTokenCheck = (status: number, body: string): Answer => {
  // Every branch below is GitHub answering, however unhelpfully — so the
  // network was fine and the token is what is in question.
  const answered = (ok: boolean, detail: string): Answer => ({ ok, detail, reached: true })
  if (status === 200) {
    let login: unknown
    try {
      login = (JSON.parse(body) as { login?: unknown }).login
    } catch {
      login = undefined
    }
    return typeof login === 'string' && login
      ? answered(true, `authenticates as ${login}`)
      : answered(false, 'GitHub accepted it but named no account — is this a GitHub token?')
  }
  if (status === 401) {
    return answered(false, 'GitHub rejected it (401) — expired, revoked, or mistyped')
  }
  if (status === 403) {
    return answered(false, 'GitHub refused it (403) — blocked, or rate-limited from here')
  }
  if (status === 404) {
    return answered(false, 'GitHub answered 404 — the token cannot read its own account')
  }
  return answered(false, `GitHub answered ${status}`)
}

/** Hard-coded: GitHub Enterprise is not somewhere this platform installs, and
 *  the seam a test needs is the `fetch` below rather than the address. */
const API = 'https://api.github.com'

type Fetch = typeof globalThis.fetch

/**
 * Ask GitHub who the token is.
 *
 * The token goes in a header, which is the whole reason this is `fetch` and
 * not `curl` through the LocalShell: a curl command line carrying a token puts
 * that token in the process table, and in the shell history of anyone who
 * copies the command out of the transcript.
 */
export const checkToken = async (
  token: string,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<Answer> => {
  try {
    const response = await fetchImpl(`${API}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'sandcastle-vps',
      },
    })
    return readTokenCheck(response.status, await response.text())
  } catch (error) {
    return {
      ok: false,
      reached: false,
      detail: `could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * A public key reduced to the part GitHub stores: the algorithm and the body,
 * without the trailing comment.
 *
 * `ssh-keygen` puts the comment it was given at the end of the line and GitHub
 * drops it, replacing it with the title typed on the page — so comparing whole
 * lines finds nothing, every time, for a key that is correctly registered.
 */
export const keyBody = (publicKey: string): string =>
  publicKey.trim().split(/\s+/u).slice(0, 2).join(' ')

/**
 * Is this key among the ones the account has registered for signing?
 *
 * The list comes from `gh api user/ssh_signing_keys` — the signing keys, which
 * are a different list from the authentication keys the same page adds. A key
 * pasted as the wrong type registers fine and signs nothing, and this is what
 * catches it.
 */
export const isRegistered = (listJson: string, publicKey: string): boolean => {
  let keys: unknown
  try {
    keys = JSON.parse(listJson)
  } catch {
    return false
  }
  if (!Array.isArray(keys)) return false
  const wanted = keyBody(publicKey)
  return keys.some(
    (entry: unknown) =>
      typeof (entry as { key?: unknown })?.key === 'string' &&
      keyBody((entry as { key: string }).key) === wanted,
  )
}
