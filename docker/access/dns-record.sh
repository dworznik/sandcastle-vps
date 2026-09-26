#!/bin/sh
# Create or update one unproxied A record in a Cloudflare zone, from inside
# the Access container, where curl and jq are. Called by the creator CLI
# (src/cli/access.ts) for the two records the optional DNS layer keeps:
#
#   dns-record.sh <zone> <name> <content>
#
# <content> is an address, or `auto` for this Target's public address as
# Cloudflare sees it. The API token arrives on stdin and goes into a curl
# config file under a 077 umask — never onto a command line, where every
# other process on the Target could read it (ADR 0011).
#
# Both records are unproxied: the public one names a WireGuard endpoint,
# which is UDP and cannot go through Cloudflare's HTTP proxy, and the
# internal one is a private address the proxy could not reach anyway.
set -eu

zone="$1"
name="$2"
content="$3"
api=https://api.cloudflare.com/client/v4

umask 077
cfg="$(mktemp)"
trap 'rm -f "$cfg"' EXIT INT TERM
{
  printf 'silent\nshow-error\n'
  printf 'header = "Authorization: Bearer %s"\n' "$(cat)"
  printf 'header = "Content-Type: application/json"\n'
} > "$cfg"

if [ "$content" = auto ]; then
  content="$(curl -sS https://cloudflare.com/cdn-cgi/trace | sed -n 's/^ip=//p')"
  if [ -z "$content" ]; then
    echo "could not learn this Target's public address from Cloudflare" >&2
    exit 1
  fi
fi

zone_id="$(curl -K "$cfg" "$api/zones?name=$zone" | jq -r '.result[0].id // empty')"
if [ -z "$zone_id" ]; then
  echo "zone $zone was not found, or the token cannot read it (it needs Zone:Read and DNS:Edit)" >&2
  exit 1
fi

record_id="$(curl -K "$cfg" "$api/zones/$zone_id/dns_records?type=A&name=$name" |
  jq -r '.result[0].id // empty')"
body="$(jq -n --arg name "$name" --arg content "$content" \
  '{ type: "A", name: $name, content: $content, ttl: 300, proxied: false }')"

if [ -n "$record_id" ]; then
  action=updated
  answer="$(curl -K "$cfg" -X PUT "$api/zones/$zone_id/dns_records/$record_id" --data "$body")"
else
  action=created
  answer="$(curl -K "$cfg" -X POST "$api/zones/$zone_id/dns_records" --data "$body")"
fi

if ! printf '%s' "$answer" | jq -e '.success' > /dev/null; then
  printf '%s' "$answer" | jq -r '.errors[]?.message // "the API refused the record"' >&2
  exit 1
fi
printf 'record\t%s\t%s\t%s\n' "$name" "$action" "$content"
