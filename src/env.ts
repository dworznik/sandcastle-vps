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
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
} as const;
