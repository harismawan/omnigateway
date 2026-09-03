# Deploying the gateway

Running OmniGateway as a service, behind a reverse proxy, as more than one
process, and in a container. The [README](../README.md) covers the single
machine that every command there assumes; this is what changes once the
gateway is not on your laptop.

## Running it as a service

On a machine with systemd:

```bash
omni service install --enable    # writes a user unit for this installation
omni start                       # from here on, start/stop delegate to systemctl
omni console                     # reads the journal (or the log file, without systemd)
```

Use `--system` for a system-wide unit (needs root). Without systemd, `omni
start` supervises the process itself with a pidfile under
`~/.local/state/omnigateway`. Either way, `omni start` returns only once
`/health` actually answers.

### Restarting and stopping from the console

The console can restart and shut down the gateway from the foot of its sidebar.
Restart works under systemd — the gateway asks the manager rather than
signalling itself, because a handled SIGTERM exits cleanly, which systemd's
`Restart=on-failure` reads as success — reports uncertainty in a container,
whose restart policy cannot be read from inside, and disables itself with no
supervisor; use `omni restart` from a terminal there. Shutdown is offered in
every shape. In a container it is a one-way door: bring the process back from
the host.

## Behind a reverse proxy

Set `OMNI_BASE_URL` to the public HTTPS origin, or OAuth callbacks come back to
the wrong host.

Beyond that, two things travel badly through a proxy, and both are streams.
Client responses on `/v1/*` are server-sent events, and the console keeps one
WebSocket open on `/api/stream`. Neither is optional: buffer the first and every
token of an agent's reply arrives at once at the end, and drop the second and
the console silently falls back to polling.

Caddy and Cloudflare pass WebSockets and unbuffered responses by default and
need nothing. nginx needs telling:

```nginx
location / {
    proxy_pass http://127.0.0.1:9000;
    proxy_http_version 1.1;

    # Without these two the Upgrade handshake never reaches the gateway and the
    # console shows LIVE·POLL instead of LIVE·PUSH. It keeps working — the
    # fallback exists for exactly this — but you paid for a socket you are not
    # getting.
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";

    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;

    # The socket's heartbeat is 20s and it gives up on a missed pong at 60s.
    # A read timeout below that closes a healthy connection from the outside,
    # and the console reconnects in a loop that looks like an unstable gateway.
    proxy_read_timeout 300s;

    # SSE must not be buffered. The gateway already sends
    # `x-accel-buffering: no` on streaming responses, which nginx honours on its
    # own, so this line is belt and braces for a proxy chain where something
    # else strips that header before nginx sees it.
    proxy_buffering off;
}
```

The gateway sends downstream `: keepalive` comments on streaming responses
because provider heartbeats are decoded away, so an idle stream still looks
alive to whatever sits in between. Keep any idle timeout in the proxy above
your longest expected request.

## Running more than one gateway

One process on SQLite is the default and is what every command in the README assumes. A
fleet — several replicas behind a load balancer, on Kubernetes or otherwise — is **cluster
mode**, switched on by `OMNI_CLUSTER_MODE=true` and needing two things beside the gateway:

- **Postgres** as the store, named by `OMNI_DATABASE_URL`. Every replica reads and writes one
  database; there is no SQLite file, no snapshot, no restore, and no `omni db vacuum` — those are
  `pg_dump`'s job now, and the Database screen says so.
- **Redis** (or Valkey) as the coordinator, named by `OMNI_REDIS_URL`. It holds what a fleet must
  agree on and a database is the wrong shape for: the per-minute request ring and the concurrency
  gauge, the long-window counters, admin sessions, pending OAuth flows, quota-probe cooldowns, the
  leases that make the background loops run once rather than N times, and the fan-out that lets a
  console on one replica hear a change made on another.

```bash
OMNI_CLUSTER_MODE=true
OMNI_DATABASE_URL=postgres://omni:secret@db.internal:5432/omni
OMNI_REDIS_URL=redis://cache.internal:6379
OMNI_ENCRYPTION_KEY=…   # the same on every replica
```

Boot refuses the switch without both URLs, and refuses either URL without the switch: a
replica that believes it is clustered and is not is the failure this variable exists to make
loud.

What holds across the fleet, exactly: every API-key limit at every window and dimension; token
refresh, which one replica performs while the others wait and reuse the result; a cookie issued
by one replica, which every other verifies and a password change ends everywhere. What is
per-replica and says so: the console's **Console** screen shows one process's stdout, so it grows
a selector when there is more than one, and its default view is every process merged by time.
What is per-replica and does not say so: the routing `load` weight is one round trip stale
between replicas, so a burst arriving at once on two of them can stack for that long.

**No sticky sessions are needed.** The WebSocket the console holds may land on any replica; the
ingress only needs to pass upgrades and hold an idle timeout above ten seconds. A rolling deploy
closes each replica's sockets with `1001`, the console reconnects to a live one and refetches
once.

**When Redis is unreachable**, the request path keeps serving: each replica falls back to its
own in-memory counters, so limits degrade to N-fold until Redis returns, and one line per thirty
seconds says so (`coord=redis coordFallback=true`). The console does not: a session that cannot
be checked against the shared store is refused with `503`, because a session verified locally is
one a password change on another replica cannot end. `GET /health` reports `mode`, `nodeId` and
`coord` (`ok` or `fallback`) for a readiness probe to read.

Plugins are loaded from each replica's own `<root>/plugins/`; bake them into the image so every
replica holds the same set. Plugin storage is Postgres in cluster mode, so a plugin's SQL is
written for it. `POST /api/restart` refuses in cluster mode — roll the deployment instead.

### Log capture in a fleet

In a fleet, capture is per process. Each replica can capture its own — tee its stdout to a file
inside the container and point `OMNI_LOG_FILE` at the same path — and the Console screen then
merges every process's tail and lets you pick one. That is worth having for an incident on a
running pod, and it is not a log stack: the file dies with the container, nothing rotates it, and
the screen reads one process at a time. Ship stdout to a collector for anything beyond that —
Elasticsearch and Kibana, Loki and Grafana, or whatever already reads your containers — where the
lines outlive the process that wrote them and can be searched across all of them at once. The
Console screen says so itself when it finds a fleet capturing nothing.

### Moving an existing SQLite installation onto Postgres

```bash
omni stop
omni db migrate --to postgres://omni:secret@db.internal:5432/omni
```

It copies credentials (re-encrypted with the same `OMNI_ENCRYPTION_KEY`), API keys, virtual
models, settings, both passwords and every completed request log into an **empty** Postgres
database, rebuilds the rollups, and prints what it did not carry: request bodies, `usage_daily`
older than the retained logs, quota readings and breaker state (re-measured within a poll
interval), sessions, and `plugin_*` tables, whose SQL is the source dialect's. It refuses while a
gateway is running and refuses a target that holds anything.

## Docker

```bash
docker build -t omnigateway .
docker run --rm \
  -p 9000:9000 \
  -e OMNI_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v omnigateway-data:/data \
  omnigateway
```

The container listens on `0.0.0.0:9000`, serves the console, and keeps its
database and plugins under `/data`. It runs as the unprivileged `bun` user and
carries a `HEALTHCHECK` on `/health`.

For a fleet, set `OMNI_CLUSTER_MODE=true` with `OMNI_DATABASE_URL` and `OMNI_REDIS_URL` and
drop the volume;
see [Running more than one gateway](#running-more-than-one-gateway). A
Kubernetes deployment — Deployment, Service, Ingress with the timeouts streaming
needs, HPA, and an example Secret — is under `k8s/` as a kustomize
base:

```bash
cp k8s/secret.example.yaml k8s/secret.yaml   # edit it
kubectl apply -f k8s/secret.yaml
kubectl apply -k k8s
```

Releases deploy by GitOps: a `v*` tag publishes `ghcr.io/harismawan/omnigateway:<version>`
and the workflow commits that version into `k8s/kustomization.yaml` on `main`, which Argo
CD syncs. Rolling back is editing `newTag` by hand.

Plugins in a fleet are baked into the image so every replica holds the same
set: `COPY plugins/ /data/plugins/` in a derived Dockerfile. The image is
public, so no pull secret is configured; a private fork adds
`imagePullSecrets` to the Deployment.

Give the container a restart policy — `--restart unless-stopped` — if you want a
restart request to bring it back. A container cannot read its own policy, so
without one an exit is simply the end of the installation until you start it
again from the host.

**In Docker**, a plugin is mounted at `<root>/plugins/<id>` on a volume — the same
layout `install` writes — and the container restarted; read-write, not `:ro`,
because a plugin declaring `files` writes its cache inside its own directory.
See [plugins.md](plugins.md) and [writing-a-plugin.md](writing-a-plugin.md).
