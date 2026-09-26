# The Memory UI's proxy: what Access exposes in place of the claude-mem
# worker (ADR 0011). The worker accepts only loopback origins and offers no
# setting to change that, so over the VPN its viewer loads and every write is
# refused; this rewrites the Origin header on the way in (proxy.nginx.conf)
# and forwards to the worker by service name on the platform network. Built
# on the Target by the creator CLI as part of the Memory compose project
# (src/cli/memory.ts), on the same base as the Access image.
#
# TEMPORARY BY DECLARATION (ADR 0010). Remove this file, proxy.nginx.conf
# and the `memory-ui` service in src/cli/memory.ts, and point MEMORY_UI in
# src/cli/access.ts at the worker, once an upstream claude-mem release adds a
# configurable origin list.
FROM alpine:3.21

RUN apk add --no-cache nginx

COPY proxy.nginx.conf /etc/nginx/http.d/default.conf

EXPOSE 37777
CMD ["nginx", "-g", "daemon off;"]
