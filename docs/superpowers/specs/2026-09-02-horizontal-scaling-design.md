# Horizontal scaling: running one installation as many stateless replicas

## Problem

The gateway is written as one process. Nine comments say so as a design premise
(`apps/gateway/src/dispatch/loadRegistry.ts:12`, `apps/gateway/src/auth/rateLimit.ts:246`,
`packages/control/src/database.ts:17`, `packages/control/src/quota/poll.ts:24`,
`apps/gateway/src/index.ts:135`, `apps/gateway/src/app.ts:55,57,82`,
`apps/gateway/src/stream/console.ts:19`), and there is no coordination primitive of any
kind: no lease, no advisory lock, no node id, no owner column. An inventory
(2026-09-02) found 34 pieces of process-local state. Running two replicas against
one installation today produces, in order of severity:

1. **A dead credential.** OAuth refresh coalescing is a per-process map
   (`packages/control/src/oauth/refresh.ts:35`) and `updateSecrets` is last-writer-wins.
   Two replicas refreshing a rotating-token credential at once invalidate every rotation
   but the last; the stored refresh token is one the provider already revoked, and only a
   browser re-auth recovers it.
2. **Double-billed rollups.** `sweepPending()` at boot (`packages/store/src/sqlite/usage.ts:319`)
   retires every `state='pending'` row, not this process's. A rolling deploy marks the other
   replicas' in-flight requests `499`, then the real owner completes them again, and
   `rollupLog`/`rollupHour` are additive — `usage_daily` and `usage_rollup` both count twice,
   and `sumSince` reads the corrupted number for rate limiting.
3. **Corrupted install on operator action.** The exclusive database-operation lock, the
   quiesce latch and the restore/swap fan-out are all process-local file semantics; a second
   replica keeps serving from a file being replaced beneath it.
4. **Limits that are N× the configured ceiling.** The `1m` ring, the concurrency gauge, the
   `sumSince` cache and its debit delta, the `LoadRegistry` in-flight counts and the quota
   probe cooldown map are each per-process.
5. **A console that works on one replica only.** Sessions are an in-memory `Map`
   (`packages/control/src/adminAuth.ts:100`), so a cookie issued by one pod is a `401` on the
   next; push frames reach only sockets on the emitting pod; pending OAuth flows must
   complete on the pod that started them; a password change logs out one pod.

This spec makes a fleet of stateless replicas correct on every point above while leaving
the single-node SQLite install byte-for-byte unchanged in behaviour.

## Decisions taken before design

Recorded because each closes a door the design otherwise had to keep open.

- **Target is many stateless replicas on Kubernetes.** No local disk survives a pod, no
  shared filesystem is assumed. This rules out SQLite in WAL mode over a shared volume —
  WAL does not work over NFS — and rules out `request_bodies/` as a file tree.
- **Two external dependencies: Postgres and Redis.** Postgres is the shared store, Redis the
  coordination layer. No object storage in this spec.
- **Single-node SQLite keeps working unchanged.** `omni`, the npm package, the Docker image
  and every existing install run exactly today's code path. Cluster mode is opt-in.
- **`1m` and `concurrency` limits are exact across the cluster**, and **`5h` and `1w` are
  exact across the cluster too** — the latter was first scoped out and then scoped back in.
- **Redis unreachable on the proxy path fails open** to per-replica behaviour with a log
  line; Redis unreachable on the console path fails closed.
- **Plugin storage becomes async**, breaking `@omnigateway/plugin-api`. Refusing storage
  plugins in cluster mode and sharding them onto per-pod SQLite were both considered and
  rejected: the first leaves the capability half-published, the second is silent data loss.
- **Request bodies live in Postgres as `bytea`** in cluster mode. The snapshot invariant
  ("a snapshot is never a prompt corpus") holds for SQLite mode, where snapshots exist, and
  does not apply to Postgres mode, where the operator's `pg_dump` is theirs to scope.
- **Sessions and pending OAuth flows live in Redis**, not in the store. They are TTL'd
  ephemera; putting them in Redis keeps the single-node behaviour ("restart logs everyone
  out, nothing on disk to replay") intact through the memory implementation.
- **Per-pod console log, exact long windows and a data-migration command are in scope.**

## Mode selection

One environment variable decides:

- `OMNI_DATABASE_URL` absent → **single-node mode**. SQLite at `OMNI_DB_PATH`, in-memory
  coordination. Today's wiring, today's behaviour.
- `OMNI_DATABASE_URL=postgres://…` → **cluster mode**. `OMNI_REDIS_URL` is required; boot
  refuses without it in one sentence. `OMNI_ENCRYPTION_KEY` remains required in both.

There is no third mode. A Postgres store with in-memory coordination would be a fleet with
N× limits and one working console, which is the shape this spec exists to remove; a SQLite
store with Redis coordination has no use.

`GET /health` gains `mode: "single" | "cluster"`, `nodeId`, and
`coord: "ok" | "fallback"`. The dashboard's `/health` watcher stays a plain `fetch` and
reads none of it; Kubernetes readiness may.

## Node identity

`nodeId = crypto.randomUUID()` at boot. It is the lease holder id, the owner stamp on
`request_logs.node_id` (new column, both backends), the prefix of every WebSocket
connection id (`<nodeId>:<n>`) and the console-log topic suffix. A `nodes(id, seen_at,
version, log_capture)` table receives a heartbeat every 10 s from each replica; a row not
seen for 60 s is dead. Single-node mode writes the same row — there is one — so the
`nodes` reader has no mode branch.

## `packages/coord`

A new package under the same rule as `packages/ratelimit`: pure interface and types, one
in-memory implementation, no transport, `now` always a parameter where time matters.
Every consumer takes a `Coord` by injection and reads it at call time — the threading rule
in `CLAUDE.md` applies in full, and the cluster test below is what enforces it.

```ts
export interface Coord {
  window: {
    /** Records one event and reports what the window held before it. Unconditional. */
    claim(key: string, windowMs: number, now: number): Promise<{ stamp: number; before: WindowCounter }>;
    rollback(key: string, stamp: number): Promise<void>;
  };
  gauge: {
    /** Raises the gauge and reports what it held before. */
    acquire(key: string, ttlMs: number): Promise<number>;
    release(key: string): Promise<void>;
    read(key: string): Promise<number>;
    snapshot(prefix: string): Promise<ReadonlyMap<string, number>>;
  };
  buckets: {
    /** Add `delta` to the bucket containing `now`; one call covers every dimension. */
    add(key: string, grainMs: number, windowMs: number, now: number, delta: Counts): Promise<void>;
    /** Sum of every live bucket, or `null` when the key has never been seeded. */
    sum(key: string, grainMs: number, windowMs: number, now: number): Promise<Counts | null>;
    seed(key: string, grainMs: number, rows: readonly [bucketStart: number, Counts][]): Promise<void>;
  };
  lease: {
    acquire(name: string, holderId: string, ttlMs: number): Promise<boolean>;
    renew(name: string, holderId: string, ttlMs: number): Promise<boolean>;
    release(name: string, holderId: string): Promise<void>;
  };
  mutex: {
    /** Runs `fn` under a cluster lock or throws `LOCK_UNAVAILABLE` after `waitMs`. */
    withLock<T>(key: string, ttlMs: number, waitMs: number, fn: () => Promise<T>): Promise<T>;
  };
  kv: {
    set(key: string, value: string, ttlMs: number): Promise<void>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<void>;
    delPrefix(prefix: string): Promise<void>;
  };
  pubsub: {
    publish(topic: string, payload: string): Promise<void>;
    subscribe(pattern: string, fn: (topic: string, payload: string) => void): () => void;
  };
  incr(key: string): Promise<number>;
}
```

Eight primitives and nothing else. Each exists because a named site below needs it; a
primitive with no consumer in this spec is not added, and each lands in the pull request that
brings its first consumer — PR 1 ships `window`, `gauge` and `mutex`.

`window.claim` and `gauge.acquire` carry **no ceiling**. The ceiling is judged by the caller,
which holds every dimension's figure and renders headroom from the one `evaluate`; what the
primitive guarantees is that two claims taken together each see the other. Putting the
ceiling in the primitive would have duplicated `evaluate` in Lua.

**Memory implementation** (`packages/coord/src/memory.ts`) is today's code moved: the
`SlidingWindow` ring behind `window`, `KeyState.inFlight` and `LoadRegistry` behind
`gauge`, the session `Map` behind `kv`, the refresh `inFlight` map's serialisation behind
`mutex`. `lease.acquire` always grants. `pubsub` is an in-process emitter. It is the
single-node implementation, not a test double: single-node mode runs it in production, so
the proxy path in that mode is the same code it is today with one indirection.

**Redis implementation** lives in `apps/gateway/src/coord/redis.ts`, because the host owns
transport and `packages/coord` must stay pure. `window.claim`, `gauge.acquire`,
`buckets.add` and `buckets.sum` are one Lua script each — the atomic check-and-stamp that
`admit`/`consume` already require before any `await`, moved into the server. `mutex` is
`SET key holder NX PX ttl` with release by compare-and-`DEL` in Lua. `kv.delPrefix` uses
`SCAN` + `UNLINK`, never `KEYS`. `pubsub.subscribe` takes a pattern (`PSUBSCRIBE`) because
the console-log fan-out needs `console:*`.

### Fail-open, and where it is refused

The Redis implementation wraps every call. On a transport error it logs once per 30 s
through two new `LogFields` keys — `coord: "redis" | "memory"` and `coordFallback: true`,
closed values, a security-reviewed addition of exactly two names — and then:

| Primitive | On Redis failure | Why |
| --- | --- | --- |
| `window`, `gauge`, `buckets` | delegate to an embedded memory `Coord` for that call | proxy path never depends on Redis; limits degrade to per-replica until it returns |
| `pubsub`, `incr` | delegate to memory | push degrades to this-pod-only; nothing is lost that a refetch does not recover |
| `lease` | return `false` | a lease you cannot confirm is one you do not hold; the loop skips this tick |
| `mutex` | throw `LOCK_UNAVAILABLE` | the caller decides; refresh falls back to CAS (below) |
| `kv` | throw `UNAVAILABLE` | a session verified against a fallback map is one a password change elsewhere cannot end |

`kv` failing closed means the console and `/api/client/*` answer `503 UNAVAILABLE` while
Redis is down — spelled differently from a bad cookie, so the login screen says "try
again", not "wrong password". `/v1/*` is unaffected: API keys verify against the store and
never touch `kv`.

## The Postgres store

`packages/store/src/postgres/` implements the same `Store` interface. `createStore` picks
the implementation from the URL. Driver is `Bun.sql`, which is stdlib; no new dependency.

**Migrations** are a parallel list under `postgres/migrations/`, numbered from `001`,
never shared with SQLite's. The runner wraps itself in `pg_advisory_lock` on a fixed
constant so N replicas booting together serialise and the later ones find nothing to apply.
Plugin migrations take the same lock. The SQLite runner is unchanged.

**Repos.** Fifty-two of the sixty methods are already async and translate one-to-one. The
ones whose semantics change, both backends unless stated:

- `UsageRepo.begin` writes `node_id`. `sweepPending(nodeId)` retires
  `state='pending' AND node_id = ?` — this pod's own rows. Rows belonging to a node absent
  from `nodes` or unseen for 60 s are swept by the maintenance loop under its lease. The
  SQLite implementation takes the same signature and the same rule; on one node every
  pending row belongs to the one id or to a dead one, so the observable behaviour is
  today's.
- `CredentialRepo.updateSecrets(id, secrets, expectedVersion)` becomes compare-and-swap on
  a new `token_version` column: `WHERE id = ? AND token_version = ?`, returning whether
  a row was written. `openForRefresh` returns the version it read.
- Probe cooldowns moved to `coord.kv` under `quota:cooldown:<id>` with the cooldown as TTL,
  **not** to a column: the comment on the old map argued a cooldown outliving the process is
  worse than none, and a TTL'd key shares it across replicas without outliving it. Landed in
  PR 2.
- `BodyRepo` in Postgres stores `bytea` in a `request_bodies` table. `sweepOrphans` is a
  no-op there (no files to orphan); `pruneToCap` sums `octet_length`. The SQLite
  implementation is untouched — files stay.
- `MaintenanceRepo.vacuum`, `snapshotTo`, `inspect` throw `UNSUPPORTED` in Postgres.
  `GET /api/database` reports `mode`, and the console hides the database panel when it is
  `"postgres"`. Quiesce, swap, restore and the exclusive lock are not ported; `omni db *`
  refuses in cluster mode with "use pg_dump".
- `routing.version()` — Postgres has no `PRAGMA data_version`. A `config_version` sequence
  is bumped by trigger on `virtual_models`, `credentials` and `settings`, and read per
  snapshot check. The `subscribe` fast path is fed by `coord.pubsub` topic `routing`, which
  every write site publishes after commit, so a remote health or quota write patches the
  snapshot instead of rebuilding it.
- `rollupLog`/`rollupHour` port as `INSERT … ON CONFLICT DO UPDATE SET n = n + EXCLUDED.n`.
  The additive design is what makes `sweepPending` scoping load-bearing: nothing else may
  complete a row twice.

**Plugin storage goes async.** `PluginRepo.run/all/get/transaction` return promises in
both backends. `@omnigateway/plugin-api` moves to `0.3.0` and `PLUGIN_API_VERSION` to `3`;
the loader refuses `api: 2` manifests with a message naming the change (the gate at
`apps/gateway/src/plugins/loader.ts:252` already exists). `transaction(fn)` runs `fn` on a
dedicated connection. The `{{name}}` placeholder and table guard are unchanged. Plugin SQL
is the backend's dialect — the plugin author's problem, stated in `writing-a-plugin.md`.

## Moving process-local state

### Rate limits — `apps/gateway/src/auth/rateLimit.ts`

- `1m` ring → `coord.window.claim(keyId, 60_000, ceiling, now)`. Rollback by the returned
  stamp. The "stamp before any `await`, roll back on refusal" invariant survives because in
  Redis the script *is* the stamp.
- `concurrency` → `coord.gauge` keyed on the API key, TTL = request deadline + 30 s. Release
  at request scope at the same sites as today. The TTL replaces "the gauge dies with the
  process": a pod that dies mid-request leaks nothing past its deadline.
- `5h` and `1w` → `coord.buckets`. Per key, a `5h` hash of 1-minute buckets (300 fields) and
  a `1w` hash of 1-hour buckets (168), each field holding `requests|tokens|spend`. Debit in
  `finishLog` — already the at-most-once site — writes the store first, then one `add` for
  both grains. Admit calls `sum` once. Over-count is bounded by one bucket at the trailing
  edge, which is the direction the existing invariant permits, and it slides finer than
  today's 30 s cache. Redis is a cache in front of `usage_rollup`; the store stays the
  truth. `sum` returning `null` (Redis restart, fresh key) makes the replica seed from the
  store under `coord.mutex("seed:<keyId>")` — hourly rows straight from `usage_rollup` for
  `1w`, `request_logs` grouped by minute for `5h`. `KeyState.counts`, `debits`, `stale` and
  `markEager` are deleted; the memory implementation holds the same two hashes in-process,
  so single-node mode runs one code path, not a preserved old one. `ApiKeySummary.limitUsage`
  still reads the store.

### Routing load — `apps/gateway/src/dispatch/loadRegistry.ts`

Two sources, read together. A **local map stays, synchronous and exact**: `counts()` and
`acquire()` run without a yield between them, so a burst on one process ranks and claims
one request at a time. This was measured, not assumed — the first version made both
`async`, and the burst test in `dispatch.test.ts` failed at once: even an `await` on an
already-resolved promise yields a microtask, and nine dispatches all ranked on the same
empty snapshot. The shared gauge is **sampled** by `refresh()`, the one `await` before
rank, and `counts()` reports `max(local, sample)` per key — so a process never under-reads
itself and never double-counts what it published. A burst split across processes can
stack for one round trip, and nothing short of ranking inside the shared service could
prevent it. Fail-open falls back to the local map, which is today's behaviour.

### OAuth refresh — `packages/control/src/oauth/refresh.ts`

Three layers, and each covers a hole the previous leaves:

1. The local `inFlight` map stays. It folds fifty concurrent requests on one pod into one
   lock attempt — wasteful without it, not wrong.
2. `coord.mutex.withLock("refresh:<credentialId>", 30_000, 30_000, …)` serialises the
   provider call across pods. Inside the lock the credential is **re-read**; if `expiresAt`
   is now in the future another pod already refreshed, and the fresh token is used without
   calling the provider. The re-read is the dedup; the lock only serialises.
3. `updateSecrets` CAS refuses a write whose version is stale, and the caller re-reads. This
   covers a lock lost to TTL on a slow provider, a GC pause past the lock, and Redis failing
   open. Lock TTL is 30 s because that is already the token-call deadline; a lock expiring
   mid-refresh means the call already failed.

Lock alone is insufficient: a rotating-token provider is broken by one lost rotation, and a
lock with a TTL can be lost exactly once. CAS alone is insufficient: it stops the double
write but not the double provider call, after which the stored token is the first rotation
and the provider has already revoked it. `control` receives `Coord` by injection and holds
the interface only (rule 6).

### Background loops — `apps/gateway/src/index.ts:322`

Refresh scheduler, quota poller and maintenance each run under
`coord.lease(name, nodeId, 2 × interval)`; a tick without the lease skips. The memory
implementation always grants, so single-node mode is unchanged. Dead-node `sweepPending`
runs inside the maintenance tick. The console log stream runs on every pod, because there
is one stdout per pod.

### Sessions — `packages/control/src/adminAuth.ts`

The `Map` becomes `coord.kv` under `sess:<kind>:<sha256(token)>` with value
`{expiresAt, principal}` and TTL `sessionTtlMs`. The token itself is never stored, so a
Redis dump is no more replayable than the map was. `dropKind(kind)` is
`delPrefix("sess:<kind>:")`, `clear()` is `delPrefix("sess:")`. The `client` principal's
per-verify `store.keys.get` re-check is unchanged. In single-node mode the memory `kv` is a
`Map` with expiry — today's store, today's "restart logs out".

### Pending OAuth flows — `packages/control/src/oauth/pending.ts`

Same primitive, `oauth:pending:<state>`, TTL = the flow's existing expiry. The browser
callback may land on any pod. `pollsInFlight` in `connect.ts` stays local: it dedupes device
polling within one pod, and a cross-pod duplicate poll is harmless.

### Push transport — `apps/gateway/src/stream/*`

- Every `emit` site publishes to `coord.pubsub` topic `res`; every pod subscribes and feeds
  its own registry. `res:*` frames carry keys, not data — the refetch goes over HTTP to
  whichever pod the balancer picks and reads the shared store. A pod hearing about a write
  it did not make is the point.
- **The coalescer runs on the emit side, before publish**, as well as on the deliver side.
  `INVALIDATION_FLOORS` applied only at delivery would let N pods each publish uncoalesced
  at 100 req/s. Coalescing is load-bearing here for the same reason it is on one node.
- Replay ring `seq` → `coord.incr("seq:<topic>")`; ring contents stay per pod. A reconnect
  landing on another pod with a `sinceSeq` older than that pod's ring answers `gap`, and the
  client already refetches on `gap`. One refetch per client per rolling deploy is accepted.
  A Redis-backed ring (`XADD`/`XRANGE`) that would make reconnects gap-free was considered
  and deferred: `gap` → refetch already exists and is one round-trip.
- `declareStream` publishes on `pubsub` as well, so any pod answers `declared`.
- Plugin channels: `send(connectionId, …)` to a connection id whose prefix is another
  node's publishes a `plugin:<id>:<name>` frame carrying the target id; the owning pod
  delivers. Subscribe-before-send is unchanged because the registry entry lives where the
  socket lives.
- **No sticky sessions are required.** Cookie verification reads `kv`; everything else is
  fan-out. The ingress must pass WebSocket upgrades and hold an idle timeout above the
  keepalive cadence (10 s; 5 s on `/v1/responses`).

### Per-pod console log

Each pod publishes its console batches to `console:<nodeId>`; every pod pattern-subscribes
`console:*` and serves `stream:console:<nodeId>` from its own socket, with `seq` from
`coord.incr("seq:console:<nodeId>")` and a per-topic local ring. `GET /api/nodes`
(`requireReader`) lists the `nodes` table. The console panel gains a pod selector,
defaulting to the pod that served the page (`/health.nodeId`); "all" merges by timestamp
with a `nodeId` badge. On one node the selector is hidden. With Redis down the panel shows
its own pod and disables the selector with a reason — the "declared or error, never silent"
rule.

### Restart — `apps/gateway/src/lifecycle.ts`

`POST /api/restart` in cluster mode answers `UNSUPPORTED` with "roll the deployment". A
`systemctl restart` of one pod is not a fleet restart, and pretending otherwise is worse than
refusing.

## Data migration — `omni db migrate --to <postgres-url>`

In `packages/control`, injected like every CLI side effect. Refuses while the gateway is
running (the same check `restore` makes) and refuses a non-empty target. Copies, in one
target transaction: `credentials` (ciphertext and versions verbatim — the same
`OMNI_ENCRYPTION_KEY` opens them), `api_keys` (hashes, limits, allowlist), `virtual_models`,
`settings`, `request_logs` and `usage_daily`, and the latest `quota_windows` reading per
credential and window. Then `rebuildRollup` on the target. Verifies row counts per table
and prints them.

Skipped, and said in the output: request bodies (the file corpus stays on the source host;
body rows are dropped), sessions, pending flows, and `plugin_*` tables — listed by name with
"migrate by hand", because their SQL is dialect-specific. The reverse direction is not
offered.

## Testing

- `packages/coord/test/contract.test.ts` runs one suite against memory and Redis
  (`OMNI_TEST_REDIS_URL`; skipped when unset). The seam is concurrency: ten parallel
  `window.claim` against ceiling 3 yield exactly three `ok`, in both implementations.
- `packages/store/test/contract/` runs every repo test against both backends
  (`OMNI_TEST_DATABASE_URL`; skipped when unset). A behaviour that drifts fails on the one
  that drifted.
- `apps/gateway/test/cluster/` builds **two `createApp` instances sharing one memory `Coord`
  and one store** and asserts cross-replica correctness with no Redis and no Postgres: ring
  bypass, gauge ceiling, refresh under contention, `sweepPending` scoping, session
  visibility, `res:*` fan-out, plugin channel cross-delivery. This is the instrument for the
  "threaded into some of the call graph and not all" class: a site still reading a
  module-global sees replica A's state and fails here, whichever site it is. Same shape as
  the sentinel-registry test in `dispatch.test.ts`.
- Mutation targets, each named so the review can check they were run: gauge TTL removed;
  `node_id` dropped from `sweepPending`; CAS version check removed; lease miss treated as
  held; emit-side coalescer removed; `kv` given a memory fallback.
- CI adds `postgres` and `redis` services so the two contract suites run rather than skip.

## Rollout

Seven pull requests, each mergeable alone, single-node green throughout:

1. `packages/coord` with the memory implementation; ring, gauge, load and refresh
   serialisation move behind it. No behaviour change.
2. `node_id` and scoped `sweepPending`; `updateSecrets` CAS; cooldown column; sessions and
   pending flows onto `kv`. Every one improves single-node mode.
3. Leases around loops; pubsub-fed push transport; cluster `seq`; per-pod console.
4. Redis implementation, fail-open table, the two `LogFields` keys, `/health` fields.
5. Postgres store, `bytea` bodies, contract suite, CI services.
6. `@omnigateway/plugin-api` 0.3.0, `PLUGIN_API_VERSION` 3, async storage.
7. `omni db migrate`; README cluster section; `ARCHITECTURE.md` "Clustering". (`CLAUDE.md`
   rule 14 landed with PR 1: every process-local mutable goes through `coord` or the store,
   and a review of any new module-scope `Map` asks which.)

## Out of scope

- Object storage for bodies.
- Redis-backed replay ring (gap-free reconnect across pods).
- Plugin filesystem parity across pods: the operator bakes plugins into the image.
- Migrating `plugin_*` tables between dialects.
- Postgres-to-SQLite migration.
