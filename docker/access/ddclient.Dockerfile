# The public endpoint record's keeper, for the optional DNS layer of Access
# (ADR 0011): ddclient, as claude-tmux ran it, updating one Cloudflare A
# record whenever this Target's public address changes. Only in the Access
# compose project when a domain is configured; its config is written by the
# creator CLI, mode 600, and mounted read-only (src/cli/access.ts).
FROM alpine:3.21

RUN apk add --no-cache ddclient

ENTRYPOINT ["ddclient", "-foreground", "-daemon=300", "-file=/config/ddclient.conf"]
