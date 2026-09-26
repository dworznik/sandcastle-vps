# Appended verbatim to a Project's scaffolded .sandcastle/Dockerfile when it is
# Onboarded by the creator CLI's "Add a Project". It is a fragment, not an
# image: it continues the build stage sandcastle's template starts, and relies
# on the AGENT_UID/AGENT_GID args that template declares.
#
# Onboarding runs inside the Harness container, so this file is copied into
# that image (docker/harness/Dockerfile) as well as shipped in the package.
#
# Sandcastle's template already installs git, jq, the GitHub CLI and Claude
# Code, so this stack adds two things on top: what a Session needs, and the
# skill set. Both are baked in at build time because sandboxes are ephemeral —
# there is no volume to install into at runtime.
#
# A Project's one image serves both its Sandboxes and its Session (ADR 0007),
# so the Session's tooling lives here rather than in a second image: tmux,
# whose server is what a Session is; an editor; and bash, the Session's login
# shell (ADR 0010). bash is already in the template's base image and is already
# the agent user's shell — it is named here so that stays true if the base
# changes, and so nothing has to be read into its absence from this list. zsh
# is deliberately not installed: the agent writes bash by default, and a zsh
# login shell turns that into a rewrite after every first error.

# `npm install -g` needs root, but the template has already dropped to the
# unprivileged agent user. Go back up for the install, then return — `skills
# add --global` must run as agent to land in that user's own home.
USER root
# openssh-client for `ssh-keygen -Y sign`, which is what git shells out to for
# an ssh-format signature — the format a Run's commits are signed in, against
# the key the Harness mounts (ADR 0006).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    openssh-client \
    tmux \
    vim \
  && rm -rf /var/lib/apt/lists/*
ARG SKILLS_CLI_VERSION=1.5.17
RUN npm install -g skills@${SKILLS_CLI_VERSION}

USER ${AGENT_UID}:${AGENT_GID}
RUN DO_NOT_TRACK=1 skills add mattpocock/skills#main --global --agent claude-code --skill '*' --yes
