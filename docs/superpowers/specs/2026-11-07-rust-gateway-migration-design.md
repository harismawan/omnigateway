# Rust gateway migration: design

## Intent

The gateway, its admin API, and the `omni` CLI move from TypeScript on Bun to Rust.
The React dashboard stays as it is and talks to the Rust server over the same
`/api/*` routes and `/api/stream` WebSocket. The switch is a **single cutover**:
operators stop the TypeScript build and start the Rust one against the same data.

### Why

The operator's pain is latency, memory, and stability, all three, in both
deployment shapes: single node on SQLite, and the k8s cluster on Postgres +
Redis. The baseline (`docs/benchmarks/2026-11-07-ts-baseline.md`) explains each
one.

- **Each process uses about one core.** Pinned to four cores, the single-node
  gateway burns about 0.7 CPU-s/s and tops out near 1.4k req/s. Under load,
  latency is mostly time spent queueing behind that one core: 0.7 ms p50 with
  one client becomes 42 ms with 64.
- **Tail stalls exist even without load.** With one client, p99 is 11 ms
  against a p50 of 0.7 ms.
- **Cluster mode is slower than single mode.** Two replicas together serve
  about 400 req/s, against 1.4k for one SQLite process.
  - One streaming request makes 3 Postgres calls and 1 Redis call in series
    before its first byte. It makes about 6 more Postgres round trips in a
    transaction after the stream ends.
  - Each completion upserts the same `usage_daily` and `usage_rollup` rows.
    That contends across replicas and holds pool connections while it does.
  - The Postgres and Redis CPU per request (about 1.2 ms) is larger than the
    gateway's own CPU per request.
- **Cluster replicas crash under early client disconnects.**
  `waitForCancellation` (`apps/gateway/src/dispatch/index.ts`) rejects as soon
  as the signal is already aborted and abandons the `attempt()` promise. That
  promise then rejects with the transport's `aborted` error, and no handler is
  attached. Bun treats this as fatal in some contexts. Both replicas died in
  the benchmark; 50 `curl -m 0.002` requests reproduce it by hand.
- **Cluster replicas grow memory without bound under the same load.** RSS went
  from 81 MiB to 1.4 GiB in 15 s and was not returned. The leading hypothesis
  is an unbounded queue of Postgres work:
  - The Bun SQL pool has 10 connections, no statement timeout, and an
    unbounded wait queue.
  - Aborted requests still do their full write path, behind hot-row locks.
  - Each queued request pins its body, IR, and generators.

  This is not proven. The Rust design removes every ingredient regardless, and
  the benchmark is the check.

The TypeScript build stays as it is. The two cluster bugs are fixed by
replacing it, not by patching it. This was the operator's decision.

## Goals

1. **Same behaviour, every contract.** Clients, providers, operators, and their
   scripts see no difference, except that the gateway is faster and does not
   crash. Plugins are the one exception (see non-goals).
2. **Faster in both shapes, by a wide margin.** The operator set no numbers
   ("just make it fast"), so the targets below are the builder's call. They are
   written down so "done" is checkable.
3. **Cluster mode is redesigned for speed.** It should not be a line-by-line
   port of today's I/O pattern.
4. **Stable under abuse.** Client cancellation, slow Postgres, and Redis
   outages degrade service. They never crash a process or grow memory without
   bound.
5. **No `unsafe` in our code.** Every crate in the workspace sets
   `#![forbid(unsafe_code)]`. Dependencies (SQLite, TLS, zstd and so on) contain
   unsafe internally; that is accepted.
6. **An in-place upgrade.** The same SQLite file, the same Postgres database,
   the same `.env` and `OMNI_*` variables, the same CLI commands, flags, and
   `--json` output.

### Targets (builder's call)

All targets are measured with `scripts/bench-gateway.ts` on the baseline rig
(i5-13400, the same core pinning, the same scenarios).

| Measure | TS baseline | Rust target |
|---|---|---|
| Single, chat-stream, 64 clients | 1,473 req/s, p50 41.7 ms, p99 70 ms | ≥ 10,000 req/s, p99 ≤ 10 ms |
| Single, overhead-c1 | p50 0.68 ms, p99 11.1 ms | p50 ≤ 0.3 ms, p99 ≤ 1 ms |
| Single, many-chunks CPU | 5.9 ms/req | ≤ 1.5 ms/req |
| Cluster ×2, chat-stream, 64 clients | 401 req/s, p50 157 ms | ≥ 8,000 req/s, p99 ≤ 15 ms |
| Cluster ×2, Postgres + Valkey CPU per request | 1.2 ms | ≤ 0.1 ms |
| Cluster ×2, anthropic-json p99 | 1,526 ms | ≤ 20 ms |
| client-cancel, early-cancel (both shapes) | cluster: crashed ×2, RSS 4.2 GiB | 0 crashes; RSS returns to within 20 MiB of its pre-scenario value within 10 s |
| Idle RSS / held-streams (1000) RSS peak | 56 / 183 MiB | ≤ 20 / ≤ 80 MiB |
| Boot to healthy | 59 ms | ≤ 30 ms |
| `omni keys list` | 99 ms | ≤ 15 ms |

- **If a target turns out unreachable,** bring the measurement back. Do not
  quietly lower the target.
- **The ceiling may be the rig, not the gateway.** The rig's upstream serves
  about 74k req/s. If Rust reaches the load generator's or upstream's ceiling,
  record that and move them to more cores.

## Non-goals

- **Plugins.** Rust does not load them.
  - At boot, if `<root>/plugins/` has entries, log one `warn` line per plugin
    and continue.
  - `plugin_*` tables and `plugin_migrations` are left untouched.
  - The `/api/plugins*` routes and `omni plugin *` commands return a clear "not
    supported in this release" error (HTTP 501 with the usual error body; CLI
    exit 1).
  - `@omni/plugin-api` and `@omni/dashboard-sdk` stay published but frozen.
- **No dashboard changes.** If the dashboard needs something, the API provides
  it as it does today.
- **No new features.** This includes no new providers, routes, or settings.
- **The npm distribution.** `omnigateway` on npm needs Bun. Its last release
  stays published; Rust ships as a binary and a Docker image.
- **Running TS and Rust side by side** against the same data. This is not
  supported: single cutover.

## Anti-goals

These make the work a failure even if it "works":

- **Any wire difference a provider can detect.** That covers header order and
  casing, body bytes, `cch=`, cloaked tool names, and the Codex zstd frame. The
  fingerprint is a feature.
- **A replica that crashes or grows memory without bound** under any client
  behaviour.
- **A first Rust release that needs a schema change TS cannot read.** That
  would kill rollback (see Cutover).
- **Chasing TypeScript changes while the rewrite runs.** TypeScript is frozen
  (see Freeze).
- **A design whose cluster mode is merely "the same queries, but in Rust".**

## Constraints

### Freeze

- **The target is `main` at `1780bb39`**, which includes the Qoder provider.
- **From then until cutover, TS takes bug fixes only.** Every fix lands with a
  regression case in the conformance suite (below), so Rust inherits it.
- **New features wait until after cutover.**

### Cutover

- **Upgrade.** Stop TS, then start Rust against the same root.
  - Single node: the same SQLite file and `.env`.
  - Cluster: the same Postgres and Redis.
  - At boot, Rust applies only migrations that TS would also apply. The first
    Rust release adds **no** migrations of its own.
- **Rollback.** Stop Rust, then start TS. This must work with no data
  conversion, which is why the first release adds no migrations.
- **Redis at cutover.** Rust uses the same key schema for state that outlives
  a restart: sessions, buckets, leases, locks, and OAuth pending state.
  - If Rust cannot honour a format exactly, document it and `UNLINK` that
    prefix at first boot.
  - `omni:b:*` buckets are always safe to drop. An unseeded hash is reseeded
    from `request_logs`.
  - Sessions are safe to drop: users log in again.
- **Cluster rollout. Operator decision: a manual Recreate.**
  - Today `release.yml` auto-merges the image promotion, and Argo CD rolls it
    out with `RollingUpdate`, `maxSurge: 1`. That would briefly run TS and Rust
    replicas together, which this design does not support.
  - For the **first Rust release only**:
    - The promotion PR is merged by hand.
    - `k8s/deployment.yaml` switches `strategy` to `Recreate` in that same PR.
    - The cost is a few seconds of downtime, and the fleet is never mixed.
  - The following release restores `RollingUpdate`, now Rust-to-Rust.
  - Rust does **not** need to interoperate with TS replicas.
  - The cutover runbook (build-order step 9) spells out these steps and the
    rollback: the same two steps with the TS image.
- **Single-node upgrade.**
  - Operators install the Rust binary, then re-run
    `omni service install --force`, which rewrites the unit's `ExecStart` to
    the new binary.
  - Units that point at the old Bun entrypoint are not kept working. The
    runbook says this, and so does `omni doctor`: it detects a unit whose
    `ExecStart` is not the running binary.
  - npm users get a final npm release of the TS package. Its README and a
    `postinstall` notice point to the binary releases.
- **Gate to cut over.**
  - Rust passes the full conformance suite.
  - Rust meets the targets above.
  - Rust has run against a copy of a production database, in both shapes.
- **TS code removal.** TS stays in the repo until Rust has run in production
  for one release cycle, so that rollback stays possible.

### Compatibility contracts (must match exactly)

Each contract below has a conformance fixture captured from TS before any Rust
code depends on it.

**Wire to providers**
- **Header order and casing**, per provider profile (`packages/providers/src/*/profile.ts`).
  - Includes `OMNI_ORDER_*`, `OMNI_UA_*`, and `OMNI_*_CLI_VERSION` overrides.
  - node:http sends the ordered set, then `Content-Length` (if absent), then
    `Host`, then `Connection: keep-alive`.
  - hyper and reqwest lowercase names and send `Host` first, so the default
    stack cannot be used here (see "How").
- **Request body bytes.**
  - Key order is insertion order. `orderFields` reorders top-level keys only.
  - Numbers serialise as JS does: `1e+21`, `-0`→`0`, `1e-7`, and shortest
    round-trip for other floats. **serde_json does not do this by default.**
  - Integer-like object keys move first, as JSC does when re-serialising.
  - Lone surrogates are escaped as `\udXXX`.
- **`cch=` billing checksum.** xxHash64 with seed `0x6e52736ac806831e` over the
  UTF-8 body containing the `00000` placeholder; take the low 20 bits as 5 hex
  digits. The `cc_version` suffix is
  `sha256("59cf53e54c78" + t[4]+t[7]+t[20] + ver)[:3]`, indexed by UTF-16 code
  unit (`packages/providers/src/body.ts`).
- **Tool-name cloaks.** xxHash64, seed 0, taking `& 0xffffff` (Anthropic
  `cloak.ts`, Antigravity `cloak.ts`).
- **Codex.**
  - zstd level 3, one streamed frame: no content size, not single-segment,
    2^21 window.
  - HMAC-SHA256 with the hex `idSalt` used as raw ASCII key bytes.
  - UUIDv5 and the v7-style ids (`openai/codexIdentity.ts`).
- **Derived ids.** Antigravity and Grok derived UUIDs, `clampCallId`,
  `prompt_cache_key`, and `at_<uuidv5>`. A mismatch here costs prompt-cache
  hits, not correctness, but it is still a fixture.
- **Qoder** (`packages/providers/src/qoder/`):
  - The body encoding: base64 → alphabet swap → third rotation, plus its
    inverse.
  - The MD5 signature.
  - The `Cosy-Key` wrapping: AES-128-CBC/PKCS#7 with key = IV, then RSA
    PKCS#1 v1.5 under an embedded key.
  - The strict validation of the stored bundle.
  - Live Qoder traffic has never been verified, even in TS, so the TS output is
    the contract.

**Client APIs**
- All three dialects must be reproduced exactly:
  - `/v1/messages` (Anthropic) plus `count_tokens`;
  - `/v1/chat/completions` (OpenAI, including Ollama-style `images`);
  - `/v1/responses` (stateless).
- For each dialect, request validation and every error body and status must
  match.
- **SSE framing:**
  - `: keepalive` every 10 s, or 4 s for Responses;
  - event names, the `[DONE]` terminator, and rate-limit headers.
- **Commit-point semantics.** Before the first `blockDelta`, a retryable
  failure fails over. After it, errors go in-stream.
- `/v1/models`, `/health`, `/metrics`, the about 70 `/api/*` routes, and the
  `/api/stream` WebSocket protocol.

**Storage**
- **SQLite migrations** are ids 1–20; **Postgres** migrations are ids 1–8.
  - Both keep their ledger in `migrations(id, applied_at)`.
  - SQLite migrations 2, 6, and 10 run backfills in code (`rollup.ts`). Port
    them for installs that have not applied those yet.
  - Postgres takes `pg_advisory_lock(7140641)` around the migration walk.
  - SQLite runs with WAL, `synchronous=NORMAL`, `foreign_keys=ON`, and
    `busy_timeout=5000`.
- **Field encryption.**
  - The key is PBKDF2-HMAC-SHA256 over the raw UTF-8 `OMNI_ENCRYPTION_KEY`,
    with salt `omnigateway-field-encryption-v1`, 210,000 iterations, 32 bytes.
  - Values are stored as `enc:v1:<iv>:<ct>:<tag>` in lowercase hex, with a
    12-byte IV and no AAD.
  - This applies to the four `credentials` secret columns.
- **Body artifacts.**
  - The `OGBA` envelope: a 10-byte header that is also the AAD; codec 0 is
    written, codec 1 (gzip) is read.
  - The legacy `enc:v1:` hex format is read.
  - Path: `<dbdir>/request_bodies/YYYY/MM/DD/<requestId>.json.enc`. The sha256
    is taken over the whole envelope.
  - Postgres stores the same envelope in `bytes BYTEA`.
- **API keys.**
  - Format: `sk-omni-` followed by unpadded base64url of 32 random bytes.
  - `hash` = SHA-256 hex; `prefix` = the first 12 characters.
- **Passwords.**
  - argon2id with m=19456, t=2, p=1, a 32-byte salt and a 32-byte hash.
  - Stored as a PHC string in `settings.adminPasswordHash` and
    `viewerPasswordHash`.
- **Sessions.**
  - The token is unpadded base64url of 32 bytes.
  - It is stored in the coordination KV under `sess:<kind>:<sha256hex(token)>`
    with JSON `{expiresAt, principal}`, TTL 12 h.
  - Cookie: `omni_admin`, with the same attributes and the same `Secure` rule.
- **Timestamps** are integer ms since the epoch.
  - `usage_daily.day` and `usage_rollup.hour` are bucketed with the day offset
    (`OMNI_DAY_OFFSET_MINUTES`, else the host's offset at boot).
  - Snapshot filenames match `SNAPSHOT_ID` in
    `packages/control/src/database.ts`.

**Operator surface**
- **CLI.** Every command, flag, exit code (0/1/2/3), and `--json` shape.
  - `--json` is `JSON.stringify(data, null, 2)`, with JS number formatting.
  - Human output matches as well. Scripts parse it more than anyone admits.
- **`.env` parsing** follows `apps/cli/src/context.ts` `parseEnvFile`: no
  escapes, no `$` expansion, one pair of quotes stripped.
- **Root resolution** order and the `OMNI_DB_PATH` suppression rule
  (`apps/cli/src/context.ts`).
- **Gateway environment loading.** Bun auto-loads the working directory's
  `.env` for the gateway today; Rust must do so explicitly.
  - Whether Bun's loader expands `$VAR` is unverified. Check it and match.
  - Systemd units written by `omni service install` keep working. They must
    reference the new binary.
- **Every `OMNI_*` variable** in `packages/control/src/config.ts`, with the same
  validation and the same errors.

## How (decided)

### Repository and packaging

- **Location.** A Cargo workspace under `crates/` in this repo.
- **Dashboard build.** The dashboard keeps building with Bun. Its `dist/` is
  embedded in the binary or read from `OMNI_STATIC_DIR`, as today.
- **Binary.** One binary, `omnigateway`, serves as both the gateway and
  `omni`, dispatched on argv[0] or a subcommand.
- **Platforms. Operator decision: Linux and macOS.**
  - Linux x86_64 and aarch64, musl-static.
  - macOS x86_64 and aarch64.
  - These ship as GitHub release assets with checksums. Windows is not
    supported; the TS npm package is the only Windows path today, and it
    remains frozen.
- **Platform-dependent wire values.** Fingerprint values that depend on the
  platform, such as `X-Stainless-OS`, `X-Stainless-Arch`, and the Grok
  user-agent, must be derived from the host exactly as TS derives them. Add a
  conformance vector for each target triple.
- **Docker.** The same image name and tag line, now multi-arch
  (amd64 + arm64). The base stays `alpine`.
- **k8s.** Manifests change only the image and the command, apart from the
  one-off `Recreate` strategy for the first rollout (see Cutover).
- **Rust edition and lints.**
  - Rust 2024, stable toolchain, pinned in `rust-toolchain.toml`.
  - `#![forbid(unsafe_code)]` in every crate.
  - `#![deny(unused_must_use)]` and `clippy::let_underscore_future`, so a
    dropped future or result is a build error. This is the class of bug that
    crashes TS replicas today.

### Runtime stack

- **Async runtime:** Tokio, multi-threaded, one worker per available core.
- **Inbound server:** hyper 1.x, with axum for routing `/api/*`.
  - The `/v1/*` hot path may bypass axum extractors if profiling shows a cost.
  - `/api/stream` uses tokio-tungstenite or axum's WebSocket.
- **Outbound HTTP:** a client that preserves header order and casing exactly.
  - Use hyper's HTTP/1 client with `preserve_header_case` and an explicitly
    ordered `HeaderMap` (the order is preserved per name). If hyper still
    cannot reproduce node:http's trailing `Content-Length` / `Host` /
    `Connection`, use a small custom HTTP/1.1 request writer over a pooled
    `tokio-rustls` connection.
  - Responses are parsed with hyper or httparse.
  - TLS: rustls with the platform root store (`rustls-platform-verifier` or
    `webpki-roots` plus native certs; builder's call). Connect behaves like
    Happy Eyeballs with a 3 s per-family attempt timeout
    (`CONNECT_ATTEMPT_TIMEOUT_MS`).
  - **The TLS fingerprint changes. Operator decision: accepted.** Today
    providers see Bun's BoringSSL ClientHello, not the vendor CLIs'. The repo
    already records that as an unsolved limit
    (`2026-07-31-client-identity-profiles-design.md` §Limits). rustls presents
    a different, equally non-official handshake. Record it in the same §Limits
    entry. Matching or impersonating JA3/JA4 is out of scope.
  - A wire-capture fixture per provider proves equality with TS.
- **JSON:**
  - Parsing uses serde_json with `preserve_order`. Hot-path streaming uses
    zero-copy parsing where it pays.
  - Wire output uses a custom serializer that reproduces JS `JSON.stringify`.
  - A property test compares it against `bun -e JSON.stringify` over generated
    values.
- **SQLite:** `rusqlite`, with the bundled SQLite.
- **Postgres:** `tokio-postgres` with `deadpool-postgres`, or sqlx; builder's
  call. Statements are prepared once, and every query has a timeout.
- **Redis:** the `redis` crate with a multiplexed connection plus one pub/sub
  connection. The Lua scripts are loaded once and called by EVALSHA.
- **Crypto:** `pbkdf2`, `aes-gcm`, `aes`/`cbc`, `rsa`, `sha2`, `md-5`, `hmac`,
  `argon2`, `xxhash-rust` (xxh64), `uuid` (v4/v5), and `zstd` (level 3,
  streamed).
  - Pin the libzstd version that byte-matches the captured Codex frames.

### The request path (both shapes)

These rules apply to every `/v1/*` request.

1. **No storage I/O before the first byte.** An in-memory snapshot holds:
   - API keys by hash;
   - the routing snapshot: virtual models, credentials and health, quota, and
     settings;
   - decrypted credential secrets, keyed by credential id and `token_version`.

   Updates arrive by change notification (below). A miss, such as a brand-new
   key, falls back to one read that populates the snapshot.
2. **Cancellation is structural.**
   - Each request is one task.
   - When the client disconnects, the response body is dropped. That cancels
     the task, which drops the upstream connection future, which closes the
     upstream socket. Nothing is left running unowned.
   - Background work a request spawns (log writes, debits) is pushed onto
     bounded channels, never spawned free-floating.
   - A cancelled request records a 499 log row through the same channel.
3. **All queues are bounded.**
   - The log/usage channel, the Postgres pool queue, and the Redis command
     queue each have a capacity and a timeout.
   - When a queue is full, the request path does not wait; it sheds. See
     "Overload" below.
4. **Streaming is one pass.** The upstream SSE is parsed incrementally,
   decoded to IR events, and encoded to the client dialect, writing into one
   reused buffer per stream. There is no per-chunk allocation beyond the
   encoded frame.
   - The `MAX_RECORD_CHARS` (10 MiB) cap per SSE record stays.
   - A request-body size limit is added for `/v1/*`. Builder's call on the
     value; it must be at least the largest real agent request seen (several
     MiB). TS has none, which is a known security finding. Over the limit, the
     request is refused with the dialect's `invalid_request` error.
5. **Logging stays off the request path.**
   - The request emits a `LogEvent`: a begin event at dispatch, route updates,
     and a finish event.
   - The events go into a bounded channel drained by one writer task per
     process (see "Writes").
   - The console WebSocket's live view comes from the same events in memory,
     not from a database read-back.

### Writes (both shapes)

**One writer task per process** owns all request-path persistence. Every
200 ms, or every 512 events, whichever comes first, it writes one batch:

- **`request_logs`.**
  - One multi-row `INSERT … ON CONFLICT (id) DO UPDATE` for finished rows.
  - Pending rows are written in the same batch, so in-flight requests stay
    visible in the console and are later overwritten.
  - On Postgres this is a single `INSERT … SELECT FROM unnest(...)`.
- **`usage_daily` and `usage_rollup`.**
  - Increments are aggregated in memory by primary key across the batch, then
    applied as one multi-row upsert per table.
  - This removes the per-request hot-row contention: a key that made 1,000
    requests in a batch touches its row once.
- **Health measurements:** coalesced the same way, keeping the latest value
  per (credential, model).
  - Breaker state transitions are **not** batched. They go through the shared
    path below, because other replicas route on them.
- **Rate-limit debits** (Redis buckets): one pipelined script call per batch,
  not per request. Concurrency release is never batched (see "Cluster
  design").
- **Body artifacts:** the file or `BYTEA` write is queued with the log row. The
  envelope is sealed on the request task, so the plaintext never sits in a
  queue.

**Accepted loss.** On a hard kill (OOM, SIGKILL), at most one batch is lost:
about 200 ms of rows and usage. The operator accepted this.

**Graceful shutdown.** On SIGTERM:
1. Stop accepting new requests.
2. Let streams finish up to the existing drain deadline.
3. Flush the writer.
4. Exit.

**Rate-limit seeding.** Long-window (5h/1w) rate-limit sums must still be
correct after a restart. Seeding reads committed `request_logs`, as today. The
≤200 ms loss window is the only drift.

**SQLite specifics.**
- The writer task owns one connection inside `spawn_blocking`.
- Reads use a small separate read pool, which is fine under WAL.
- A batch is one transaction.

### Cluster design

The goal: a replica's request path touches Redis only where the work must
genuinely be shared across replicas, and touches Postgres never.

- **Change propagation.**
  - The existing pub/sub on `omni:pubsub` carries `routing`-topic messages.
    Rust extends their use to API keys and secrets, so a replica patches its
    snapshot from the message.
  - The `config_version` counter remains the backstop. A background task polls
    it every 500 ms, and a mismatch triggers a full reload off the request
    path.
  - Key revocation and expiry must take effect within one second on every
    replica, which bounds the poll interval.
- **Rate limiting: one Redis round trip, only when needed.**
  - A key with no limits makes **no** Redis call.
  - A key with limits makes one `EVALSHA` of a new combined script. It does the
    window claim, the gauge acquire (only if a concurrency limit is set), and
    the 5h/1w bucket sums for every subject (key plus model override). It
    returns admit or refuse, plus headroom for the headers.
  - The old per-step scripts stay loaded only where something else uses them.
  - **Debits** (5h/1w token and spend buckets) are batched (see "Writes").
  - **Concurrency release is immediate, never batched.** Builder's call: a
    `concurrency: 1` key making back-to-back requests must not get a 429 that
    TS would not give.
    - The release is sent at stream end without awaiting it, as one
      `GAUGE_RELEASE`. It pipelines with any other in-flight commands, so it
    costs a command but adds no latency.
    - It is only sent for keys that have a concurrency limit.
    - The 1m request-window claim needs no release.
  - **Unseeded long-window buckets.** Builder's call: admit the request, then
    seed in the background. The request path never waits on Postgres.
    - When the combined script finds a 5h/1w bucket unseeded, it still does
      the 1m claim and the gauge, and reports that the bucket is unseeded.
    - The request is admitted against the limits it could check.
    - A background seeder takes the existing `omni:lock:seed:*` mutex, sums
      `request_logs` (`sumBuckets`), and runs `BUCKETS_SEED`.
    - Until the seed lands, the key can overshoot a 5h/1w limit by the
      requests admitted in that window. That is typically one request, and
      under 1 s at most.
    - Every limited key in the snapshot is pre-seeded at boot, and again when
      its key is added to the snapshot. A cutover `UNLINK omni:b:*` therefore
      reseeds before traffic arrives.
    - TS's current behaviour, a blocking seed, cannot be kept without breaking
      the "no Postgres on the request path" rule. This is the one deliberate
      behaviour difference, and conformance tests for long-window limits
      pre-seed before asserting.
  - **Redis outage.** If Redis is unreachable, limits fail **open** with a
    per-process local limiter, plus a `warn` log and a metric. This matches
    today's fallback to the memory coordinator, but it is now explicit and
    bounded.
- **Load-aware ranking.** Each replica publishes its in-flight counts per
  (credential, model) to Redis every 100 ms in one pipelined write. Ranking
  reads a snapshot that a background task refreshes every 100 ms. There is no
  per-request `GAUGE_SNAPSHOT` and no per-request load acquire or release.
- **Breaker and health stay strictly shared.**
  - A failure or state transition is written to Postgres immediately.
  - That write uses the existing advisory-lock transaction, off the request
    task, through a dedicated bounded queue.
  - The transition is then published on `routing`.
  - The half-open probe gauge stays a Redis acquire, but only for the one
    request that probes.
- **OAuth refresh.** The cross-replica mutex is kept
  (`omni:lock:refresh:<id>`), with the `token_version` compare-and-swap.
- **Leases.** Background loops (refresh sweep, quota poll, maintenance) keep
  their lease keys.
- **Postgres pool.** At most 16 connections per replica (builder's call), a
  statement timeout of 5 s, and a pool-wait timeout of 1 s.
  - The request path never waits on the pool.
  - Only the writer, the breaker queue, and admin routes use it.
- **Overload.** If the writer's channel is full, the request is still served
  and its log event is counted as dropped, with a metric and a rate-limited
  `warn`. Usage loss under sustained database failure is preferred to
  refusing traffic.
  - This is the builder's call: shedding traffic instead is defensible. Flag
    it in review if you disagree.
  - Memory stays bounded either way.

### Single-node specifics

Same architecture, with SQLite and `memoryCoord` equivalents in-process. The
writer batching removes the event-loop blocking that the 2026-08-30 hot-path
spec could not fix in TS.

### Admin API, console stream, background loops

- **Port all route groups:** admin, client, database, connect, models, stream,
  and static serving, with identical JSON and status codes.
  - Use the dashboard's own API client (`apps/dashboard/src/api/client.ts`) as
    the inventory, plus `docs/client-api.md`.
- **Database operations keep their semantics:** snapshot, restore, vacuum, and
  the quiesce latch that returns 503 on `/v1/*` during a swap.
- **Background loops:** OAuth refresh sweep (60 s), quota poller, maintenance
  (pruning, heartbeat), and the console log source.
- **Smart router and guardrail:** port as written. Both dispatch to a
  classifier model through the normal path. The verdict caches stay
  per-process LRU, 1 h TTL, 10k entries.
- **RTK and ponytail:** port as written, both still off by default. RTK's
  filters are pure functions with their own test suite; port those tests.
- **Telemetry:** Prometheus `/metrics` with the same series names and the same
  cardinality cap. OTLP export with the same env vars.

### CLI

- All commands in `omni --help` are ported, with the same root resolution,
  `.env` parsing, flags, prompts, human output, `--json`, and exit codes.
- The CLI keeps opening SQLite directly, as today. Cluster installs are managed
  through the admin API, as today.
- `omni start` and `omni service install` launch the Rust binary.

### Conformance suite (the cutover gate)

Today's tests call TS internals. The gate needs tests that both builds can run.

1. **Black-box HTTP tests** under `conformance/`.
   - A test driver (TS on Bun is fine; it is test tooling) starts a gateway
     binary and a recording stub upstream, then drives requests.
   - It asserts on client responses byte-for-byte, after masking ids and
     timestamps.
   - It asserts on upstream requests byte-for-byte: header names in order and
     cased, and the body.
   - It covers every provider, every dialect pair, failover, the commit point,
     cancellation, rate-limit headers and 429 bodies, every `/api/*` route, and
     WebSocket messages.
   - Seed it from `apps/gateway/test/e2e/`, the per-provider codec tests'
     captured literals, `packages/providers/test/fixtures/codex-0.165.0.json`,
     and the roundtrip and auth-matrix tests.
2. **CLI golden tests.** Run each command against a seeded SQLite root and
   compare stdout, stderr, and exit code, both human and `--json`.
3. **Storage cross-reads.** These prove both directions of an upgrade and a
   rollback.
   - A database written by TS is opened by Rust: decrypt, read bodies, verify
     passwords, continue migrations from any id.
   - A database written by Rust is opened by TS.
   - Run each check on SQLite and on Postgres.
4. **Pure-function vectors** exported from TS as JSON:
   - JS `JSON.stringify` number and key cases;
   - `cch`, cloaks, the Qoder codec, Codex ids, derived UUIDs;
   - SSE parser edge cases;
   - rate-limit arithmetic, router ranking, and pricing.

   Rust unit tests consume the vectors.
5. **The benchmark,** `scripts/bench-gateway.ts`, unchanged, in both shapes,
   against the targets.

The suite runs green against TS first, at the freeze commit. Rust is done when
it runs green against Rust.

## Left to the builder

- **Crate layout.** Mirror the TS package layering: ir → providers → router /
  ratelimit → store → control → gateway / cli. The "pure router, no I/O" rule
  carries over.
- **Plumbing choices.** sqlx vs tokio-postgres; axum vs bare hyper per route
  group; the WebSocket crate.
- **Exact tuning:** batch size and interval (within ≤200 ms loss), pool sizes,
  and the queue capacities.
- **The body-size limit value.**
- **Build order** (see the next section).
- **Whether to embed the dashboard `dist/`** in the binary or keep reading it
  from disk. Both must work with `OMNI_STATIC_DIR`.

## Suggested build order (for the plan; not binding)

1. Conformance suite and vectors, green against TS at the freeze commit.
2. `ir`, the JS-compatible JSON writer, and the crypto contracts, with vectors.
3. Store (SQLite then Postgres), migrations, and the writer task, verified with
   cross-reads.
4. Providers, one at a time, each against its wire fixtures; `custom` first for
   the benchmark.
5. Router, rate limiting, dispatch, and the `/v1/*` routes. Benchmark the
   single shape.
6. Cluster coordination. Benchmark the cluster shape and fix until the targets
   are met.
7. Admin API, WebSocket, background loops, smart router and guardrail.
8. CLI with golden tests.
9. Packaging, Docker, k8s, and the cutover runbook.
