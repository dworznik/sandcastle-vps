# Self-hosted Inngest over Inngest Cloud

Inngest Cloud was evaluated as a replacement for the self-hosted Orchestrator this stack runs (ADR 0002) and rejected for now. It does not change the state model: the run-status opacity that rules Inngest out as a state store (ADR 0004) lives in shared server code and behaves identically on Cloud. What Cloud would change is retention, in the wrong direction — self-hosted prunes nothing, whereas Cloud retains traces for 24 hours on the free tier and 7 days on Pro. The Loop routinely holds an issue in a waiting Phase for longer than that, so run history would expire while the work it describes is still in flight. Cloud's one real gain is that `meta.sessions` stops returning 501, making "every Run for issue #42" a first-class query.

Against that gain sit three costs. Connect — the outbound-only transport that would let the Harness reach Cloud without exposing an inbound port — is documented as Public Beta, and this system's entire purpose is to run unattended. Cloud persists event payloads and step outputs, which here means task prompts and agent output, on infrastructure Inngest documents as United-States-only with no EU region; `@inngest/middleware-encryption` offers genuine end-to-end encryption but sits outside the scope of their SOC 2 audit. Cost is not the deciding factor at this volume — a few thousand Runs a month sits inside the free tier, since executions meter runs and steps rather than wall-clock time — though that tier's 5 concurrent executions becomes a ceiling once several Projects run at once, because an actively executing step holds a slot for its full duration.

## Considered Options

- **Migrate to Inngest Cloud now** — rejected: retention loss, a beta transport, and US-only payload storage, in exchange for a durability gain available more cheaply on the VPS.
- **Cloud with the encryption middleware** — rejected for now: it addresses payload exposure but not retention or beta status, and its interaction with `waitForEvent` matching, `cancelOn`, and dashboard readability is undocumented.

## Consequences

- Self-hosting's real weakness has to be fixed locally instead. `inngest start` backs its queue and run state with an in-memory Redis snapshotted every 60 seconds, so an ungraceful kill loses up to a minute of queue mutations and registered pauses. Point `--redis-uri` at a durable Redis rather than accepting that window.
- Nothing prunes events, runs, or traces; unbounded table growth is this stack's problem to manage.
- Revisit when VPS operational burden becomes the actual pain, or when Connect reaches GA. Do not revisit on cost — cost is not what is being traded here.
- Connect is worth adopting independently of Cloud. The Harness uses `serve()` on an inbound `/api/inngest` route, which is why `compose.yaml` needs host networking; an outbound connection would remove the inbound listener altogether and may let that constraint go.
