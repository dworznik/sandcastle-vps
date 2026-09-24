/**
 * Naming a repository.
 *
 * Two things do it: what the operator types when a Project is Onboarded, and
 * what `git remote get-url origin` reports inside a Run. Both have to arrive at
 * the same `owner/name`, because that is the only form the GitHub API takes —
 * so there is one definition rather than one per caller, and the two cannot
 * disagree about which repository a Project is.
 */

/**
 * Turn what the operator typed into a clone URL.
 *
 * HTTPS on the way out whatever came in, including an ssh remote: the Sandbox
 * pushes with the PAT through a credential helper, and an ssh remote inside a
 * Sandbox would need a deploy key this platform does not issue (ADR 0006).
 */
export const repoUrl = (input: string): string => {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('No repository given.')
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/u.exec(trimmed)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}.git`
  if (trimmed.startsWith('http://')) {
    // The clone sends the PAT to this host. Over plain HTTP that is a token in
    // cleartext on the wire, which is a worse outcome than refusing to start.
    throw new Error(
      `Refusing to clone over plain HTTP — the token would travel in the clear:\n${trimmed}`,
    )
  }
  if (trimmed.startsWith('https://')) return trimmed
  if (/^[\w.-]+\/[\w.-]+$/u.test(trimmed)) return `https://github.com/${trimmed}.git`
  throw new Error(
    `Not a repository this recognises: ${trimmed}\n` +
      'Give it as owner/name, or as a full https:// URL.',
  )
}

/**
 * `owner/repo` for a GitHub URL, or `undefined` for anywhere else.
 *
 * Only GitHub can be asked about the token's permissions or handed a pull
 * request, so a repository hosted elsewhere skips those rather than failing
 * them halfway.
 */
export const repoSlug = (url: string): string | undefined => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return undefined
  const parts = parsed.pathname
    .replace(/^\/+/u, '')
    .replace(/\.git$/u, '')
    .split('/')
  return parts.length === 2 && parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : undefined
}

/**
 * The same answer for a remote read back out of a checkout, where anything at
 * all could be configured — an ssh remote, a path on disk, another host.
 *
 * Answers `undefined` rather than throwing for every one of those: the caller
 * knows what it wanted the slug *for*, so it is the only thing that can say
 * something useful about not having one.
 */
export const slugFromRemote = (remote: string): string | undefined => {
  try {
    return repoSlug(repoUrl(remote))
  } catch {
    return undefined
  }
}

/** The owner half of an `owner/name` slug — what GitHub wants a head branch
 *  qualified by when a pull request is looked up. */
export const slugOwner = (slug: string): string => slug.split('/')[0] ?? slug
