# Appended verbatim to a Project's scaffolded .sandcastle/Dockerfile by
# `init-project`. It is a fragment, not an image: it continues the build stage
# sandcastle's template starts, and relies on the AGENT_UID/AGENT_GID args that
# template declares.
#
# Sandcastle's template already installs git, jq, the GitHub CLI and Claude
# Code, so the only thing this stack adds on top is the skill set. It is baked
# in at build time because sandboxes are ephemeral — there is no volume to
# install into at runtime.

# `npm install -g` needs root, but the template has already dropped to the
# unprivileged agent user. Go back up for the install, then return — `skills
# add --global` must run as agent to land in that user's own home.
USER root
# git signs commits with `ssh-keygen -Y sign`, which the base image does not
# ship. The Harness configures SSH signing in the sandbox when the Project
# carries a signing key.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client \
  && rm -rf /var/lib/apt/lists/*
ARG SKILLS_CLI_VERSION=1.5.17
RUN npm install -g skills@${SKILLS_CLI_VERSION}

USER ${AGENT_UID}:${AGENT_GID}
RUN DO_NOT_TRACK=1 skills add mattpocock/skills#main --global --agent claude-code --skill '*' --yes
