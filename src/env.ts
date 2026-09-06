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
  /** Path to the directory containing the Project checkouts. The same path
   *  on the Target and inside the Harness container — a Sandbox's bind
   *  mounts are created by the Target's daemon, so parity is required. */
  get workspaceRoot() {
    return required("WORKSPACE_ROOT");
  },
  /** Model for the sandbox agent unless a Dispatch overrides it. */
  get defaultModel() {
    return process.env.AGENT_MODEL ?? "claude-opus-4-8";
  },
  /** Address the harness binds, inside its own container namespace. The
   *  Harness is a container (ADR 0006): what is reachable on the Target is
   *  decided by the compose `ports` mapping, which publishes this port on
   *  Target loopback only. Compose sets this to 0.0.0.0 so the published port
   *  and the Orchestrator can both reach it; the default stays loopback so
   *  running the server directly in development never widens itself. */
  get host() {
    return process.env.HOST ?? "127.0.0.1";
  },
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
} as const;
