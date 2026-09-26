/**
 * The platform network: one Docker network on the Target, owned by the
 * install rather than by compose, that every compose project of the platform
 * joins by name — the stack, and later each Project's Session and the Memory
 * service, which keep their own compose projects (ADR 0007, ADR 0010).
 *
 * The install creates it because compose cannot: a network compose creates
 * belongs to one compose project and goes down with it, and a Session joining
 * the stack's own network would be a Session that stops resolving the Harness
 * the moment the stack is recreated. Declared `external` in compose.yaml, the
 * stack refuses to start until this exists, which is why the install creates
 * it before `up` rather than after.
 */

/** Fixed, and the same string as the stack's compose project name, so
 *  `docker network ls` shows it beside the stack. compose.yaml names it too;
 *  the test holds the two together. */
export const PLATFORM_NETWORK = 'sandcastle-vps'

/** Create the network unless it is already there. Inspecting first rather than
 *  swallowing `create`'s failure keeps "already exists" apart from "the daemon
 *  is not answering", which is the failure the caller wants to see. */
export const ensureNetworkScript = (): string =>
  `docker network inspect ${PLATFORM_NETWORK} > /dev/null 2>&1 || docker network create ${PLATFORM_NETWORK} > /dev/null`

/**
 * Remove the network compose created for the stack before the platform
 * network existed. Compose moves the containers off it on the first `up`
 * after the change and never removes it; a Target upgraded from that state
 * would otherwise carry an empty network forever. Gone already, or still in
 * use by something, is not an error here.
 */
export const retireDefaultNetworkScript = (): string =>
  `docker network rm ${PLATFORM_NETWORK}_default > /dev/null 2>&1 || true`

/** One line — name, driver, then each attached container — or nothing at all
 *  when the network does not exist. Read-only, for `status`. */
export const networkScript = (): string =>
  `docker network inspect -f '{{.Name}}\t{{.Driver}}{{range .Containers}}\t{{.Name}}{{end}}' ${PLATFORM_NETWORK} 2> /dev/null || true`

/** Present with what Docker reported, or absent — a Target whose install
 *  predates the network, or one where it was removed by hand. */
export type PlatformNetwork =
  | { readonly present: false }
  | {
      readonly present: true
      readonly driver: string
      /** Container names, as Docker reports them. */
      readonly attached: readonly string[]
    }

export const parseNetwork = (stdout: string): PlatformNetwork => {
  const line = stdout.trim().split('\n')[0]?.trim()
  if (!line) return { present: false }
  const [, driver = '', ...attached] = line.split('\t')
  return { present: true, driver, attached: attached.filter(Boolean) }
}
