# The Memory service: one claude-mem worker on the Target, shared by every
# Session (ADR 0010). Built on the Target by the creator CLI when `sessions`
# is enabled or the Target is upgraded; its compose project is generated
# beside it in the install directory (src/cli/memory.ts).
#
# This image carries no copy of claude-mem. It carries the runtime the
# plugin's own worker script needs — bun, the `claude` CLI it summarises with,
# and uv for the Python that runs Chroma — and the entrypoint runs that script
# out of the shared ~/.claude volume, where a Session installed the plugin.
# So plugin and worker cannot drift: a plugin update done in a Session is a
# worker restart, and nothing here has to be rebuilt for it.
FROM debian:bookworm-slim

# git: the worker shells out to it for the Project a Session works in.
# python3: the interpreter uv falls back to when it is not asked for a
# specific one. ca-certificates and curl for the three installs below, and
# unzip because bun's installer refuses without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  python3 \
  unzip \
  && rm -rf /var/lib/apt/lists/*

# The same account the Sessions run as, with the same home: the plugin's
# install path is recorded in the volume as an absolute path under
# /home/agent/.claude, and the worker's data directory defaults to
# /home/agent/.claude-mem. Both must resolve here to what they are there.
ARG OPERATOR_UID=1000
ARG OPERATOR_GID=1000
RUN groupadd -o -g "$OPERATOR_GID" agent \
  && useradd -o -m -d /home/agent -u "$OPERATOR_UID" -g "$OPERATOR_GID" -s /bin/bash agent

USER agent
WORKDIR /home/agent
ENV HOME=/home/agent
# Where the three tools land, and where the plugin's own runner looks for
# bun when it is not on PATH (~/.bun/bin/bun).
ENV PATH="/home/agent/.bun/bin:/home/agent/.local/bin:$PATH"

# Pinned. bun runs the worker; uv runs Chroma through `uvx`, on the Python it
# fetches here at build time so the first start does not download one.
ARG BUN_VERSION=1.4.0
ARG UV_VERSION=0.12.7
ARG CHROMA_PYTHON=3.13
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
  && curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh \
  && uv python install "${CHROMA_PYTHON}"
# The claude CLI, as sandcastle's template installs it; the worker summarises
# with it, on the Run token the compose file hands over.
RUN curl -fsSL https://claude.ai/install.sh | bash

# The mount points, owned by the agent user before anything is mounted on
# them: a fresh named volume takes its ownership from the image's directory,
# which is what makes the data directory and the cache writable.
RUN mkdir -p /home/agent/.claude /home/agent/.claude-mem /home/agent/.cache

USER root
COPY entrypoint.sh /entrypoint.sh
# Explicit rather than trusting the mode COPY carries over: a package
# extracted on the Target may not keep it.
RUN chmod 755 /entrypoint.sh
USER agent

EXPOSE 37777
ENTRYPOINT ["/entrypoint.sh"]
