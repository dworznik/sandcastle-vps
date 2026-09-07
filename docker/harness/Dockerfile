# The Harness. A container on every Connector — there is no host-process mode
# (ADR 0006), so this image is the only way the Harness runs.
FROM node:22-bookworm-slim

# git for the worktree operations sandcastle performs on the Project checkout,
# and the docker CLI for spawning sibling Sandbox containers through the Target
# engine's socket. buildx with it: a Run builds a missing Project image by
# shelling out to `docker build`, which without the plugin silently falls back
# to the deprecated legacy builder.
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  git \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
  && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
  && rm -rf /var/lib/apt/lists/*

# Align the runtime user with the operator who owns the workspace checkouts on
# the Target: worktrees and logs are written through the path-parity mount, so
# they must land owned by that user and not by root.
ARG OPERATOR_UID=1000
ARG OPERATOR_GID=1000
RUN groupmod -o -g "$OPERATOR_GID" node && usermod -o -u "$OPERATOR_UID" -g "$OPERATOR_GID" node

WORKDIR /app

RUN corepack enable

# pnpm-workspace.yaml carries the build-script approvals, and pnpm fails the
# install without it — tsx's esbuild binary is fetched by one of them.
#
# The lockfile is optional, hence the bracket glob: npm refuses to publish a
# root lockfile whatever `files` says, so the package a Target is installed
# from — this package, shipped over the Connector — cannot carry one. A
# checkout still builds from the lockfile it has; a delivered package resolves
# the manifest's ranges, as any consumer of a published package does. The
# pattern shares a COPY with sources that always match, because a COPY whose
# every pattern matches nothing is an error.
COPY package.json pnpm-workspace.yaml pnpm-lock.yam[l] ./
# --prod: the Target runs the Harness, it does not typecheck or test it. tsx is
# a runtime dependency, so this still has everything the server needs.
RUN if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --prod; else pnpm install --prod; fi

COPY tsconfig.json ./
COPY src ./src

USER ${OPERATOR_UID}:${OPERATOR_GID}

EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
