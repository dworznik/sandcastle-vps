import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { env } from './env.js'

// One listener. The Harness is a container: the Orchestrator reaches it by
// service name over the compose network, and the Target sees only what compose
// publishes — loopback (see `env.host`).
//
// No listen-error handler: the one this had existed to lose the dockerd boot
// race gracefully, and both the race and the systemd unit that restarted after
// it are gone. A bind failure now throws, and compose's restart policy is the
// supervisor.
serve({ fetch: createApp().fetch, hostname: env.host, port: env.port }, () => {
  console.log(`sandcastle-vps harness listening on ${env.host}:${env.port}`)
})
