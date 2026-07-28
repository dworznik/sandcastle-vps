# Event visibility for a loopback-only Harness

**Ticket:** [#10](https://github.com/dworznik/sandcastle-vps/issues/10) · **Date:** 2026-07-28

## Question

The Harness binds to loopback and the VPS accepts no inbound traffic, yet the planned
autonomous loop must notice GitHub events across multiple Onboarded Projects: new issues,
label changes (`ready-for-agent`), CI check results, PR review comments. How does it see
them without exposing the VPS?

## Recommendation

**Poll GitHub's REST API from an Inngest cron function inside the existing Harness, using
authenticated conditional requests.** A watcher function on a ~60s cron iterates the
Onboarded Projects, hits a handful of targeted endpoints per repo (issues since a cursor,
PR review comments, check runs, label events) with stored `ETag`/`If-Modified-Since`
values, and emits Inngest events only for deltas. This adds **zero inbound surface, zero
new daemons, and zero new external dependencies**, and the rate-limit budget is trivial
because authorized `304 Not Modified` responses are free.

Two caveats that shape the implementation:

1. **Do not use `GET /repos/{o}/{r}/events` as the primary feed.** GitHub documents its
   latency as "anywhere from 30s to 6h" and says it "is not built to serve real-time use
   cases" ([Events API][events]). Poll the concrete resource endpoints instead; those
   reflect state immediately.
2. **Keep cursors, not just ETags.** A `since=` timestamp (issues) or last-seen ID per
   endpoint makes the watcher self-healing across Harness restarts and missed polls —
   polling is naturally reconciling, unlike webhooks.

If latency below ~1 minute or repo count beyond a few dozen ever matters, the upgrade
path is a **GitHub App** (installation rate limits scale with repo count) fronted by a
real webhook receiver behind `cloudflared` — not smee.io, and not an Actions runner.

## Options compared

### 1. Inngest cron + REST polling with conditional requests (recommended)

- Inngest supports cron triggers (`TZ=UTC */1 * * * *` style) with optional jitter
  ([Inngest scheduled functions][inngest-cron]); the self-hosted server ships the full
  Runner/Queue/Executor pipeline that does function scheduling ([Inngest self-hosting][inngest-sh]),
  so this drops into the existing stack with no new moving parts.
- Rate limits: a PAT gets **5,000 req/hr** primary, secondary limits of 900 points/min
  and 100 concurrent requests ([rate limits][limits]). Crucially, "making a conditional
  request does not count against your primary rate limit if a `304` response is returned
  and the request was made while correctly authorized" ([best practices][best]).
- Budget at scale: 10 repos × 4 endpoints × 60 polls/hr = 2,400 requests/hr *worst case
  with no caching*; in steady state almost all are 304s and cost nothing. Even 50 repos
  fit under one PAT with ETags. GitHub's own guidance for when webhooks aren't feasible
  is exactly this: fixed schedule, conditional requests, honor `x-poll-interval` ([best]).
- The Notifications API is a useful low-cost supplement (mentions, `review_requested`,
  `ci_activity`) — it advertises its own `X-Poll-Interval` and `Last-Modified`/304
  contract ([notifications][notif]).
- Latency: bounded by the poll interval (~60s). Fine for an autonomous loop whose Runs
  take minutes.
- Security/ops: outbound HTTPS only; state is a small cursor table; lives in the Harness
  under the existing systemd unit. Failure mode is graceful (next poll catches up).

### 2. Webhook relay / tunnel (smee.io, cloudflared, Tailscale Funnel)

- **smee.io**: an SSE proxy GitHub's own docs use for *testing* webhooks locally
  ([testing webhooks][smee-test]). Channels are unauthenticated — anyone with the channel
  URL can subscribe to the payload stream — and there is no delivery or availability
  guarantee. Development-only; rejected for production.
- **cloudflared**: outbound-only connection model, "traffic flows in both directions over
  the tunnel"; you can block all inbound at the firewall ([Cloudflare Tunnel][cf]). Solid
  engineering, but it still publishes a public HTTPS endpoint that routes into the
  loopback host — a deliberate re-opening of the inbound path the architecture just
  closed — plus a new daemon, a Cloudflare account/DNS dependency, and mandatory
  `X-Hub-Signature-256` verification in the Harness.
- **Tailscale Funnel**: same outbound-only shape via Tailscale relays; limited to ports
  443/8443/10000, TLS terminates on the device, and traffic "is subject to
  non-configurable bandwidth limits" ([Funnel][funnel]). Same trade-off as cloudflared
  with an extra port constraint.
- All webhook variants share a reconciliation problem: GitHub retains deliveries only
  **3 days** and "does not automatically redeliver failed deliveries" ([redelivering][redeliver]),
  so a correct system needs a backstop poll anyway — at which point the poll alone
  suffices at this scale.

### 3. Self-hosted GitHub Actions runner on the VPS

- Network posture is fine — the runner only needs "outbound HTTPS connections over port
  443" and long-polls for jobs, no inbound ports ([runner reference][runner]).
- But it is the wrong trust boundary: GitHub warns "self-hosted runners should almost
  never be used for public repositories … any user can open pull requests against the
  repository and compromise the environment," and runners "can be persistently
  compromised by untrusted code in a workflow" ([security hardening][harden]). This
  places a remote-code-execution channel (workflow files) on the very host that holds
  every Project checkout and the Docker socket.
- Also operationally poor: a workflow file committed to every watched repo, a runner
  service to update, and events arrive as *jobs to execute* rather than data. Rejected.

### 4. GitHub App + polling of webhook deliveries

- A GitHub App's webhook covers all repos of its installations, and the REST API exposes
  the delivery log: `GET /app/hook/deliveries` lists deliveries, `GET
  /app/hook/deliveries/{id}` returns the full payload, `POST …/attempts` redelivers —
  authenticated with the app JWT ([app webhooks API][app-hooks]). Pointing the app's
  webhook at a black-hole URL and polling the delivery log yields push-shaped payloads
  with no inbound port.
- Real advantages at scale: installation tokens start at 5,000 req/hr and grow **+50/hr
  per repo beyond 20** (cap 12,500) ([limits]), and payloads arrive pre-shaped as events.
- But it is a hack (every delivery records as failed), bounded by the 3-day retention
  ([redeliver]), and adds app-registration, JWT, and installation-token plumbing. Not
  worth it at current scale; the App (with a real receiver, per option 2's cloudflared)
  is the *upgrade path*, not the starting point.

## Trade-off table

| | 1. Inngest cron + conditional polling | 2a. smee.io | 2b. cloudflared / Funnel | 3. Self-hosted runner | 4. App + delivery polling |
|---|---|---|---|---|---|
| Inbound surface | None (outbound HTTPS only) | None on VPS, but channel is public-readable | Public HTTPS endpoint routed to host | None, but RCE-by-workflow on host | None |
| Latency | ~poll interval (60s) | Seconds | Seconds | Job-queue seconds–minutes | ~poll interval |
| Rate-limit budget | Trivial — 304s are free; 5k/hr headroom | n/a | n/a | n/a | Scales +50/repo, cap 12.5k/hr |
| Multi-repo scale | Linear, fine to ~50 repos/PAT | Per-hook config | Per-hook config, one endpoint | Workflow file per repo | Best (one app install) |
| Ops fit (systemd, host process, no new deps) | Best — code inside existing Harness | New client daemon, no SLA | New daemon + CF/TS account | New runner service + repo changes | App registration + JWT plumbing |
| Missed-event recovery | Inherent (next poll reconciles) | None | 3-day manual redelivery | Re-run workflow | 3-day delivery log |
| Verdict | **Recommended** | Rejected (dev tool) | Fallback for low latency | Rejected (security) | Upgrade path |

## Sources

- [REST API rate limits][limits] — 5,000 req/hr PAT; app installation scaling to 12,500; secondary limits.
- [Best practices for the REST API][best] — 304s free when authorized; polling guidance.
- [Events API][events] — "latency can be anywhere from 30s to 6h"; 300-event/30-day window.
- [Notifications API][notif] — `X-Poll-Interval`, `Last-Modified`/304 contract, `ci_activity` reason.
- [Self-hosted runners reference][runner] — outbound HTTPS 443 only.
- [Security hardening for GitHub Actions][harden] — "almost never … for public repositories"; persistent compromise.
- [Testing webhooks][smee-test] — smee.io positioned for local testing.
- [Redelivering webhooks][redeliver] — 3-day retention; no automatic redelivery.
- [GitHub App webhook deliveries API][app-hooks] — list/get/redeliver deliveries via JWT.
- [Cloudflare Tunnel][cf] — outbound-only connection model.
- [Tailscale Funnel][funnel] — relay architecture, ports 443/8443/10000, bandwidth limits.
- [Inngest scheduled functions][inngest-cron] — cron triggers with TZ and jitter.
- [Inngest self-hosting][inngest-sh] — full Runner/Queue/Executor in self-hosted server.

[limits]: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
[best]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
[events]: https://docs.github.com/en/rest/activity/events
[notif]: https://docs.github.com/en/rest/activity/notifications
[runner]: https://docs.github.com/en/actions/reference/runners/self-hosted-runners
[harden]: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
[smee-test]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks
[redeliver]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
[app-hooks]: https://docs.github.com/en/rest/apps/webhooks
[cf]: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
[funnel]: https://tailscale.com/kb/1223/funnel
[inngest-cron]: https://www.inngest.com/docs/guides/scheduled-functions
[inngest-sh]: https://www.inngest.com/docs/self-hosting
