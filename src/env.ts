const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const env = {
  /** Host path to the directory containing project checkouts. Mounted at the
   *  same path inside the harness container so sibling-container bind mounts
   *  resolve correctly. */
  get workspaceRoot() {
    return required("WORKSPACE_ROOT");
  },
  /** Long-lived token from `claude setup-token`, injected into every sandbox. */
  get claudeCodeOauthToken() {
    return required("CLAUDE_CODE_OAUTH_TOKEN");
  },
  /** Image used for sandboxes when a project has no .sandcastle/Dockerfile of its own. */
  get defaultSandboxImage() {
    return process.env.SANDBOX_IMAGE ?? "sandcastle-vps-sandbox";
  },
  /** Model for the sandbox agent unless a Dispatch overrides it. */
  get defaultModel() {
    return process.env.AGENT_MODEL ?? "claude-opus-4-8";
  },
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
} as const;
