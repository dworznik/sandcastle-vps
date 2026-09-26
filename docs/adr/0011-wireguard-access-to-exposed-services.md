# WireGuard access to exposed services, managed by the CLI

The README promised that nothing listens on the Target's public interface, with remote access over an SSH tunnel and the install checking the promise from outside. ADR 0010 makes the platform the operator's agent VPS, and the operator wants its dashboards — claude-mem's UI and the Inngest dashboard on day one — reachable from their own devices without an SSH tunnel per session, a TLS certificate per service, or a login per service. **Access is a WireGuard VPN, provisioned and managed by the CLI**, with services reached over it by plain HTTP at private addresses. What the VPN buys is that any container port becomes reachable with no per-service hostname, route, certificate or login: the network is the authentication. What it costs, and why this is recorded: **access is network-level rather than identity-level**, so anyone holding a Peer config reaches every Exposed Service, and one public listener now exists — WireGuard's UDP port — on a Target where access is enabled. For a single operator that is the right trade.

**Exposure is an allowlist, not a bind.** claude-tmux's WireGuard container, which this ports, drops all forwarding by default and adds one DNAT rule per allowlisted service from the tunnel address to that service on the compose network; services themselves bind nowhere reachable. The CLI writes the allowlist from the exposed-service list, so "exposed" means "in the allowlist" and nothing becomes reachable by accident. **The Dispatch surface is never exposed**: it is keyless by design, reachability is its access control, and it is the one endpoint that does work on the operator's behalf rather than showing them things. The install's exposure check reads TCP listen tables and is unchanged: WireGuard is UDP, and DNAT creates no listener. Only the README's sentence changes, to "nothing but WireGuard".

**Peers are CLI-managed.** claude-tmux held one static peer in `.env`. Here a command adds a device and prints a QR code or writes a config, a command revokes it, and `status` lists them; the peer list is Target-side Local Config. **DNS is optional.** Without a domain, peer configs carry the Target's public address and the CLI prints services as private address and port, so access works on an OrbStack Target with no public address to name. With a domain on Cloudflare, two records are written through the API token that already exists: the public endpoint, kept current by ddclient as today, and an internal name at the private tunnel address, unproxied, so services are `http://<name>:<port>` — claude-tmux's `agent.in.veri.lol` is exactly this. The private address leaks into public DNS, which is harmless.

## Considered Options

- **Cloudflare Tunnel with Cloudflare Access** — rejected, though it was the first recommendation: it keeps the no-public-listener invariant untouched and gates each service by identity, but it needs an ingress entry per service and puts a third party in the path of every request to the operator's memory store. The per-service configuration is what the operator wanted to be rid of.
- **Tailscale** — rejected: a client per device, no real domain, and a third-party control plane.
- **SSH tunnels only** — rejected: the status quo, and the reason the question exists; awkward from a phone and a tunnel per dashboard per session.
- **Publishing services on the WireGuard interface's address** — rejected in favour of the DNAT allowlist: it would create real listeners the exposure check would have to learn to allow, whereas DNAT is invisible to the check by construction rather than by exception.
- **Routing all VPN traffic to loopback, so everything published there is reachable** — rejected: "any service" would include ones nobody intended, and the point of the check is that intent is written down.
- **Internal DNS only when someone asks** — rejected: one unproxied A record is the whole cost, and the operator uses it today.

## Consequences

- The README's "nothing listens on the public interface" becomes "nothing but WireGuard, on a Target where access is enabled". ADR 0006's loopback clause is qualified, not reversed: the Dispatch surface and the dashboard stay on loopback.
- `status` reports whether access is enabled and lists Peers. `access` is a toggle independent of `sessions` (ADR 0010).
- Exposed Services on day one: claude-mem's UI and the Inngest dashboard. Adding one is a CLI-written config entry, never a hand-edit on the Target.
- The claude-mem worker rejects writes from non-localhost origins, so over the VPN its UI is read-only until the Origin-rewriting proxy of ADR 0010 is in place.
- Moving the VPS off claude-tmux means new Peer configs for each device: a QR scan per device, not a migration.
