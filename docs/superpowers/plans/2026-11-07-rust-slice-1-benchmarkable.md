# Rust slice 1: the benchmarkable gateway

**Spec:** `docs/superpowers/specs/2026-11-07-rust-gateway-migration-design.md` (approved).
The operator asked to skip a full plan. This file is the task list for subagent
dispatch, nothing more. Each task names its TS sources. **The TS code is the
behaviour contract. The spec is the authority on architecture.**

**Goal of the slice.** `scripts/bench-gateway.ts` runs unchanged against a Rust
binary in **single mode** and produces numbers. To get there:

- the gateway is configured by the TS `omni` CLI against a SQLite file;
- it serves `/health` and `/v1/chat/completions`, `/v1/messages` and
  `/v1/responses` streaming and non-streaming;
- requests route to the `custom` provider;
- it logs to `request_logs`, `usage_daily` and `usage_rollup` through the
  batched writer;
- it applies per-key rate limits in memory.

Cluster mode, the other providers, the admin API and the CLI come in later
slices.

## Global constraints (every task)

- **Location.** A Cargo workspace at the repo root, with crates under `crates/`.
  These already exist: `omni-ir` (with `jsjson`, the `JSON.stringify`-exact
  writer) and `omni-crypto` (with field encryption, API key hash, cch, cloak,
  codex ids and qoder).
- **Lints.** `#![forbid(unsafe_code)]` comes from the workspace lints; every crate
  sets `[lints] workspace = true`. `unused_must_use` is deny, and so are clippy
  `let_underscore_future`, `let_underscore_must_use` and `unwrap_used`.
  - Tests may use `expect`.
  - `cargo clippy --workspace --all-targets -- -D warnings` and
    `cargo fmt --check` must be clean before every commit.
- **TDD.** Write the failing test first, watch it fail, then implement. Record
  RED/GREEN evidence in the report.
- **Wire output** to clients and upstreams is written with
  `omni_ir::jsjson::{write_value,to_string}`, never `serde_json::to_string`.
- **No storage I/O on the request path before first byte** (spec §"The request
  path"). Keys, routing and secrets live in an in-memory snapshot.
- **Every queue is bounded. Cancellation is structural.** A dropped response body
  drops the upstream future. Nothing that does request work is spawned
  detached.
- **Commits.** Use Conventional Commits, with `feat(rust): …`. Work on branch
  `feat/rust-migration-design`; there are no worktrees, per repo CLAUDE.md.
- **Do not modify TS sources.** TS is frozen.

## Task 1: SQLite store, migrations, snapshot reads

Crate `omni-store`. It uses `rusqlite` with the bundled SQLite.

- **Opening and migrating.** Open or create the database with the exact TS
  pragmas: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`.
  - Apply SQLite migrations 1–20 with the same ledger,
    `migrations(id, applied_at)`.
  - Include the SQL files verbatim from `packages/store/src/sqlite/migrations/`
    using `include_str!` of the TS paths.
  - Use the same statement splitting (`packages/store/src/sqlite/db.ts`).
  - Port the backfills for migrations 2, 6 and 10 (`backfillDaily`,
    `backfillRtkUsage` and `rebuildRollup` in `rollup.ts`), with the day-offset
    arithmetic.
  - Rust must accept a database at any migration id that TS wrote, and continue
    from there.
- **Snapshot reads.** These are what the gateway needs to build its in-memory
  snapshot:
  - all API keys, as the TS `ApiKey` type with `limits` parsed;
  - credentials with decrypted secrets, via `omni_crypto::field`;
  - credential health;
  - virtual models with targets;
  - settings.

  Reading `config_version`/`data_version` comes later. For now expose
  `PRAGMA data_version`.
- **Day bucketing.** `startOfDay` and `hostDayOffsetMinutes` follow TS
  `rollup.ts`. `OMNI_DAY_OFFSET_MINUTES` parsing lives in config (Task 4); the
  store takes the offset as a parameter.
- **Tests.**
  - **Cross-read:** a DB created and populated by the TS CLI is read by Rust.
    Use the CLI as the benchmark does: `credentials add-key custom`,
    `models put -f`, and `keys create` with limits. The test spawns
    `bun apps/cli/src/index.ts`. Skip it with a printed reason if `bun` is
    absent.
  - **The reverse:** a DB migrated from empty by Rust is readable by the TS CLI
    (`omni keys list --json`), and `migrations` holds ids 1–20.
  - Migration from each partial state: create one with TS-equivalent SQL up to
    id N, then let Rust finish.

## Task 2: the batched writer (request logs and usage)

Also in `omni-store`, module `writer`. This is spec §"Writes", applied to
SQLite.

- **The writer task.** A writer task owns one connection (blocking thread or
  `spawn_blocking`). It drains a bounded `tokio::mpsc` of `LogEvent`s
  (`Begin`, `Route`, `Finish`). Every 200 ms, or every 512 events, it writes
  one transaction:
  - multi-row upserts into `request_logs`, matching the TS columns and values
    exactly (`packages/store/src/sqlite/usage.ts` `begin`/`route`/`append`, and
    `apps/gateway/src/logging.ts` for field semantics);
  - aggregated increments to `usage_daily` and `usage_rollup`, applied once per
    primary key per batch, with the TS upsert arithmetic (`rollup.ts`);
  - coalesced health measurements.
- **When the channel is full,** `try_send` fails and the event counts as dropped.
  Expose an atomic counter. The request path never waits.
- **Graceful flush** on shutdown: `close()` drains, then writes.
- **Tests.**
  - The writer's output equals what TS writes for the same sequence of events.
    Compare rows: run the TS `createUsageRepo` against one DB and the Rust
    writer against another with identical inputs, then diff the
    `request_logs`, `usage_daily` and `usage_rollup` rows, masking nothing but
    `applied_at`. A small bun script under `conformance/` may drive the TS side.
  - 1000 events for one key and model touch the rollup rows once per batch.
  - The dropped counter increments under a full channel.
  - Flush on close.

## Task 3: the custom provider codec and the outbound HTTP client

Crate `omni-providers`. It has two parts.

- **IR types** (in `omni-ir`): `ChatRequest`, `StreamEvent`, `Usage`,
  `StopReason`, `GatewayError` codes, and RETRYABLE (`packages/ir/src/*.ts`).
  Port only what the custom provider and three dialects use, but name and shape
  them to match the TS so later providers slot in.
- **The custom codec** (`packages/providers/src/custom/*`): wire encoding for
  chat_completions and responses, the stream decoders, and endpoint URL
  joining. Add `sse.ts`, the incremental SSE parser, with `MAX_RECORD_CHARS`.
  Add the `codecAdapter.ts` semantics custom needs: build request → send →
  decode, error mapping via `http.ts` `httpError`/`parseRetryAfter`.
- **The outbound HTTP client.** It must write headers in the given order and
  casing; see the spec §"Runtime stack → Outbound HTTP".
  - Use hyper 1.x HTTP/1 client with `preserve_header_case`, over a pooled
    connection (keep-alive). TLS is rustls; custom over plain HTTP must work.
  - Cancellation: dropping the response future or body closes the socket.
  - A connect timeout per address family of 3 s.
- **Tests.**
  - Wire bytes against the TS custom codec tests' literals
    (`packages/providers/test/*custom*`). Add vectors exported from TS for
    encode and decode: extend `conformance/vectors/export.ts` with a custom
    section that calls the real TS functions, and regenerate `vectors.json`.
  - An SSE parser edge-case suite (CRLF, split chunks, comments, oversize
    records).
  - An HTTP client test against a local raw TCP listener that asserts the exact
    request bytes: header order and casing.

## Task 4: config, snapshot, router, rate limiter

- **Config** (`packages/control/src/config.ts` `loadConfig`): every `OMNI_*`
  variable with the same validation and error text. Load `.env` from the cwd
  the way Bun does for the gateway.
- **Routing snapshot.**
  - An in-memory snapshot built from the store at boot.
  - A background refresher polls `PRAGMA data_version` every 500 ms and
    rebuilds off the request path.
  - It holds keys by hash, models, credentials with decrypted secrets, health,
    and settings, swapped atomically (`arc-swap`).
- **Router** (crate `omni-router`, pure, no I/O): port `packages/router/src`
  `rank`, filters, score, breaker and resolve, for what the custom provider
  exercises. Port their unit tests from `packages/router/test`.
- **Rate limiter**, single mode: port `packages/ratelimit` arithmetic plus the
  in-memory ring, gauge and long-window logic from
  `apps/gateway/src/auth/rateLimit.ts`.
  - Include the headroom used for rate-limit headers.
  - The long windows (5h/1w) are seeded from `request_logs` in the background
    (spec ruling: admit while seeding).
  - Port the ratelimit unit tests.

## Task 5: the gateway server, ingress, egress, dispatch

Crate `omni-gateway`, a binary `omnigateway`.

- **Server.** Tokio multi-thread, hyper 1.x server.
  - Listen on `OMNI_HOST:OMNI_PORT`.
  - `/health` matches the TS response.
- **Ingress.** Parse and validate the three dialects into the IR, with the same
  error bodies and status codes (`apps/gateway/src/ingress/*`), plus the model
  allowlist and auth (`auth/apiKey.ts`: Bearer or x-api-key, both → reject).
- **Dispatch** (`dispatch/index.ts`, `attempt.ts`, `classify.ts`, `price.ts`):
  - candidates in rank order and failover before the commit point;
  - in-stream errors after it;
  - deadline, cost and health recording.
  - Health writes and log events go through the Task 2 writer.
- **Egress.** Anthropic, OpenAI and Responses renderers, streaming and
  non-streaming:
  - `: keepalive` every 10 s (4 s for Responses);
  - rate-limit headers;
  - one-pass streaming into a reused buffer.
- **Cancellation.** Client disconnect drops the task. A 499 row goes to the
  writer.
- **Request body size limit:** 32 MiB. Over it, return the dialect's
  invalid_request error.
- **Shutdown.** SIGTERM drains streams and flushes the writer.
- **Tests.**
  - E2E through the binary against a stub upstream, for every dialect, both
    streaming modes, failover, and the commit point.
  - Responses must equal the TS gateway's for the same request, with ids and
    timestamps masked. Write a small conformance driver under
    `conformance/e2e/` that runs the same requests against both binaries; the
    TS binary is built with `bun scripts/build-binary.ts`.

## Task 6: benchmark the Rust binary

- **Run** `scripts/bench-gateway.ts --gateway target/release/omnigateway` in
  single mode, with the same flags as the baseline.
- **Fix** what blocks it from running, and profile the gaps against the spec
  targets.
- **Record** `docs/benchmarks/<date>-rust-slice1.{json,md}`, comparing against
  the TS baseline.
