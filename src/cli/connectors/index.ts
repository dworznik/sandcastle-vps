import type { TargetProfile } from "../profiles.js";
import { sshConnector } from "./ssh.js";
import type { Connector } from "./types.js";

/** The connectors that are filed but not built, and where to follow them. */
const DEFERRED: Record<string, { readonly what: string; readonly issue: number }> = {
  orb: { what: "OrbStack machines", issue: 27 },
  "docker-desktop": { what: "Docker Desktop on this machine", issue: 28 },
  "docker-context": { what: "a remote engine over a docker context", issue: 29 },
};

/**
 * The one place a Connector kind becomes a Connector. Everything above this
 * line talks to the interface, which is what makes the deferred kinds a matter
 * of adding a file here rather than touching the wizard.
 */
export const connectorFor = (profile: TargetProfile): Connector => {
  if (profile.connector === "ssh") {
    return sshConnector(profile.host, profile.installDir);
  }
  const deferred = DEFERRED[profile.connector];
  throw new Error(
    `The "${profile.connector}" Connector (${deferred?.what}) is not built yet — see issue #${deferred?.issue}.`,
  );
};
