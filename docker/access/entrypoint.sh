#!/bin/sh
# Bring up wg0 from three inputs and hold it up until stopped.
#
#   /etc/wireguard/server_private.key   generated here on first start and kept
#                                       in the volume, so the server identity
#                                       survives a restart and an upgrade
#   /config/peers.conf                  the [Peer] sections, written by the CLI
#   /config/allowlist                   one `service:port` per line, written by
#                                       the CLI from the Exposed Service list
#
# Forwarding is dropped by default. Each allowlisted service gets one FORWARD
# rule and one DNAT rule from the tunnel address to that service on the
# platform network, so a Peer reaches it at <tunnel address>:<port> and
# nothing else at all (ADR 0011). Services resolve by compose service name
# because this container joins the platform network; the address is fixed at
# start, so a service recreated with a new address needs this restarted.
set -eu

conf_dir=/etc/wireguard
key="$conf_dir/server_private.key"
peers=/config/peers.conf
allowlist=/config/allowlist
address="${ACCESS_ADDRESS:-10.13.13.1/24}"
tunnel_ip="${address%%/*}"

umask 077
mkdir -p "$conf_dir"
if [ ! -f "$key" ]; then
  echo "[access] generating the server key — it stays in this volume"
  wg genkey > "$key"
fi
echo "[access] server public key: $(wg pubkey < "$key")"

{
  printf '[Interface]\nAddress = %s\nListenPort = 51820\nPrivateKey = %s\n' \
    "$address" "$(cat "$key")"
  if [ -f "$peers" ]; then
    printf '\n'
    cat "$peers"
  fi
} > "$conf_dir/wg0.conf"

iptables -P FORWARD DROP
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT

if [ -f "$allowlist" ]; then
  while IFS= read -r entry || [ -n "$entry" ]; do
    case "$entry" in
      '' | '#'*) continue ;;
    esac
    service="${entry%%:*}"
    port="${entry##*:}"
    ip="$(getent hosts "$service" | awk '{ print $1; exit }' || true)"
    if [ -z "$ip" ]; then
      echo "[access] cannot resolve $service on the platform network — not exposed"
      continue
    fi
    echo "[access] exposing $service:$port at $tunnel_ip:$port"
    iptables -A FORWARD -i wg0 -d "$ip" -p tcp --dport "$port" -j ACCEPT
    iptables -t nat -A PREROUTING -i wg0 -d "$tunnel_ip" -p tcp --dport "$port" \
      -j DNAT --to-destination "$ip:$port"
  done < "$allowlist"
fi
iptables -t nat -A POSTROUTING -s "$address" -o eth0 -j MASQUERADE

wg-quick up wg0
echo "[access] wg0 is up, listening on udp/51820"

trap 'wg-quick down wg0; exit 0' TERM INT
while :; do
  sleep 3600 &
  wait $!
done
