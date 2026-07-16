# Default Sandbox image, used for every project that does not ship its own
# .sandcastle/Dockerfile. Based on sandcastle's scaffolded template, plus the
# GitHub CLI and the mattpocock/skills set baked in at build time (sandboxes
# are ephemeral, so there is no volume to install into at runtime).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ARG SKILLS_CLI_VERSION=1.5.17
RUN npm install -g skills@${SKILLS_CLI_VERSION}

# Build-args for UID/GID alignment: must match the harness container's user so
# files written in the bind-mounted worktree share an owner with the host.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID
# (sandcastle's containerUid/containerGid pre-flight checks this).
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

ENV PATH="/home/agent/.local/bin:$PATH"

# Bake the skill set for the sandbox agent.
RUN DO_NOT_TRACK=1 skills add mattpocock/skills#main --global --agent claude-code --skill '*' --yes

WORKDIR /home/agent

# Sandcastle bind-mounts the git worktree at /home/agent/workspace and
# overrides the working directory at container start.
ENTRYPOINT ["sleep", "infinity"]
