const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

/**
 * The harness's own runtime settings — orchestration only. Agent credentials
 * and sandbox images belong to each Project, not here: they come from that
 * Project's `.sandcastle/` via sandcastle's own resolvers (ADR 0003).
 */
export const env = {
  /** Host path to the directory containing the Project checkouts. */
  get workspaceRoot() {
    return required("WORKSPACE_ROOT");
  },
  /** Model for the sandbox agent unless a Dispatch overrides it. */
  get defaultModel() {
    return process.env.AGENT_MODEL ?? "claude-opus-4-8";
  },
  /** Address the harness binds. Loopback by default: the harness is a plain
   *  process on the VPS host and its Dispatch surface is keyless, so
   *  reachability is the only access control it has. Remote callers come in
   *  over an SSH tunnel. */
  get host() {
    return process.env.HOST ?? "127.0.0.1";
  },
  /** The docker bridge gateway, when the deploy has detected one. The
   *  Orchestrator is a bridged container and has to dial the harness; a
   *  container has no route to host loopback, but it can reach the bridge
   *  gateway — an address nothing outside this host can route to. Unset in
   *  local development: loopback only. */
  get bridgeHost(): string | undefined {
    return process.env.DOCKER_BRIDGE_IP || undefined;
  },
  /** Every address the harness listens on. */
  get hosts(): string[] {
    const bridge = this.bridgeHost;
    return bridge && bridge !== this.host ? [this.host, bridge] : [this.host];
  },
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
} as const;
