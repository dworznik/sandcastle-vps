# Diagrams

Plain, commented SVG. They are the source of truth — edit them here rather than
re-exporting from somewhere else, and keep them next to the decision they
illustrate.

| File                                     | Shows                                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`host-topology.svg`](host-topology.svg) | Where every container lives across the dev machine, the OrbStack stand-in and the VPS: the compose project holding both halves of the platform, the socket and path-parity mounts the Harness holds, and the ephemeral Sandbox a Run spawns as its sibling. |
| [`run-lifetimes.svg`](run-lifetimes.svg) | What is long-lived and what lasts one Run — the two compose services against the Sandbox containers that come and go with each Dispatch.                                                                                                                    |

Both carry their own palette and adapt to a dark viewer. They load no webfont:
a committed SVG is usually viewed as an image, which fetches nothing external,
so the type falls back to the system faces.

## What they are drawn against

The containerised Harness of [ADR 0006](../adr/0006-containerised-harness-and-installer-over-connectors.md).
A Target deployed before that keeps its host-process install until the next
deploy re-creates the stack, so the topology is the shape `compose.yaml`
produces rather than a photograph of any particular machine.

There is deliberately no credential diagram here yet. The per-Project model it
would show is the one ADR 0006 replaces with Harness-held credentials injected
per Run; drawing it now would commit a picture of something being removed.
