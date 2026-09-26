# The Access service: one WireGuard interface on the Target, with a DNAT
# allowlist in front of the platform network (ADR 0011). Built on the Target
# by the creator CLI when `access` is enabled; its compose project is
# generated beside it in the install directory (src/cli/access.ts).
#
# Ported from claude-tmux's wireguard container, minus what moved out of it:
# the peer list and the allowlist arrive as files the CLI writes, not as
# environment, and the Cloudflare updater is its own slice (#91).
FROM alpine:3.21

# wireguard-tools for wg and wg-quick; iptables for the FORWARD policy and the
# DNAT rules; qrencode so a Peer's config can be shown as a QR code without
# the operator's machine needing anything installed — the CLI pipes the
# config through this container and prints what comes back.
RUN apk add --no-cache \
  wireguard-tools \
  iptables \
  libqrencode-tools

COPY entrypoint.sh /entrypoint.sh
# Explicit rather than trusting the mode COPY carries over: a package
# extracted on the Target may not keep it.
RUN chmod 755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
