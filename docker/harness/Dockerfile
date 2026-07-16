FROM node:22-bookworm-slim

# git for host-side worktree operations, docker CLI for spawning sibling
# sandbox containers through the mounted socket.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
  && rm -rf /var/lib/apt/lists/*

# Align the runtime user with the host user that owns the workspace checkouts,
# so worktrees created here are owned correctly on the host.
ARG DEV_UID=1000
ARG DEV_GID=1000
RUN groupmod -o -g $DEV_GID node && usermod -o -u $DEV_UID -g $DEV_GID node

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY tsconfig.json ./
COPY src ./src

USER ${DEV_UID}:${DEV_GID}

EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
