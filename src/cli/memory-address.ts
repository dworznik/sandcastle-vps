/**
 * Where the Memory service answers on the platform network. A leaf on its
 * own so both the service (memory.ts) and the Session's forwarder
 * (session-files.ts) read the same two values without either importing the
 * other: memory.ts already imports session-files.ts for the login volume.
 */

/** The compose service name, and the DNS name on the platform network. */
export const MEMORY_SERVICE = 'memory'

/** The port the plugin's worker serves on, and the one its hooks dial on
 *  loopback; the Session's forwarder maps one to the other. */
export const MEMORY_PORT = 37777
