# Log export, part 1: metadata export — implementation plan

Spec: `docs/superpowers/specs/2026-10-24-log-export-design.md` (the binding authority; section names
below refer to it). This plan implements everything in the spec **except** the `## Bodies` section
and its tests/calls (that is part 2): no 64 MiB change, no body writer, no `body_state`, no
`include_bodies` behaviour beyond storing the flag (the column exists; the API refuses turning it on
with `BAD_REQUEST "body export is not available yet"` until part 2). Records never carry a `body`
field in part 1.

Branch: `feat/log-export`, stacked on `feat/request-traceability` (PR #276). Trace columns
(`sessionId` … `upstreamRequestId`) exist on `RequestLog` already.

## Global constraints

- Read `CLAUDE.md` first. Binding rules it states: store repo methods are added to `types.ts`, **both**
  `sqlite/` and `postgres/`, the sqlite forwarder in `sqlite/store.ts`, and a test in
  `packages/store/test/contract/`; `@omni/control` knows nothing about caller type; long-lived loops
  live in `apps/gateway`; dashboard calls `/api/*` only and mirrors wire shapes in `api/types.ts`;
  `LogFields` is a closed allowlist (never log record contents, secrets, URLs with credentials,
  receiver response bodies); all outbound **provider** HTTP uses `HttpClient` — export destinations
  are not providers, so the export worker uses `fetch` with `redirect: "manual"`, explicit timeouts and
  `AbortSignal`.
- TDD: every behaviour gets a failing test first; run it red, then green.
- Postgres contract tests run when `OMNI_TEST_DATABASE_URL` is set. Start one for your task with
  `docker run -d --rm --name omni-sdd-pg -e POSTGRES_PASSWORD=omni -e POSTGRES_DB=omni -p 127.0.0.1:55433:5432 postgres:18-alpine`
  and `export OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni`; stop it when done
  (`docker stop omni-sdd-pg`). If the container already exists, reuse it.
- Before reporting DONE: `bun run typecheck`, `bun run lint` (zero diagnostics, including infos), the
  tests you touched, and `bun test` for the packages you changed. Dashboard tests:
  `bun run --cwd apps/dashboard test -- <path>`.
- Exact values (all from the spec): settle lag 10 s; poll 5 s; pass ≤ 30 s; batch ≤ 500 rows /
  5 MiB encoded; connect timeout 5 s, request timeout 20 s; per-batch deadline 45 s; lease TTL 60 s;
  backoff 1 s doubling to 5 min, jittered, `Retry-After` honoured up to 5 min; ≤ 10 destinations;
  destination id `[a-z0-9-]{1,40}`; gap-warning margin 24 h; orphaned state rows kept 7 days; status
  messages ≤ 1/s; `res:export` invalidation ≤ 1 per 2 s; worker restart backoff 1 s → 60 s, five
  deaths in ten minutes stays down; ES index default `omni-logs-{yyyy.MM.dd}` (UTC, row `at`);
  record schema `omni.request_log/v1`; webhook signature `x-omni-signature: sha256=<hex>` plus
  `x-omni-timestamp`.
- Migrations: SQLite `022_log_export.sql`, Postgres `010_log_export.sql`.

## Task 1: completion cursor and settings marker (store)

Spec: *Cursor* (clock source, order, old-row backfill), *Retention changes*.

- Migration 022/010: `request_logs.completed_at` (INTEGER / BIGINT NULL), index `(completed_at, id)`;
  backfill `completed_at = at + duration_ms` for `state = 'done'` rows. Table
  `export_destinations` with the columns in *Destination* (`generation`, `type`, `enabled`,
  `config` JSON, `secret` encrypted envelope nullable, `filter` JSON, `include_bodies`,
  `max_request_bytes` nullable, `start_at`, `created_at`, `updated_at`). **No** `bump_config_version`
  trigger on it in Postgres.
- `usage.append` and `sweepPending` set `completed_at` in the statement that flips `state` to
  `done`: SQLite from the application clock (the repo's `now`/the log's completion instant), Postgres
  from `(extract(epoch from clock_timestamp()) * 1000)::bigint`. `RequestLog` gains
  `completedAt: number | null` (and `EMPTY_TRACE`-style defaults wherever logs are built:
  `newCompletedRequestLog` etc. — follow the existing pattern; keep `completedAt` store-owned, i.e.
  ignored on insert input).
- New repo read for the worker, on `UsageRepo`: `exportPage(q: { after: { completedAt: number; id: string }; settledBefore: number; limit: number; filter?: ExportFilter }): Promise<RequestLog[]>` — `state = 'done' AND completed_at IS NOT NULL AND completed_at <= settledBefore AND (completed_at, id) > after`, ordered `completed_at, id`; filter = optional `apiKeyIds[]`, `models[]` (requested or resolved, exact), `failedOnly` (status ≥ 400). Both backends + forwarder + contract tests (late-completing long request is returned after shorter later ones; settle bound respected; keyset exclusive; filter).
- Settings: `logRetentionLoweredAt: number` (default 0). `putSettings` on both backends: when the new
  `logRetentionDays` < stored, set it to `max(stored + 1, now)`; always keep `max(stored, incoming)`.
  Postgres `putSettings` becomes a transaction with `SELECT … FOR UPDATE` on the settings row before
  merge. Contract tests: lowering sets it; raising does not; a stale write cannot lower it; concurrent
  Postgres writes do not lose it.
- Store repo `exportDestinations` on both backends + forwarder + contract tests: `list()`, `get(id)`,
  `create(input)` (mints `generation` UUID; `start_at` = database clock now for `startFrom: "now"`, 0
  for `"oldest"`; enforces ≤ 10 → throw a typed `ExportLimitError`), `update(id, patch)` (config,
  filter, enabled, max_request_bytes, include_bodies; secret: string sets (encrypted with the store's
  key), `null` clears, absent keeps), `remove(id)`. Reads never return the secret plaintext; a
  separate `openSecret(id)` returns it decrypted (used only by the worker). Rows include `hasSecret`.
- Snapshots/restore include `export_destinations` (check `copy`/snapshot paths and add the table
  wherever other config tables are enumerated; add a test).

## Task 2: record builder and encoders (pure)

Spec: *Record*, *Destination* type-specific config, *Delivery* batch/partial-failure rules.

New package directory `apps/gateway/src/export/` (pure modules, no I/O):
- `record.ts`: `buildRecord(log: RequestLog, ctx: { keyLabel: string | null; nodeId?: string })` →
  `omni.request_log/v1` object exactly as the spec's *Record* block (minus `body`, minus `prompts`
  unless present). Pure, deterministic key order.
- `encoders/elasticsearch.ts`: `encodeBulk(records, { indexPattern })` → NDJSON body with `index`
  actions, `_index` from the pattern on the row's `at` in UTC, `_id` = request id;
  `readBulkResponse(json)` → `{ retry: boolean; dropped: Array<{ id; status; reason }> }` per the
  spec (429/5xx items → retry whole batch; other item errors → dropped, batch commits).
- `encoders/webhook.ts`: body `{"schema":"omni.request_log/v1","records":[…]}`; `sign(body, secret, timestamp)` → `x-omni-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">`, `x-omni-timestamp` (document the signed string in README).
- `encoders/otlp.ts`: `logs` (one LogRecord per row, attributes from the record) and `traces` (one
  span per row, start `at`, end `at + durationMs`, GenAI attributes `gen_ai.request.model`,
  `gen_ai.response.model`, `gen_ai.system`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `session.id`, rest as `omni.*`), OTLP/HTTP JSON; parse
  `partialSuccess` → dropped count.
- `batch.ts`: cut records into batches ≤ 500 records and ≤ 5 MiB encoded.
- Golden-file tests per encoder; signature verifies with a reference HMAC; GenAI attribute names
  exact.

## Task 3: destination config validation and control operations

Spec: *Destination* (config per type, outbound URL rules), *Surfaces → Admin API and control*.

- `packages/control/src/export.ts`: zod schemas per type (strict); URL rules reuse the
  custom-provider endpoint validation in `packages/control/src/credentials.ts` (http/https, no
  credentials/query/fragment, private hosts allowed); `listDestinations`, `getDestination`,
  `createDestination` (`startFrom`), `updateDestination` (secret semantics), `setDestinationBodies`
  (part 1: `true` → `BAD_REQUEST "body export is not available yet"`; `false` allowed),
  `removeDestination`. Summaries carry `hasSecret`, never the secret. OTLP `traces` + bodies is
  refused (part 2 relevance, but validate now).
- Unit tests for each schema and operation.

## Task 4: export state store (export.db / Postgres table) with epoch fencing

Spec: *Destination* (`export_state` table and where it lives), *Delivery* (lease and fencing),
*Cursor* (effective position, gap warning, retention-lowered marker).

- `apps/gateway/src/export/state.ts`: an `ExportStateStore` interface with two impls:
  SQLite (`export.db` beside the main DB path, opened and migrated only by the worker) and Postgres
  (`export_state` table in the main DB — add it to migration 010 **without** a `bump_config_version`
  trigger, or create it in this task's own Postgres migration `011_export_state.sql` if 010 already
  merged in Task 1; rule: keep all export tables in 010 if possible).
- Operations: `ensure(generation, startAt)`, `claim(generation)` → `{ epoch, cursorAt, cursorId, … }`
  (epoch + 1), `commit(generation, epoch, { cursorAt, cursorId, caughtUpThrough, seenRetentionLoweredAt, exportedDelta, droppedDelta, lastSuccessAt })` → boolean (false = fenced out),
  `recordError(generation, epoch, msg)`, `flagGap(generation)`, `requestSkip(generation, at)`,
  `clearSkip`, `list()`, `deleteOrphans(liveGenerations, olderThanMs)`.
- Tests on both impls: fencing (a stale epoch's commit is rejected and never moves the cursor
  backwards), orphan deletion after 7 days, skip flag round trip.

## Task 5: the export worker (delivery loop)

Spec: *Asynchrony* (worker, read-only main handle, inputs), *Worker protocol*, *Delivery* (all
bullets), *Cursor* (gap warning algorithm), *Failure isolation*.

- `apps/gateway/src/export/worker.ts` (Bun `Worker` entry) + `apps/gateway/src/export/loop.ts`
  (testable core taking injected store reader, state store, coord, fetch, clock, timers).
- Read-only main SQLite handle (`new Database(path, { readonly: true })`, no migrations, no
  writes); Postgres small pool (2). Redis coord client for leases in cluster mode only.
- Tick every 5 s and on `destinationsChanged`; ≤ 1 pass in flight per destination; destinations
  concurrent; pass ≤ 30 s; lease `export:<generation>` TTL 60 s renewed before each batch (cluster
  only); epoch claim at pass start; conditional commit; per-batch 45 s deadline with AbortSignal;
  settle `completed_at <= now − 10 s` (database clock on Postgres); retry/backoff/hard-failure/partial
  rules; skip-to-now; gap warning (effective position `E = max(cursor_at, caught_up_through)`, flag
  when `E < H + 24h`, and when `logRetentionLoweredAt > seen_retention_lowered_at`) checked before
  every batch and on every tick even when disabled/backing off.
- Protocol messages exactly as the spec's table (part 1: `gatesChanged` may be accepted and ignored);
  `status` coalesced ≤ 1/s; `test` sends one synthetic record; `preview` returns `buildRecord` for a
  real row (no body).
- Tests (with a fake fetch receiver and fake clock): the request path posts nothing; a completed
  row arrives within settle + one tick; a long request completing late is still exported; retry
  statuses back off and don't move the cursor; 4xx pauses; ES partial errors drop and commit; skip
  counts drops; fenced commit after a simulated stall is rejected; gap warning raised on lag and on
  lowered retention, not for an idle caught-up destination.

## Task 6: gateway wiring, lifecycle, restore, metrics, admin routes

Spec: *Asynchrony* (start conditions), *Restore and import* (widen the guard; pause/resume), *Failure
isolation*, *Observability*, *Surfaces → Admin API*.

- Start the worker after the store is open and migrated, only when ≥ 1 destination exists, and on the
  first destination's creation; `stopLoops` posts `stop`; restart with backoff; five deaths in ten
  minutes stays down until the next destination change.
- Restore/import: widen the exclusive guard in `apps/gateway/src/routes/database.ts` to span pause →
  swap → resume per the spec's three steps; `SwapFailedError` leaves export stopped.
- Prometheus: `omni_export_records_total{destination,outcome}`, `omni_export_batches_total{destination,outcome}`, `omni_export_lag_seconds{destination}`, `omni_export_gap_warnings_total{destination}`, `omni_export_worker_restarts_total`, folded from status messages (scalar sets only).
- Admin routes per the spec list (reads `requireReader`, mutations `requireAdmin`, `res:export`
  invalidation ≤ 1 per 2 s); test/preview/skip return 503 `export worker not running` when it is down.
- `omni doctor` warnings: lag > 1 h, failing > 15 min, worker down.
- Tests: route auth matrix rows; restore pauses and resumes the worker (fake worker); worker absent →
  503s; metrics fold.

## Task 7: CLI and console

Spec: *Surfaces → CLI*, *Surfaces → Console*.

- `omni export list | show <id> | add <type> … | set <id> … | test <id> | skip <id> | remove <id>`;
  secrets from `--secret-file` or stdin only. The CLI runs without a gateway: list/show/add/set/remove
  go through `@omni/control` on the store; test/skip need the running gateway — say so and exit
  non-zero when it is not reachable (follow how other CLI commands treat gateway-only actions; if
  none, print "requires the running gateway; use the console").
- Console: an **Export** section/page (own nav entry under Settings group, builder's call) with list
  (type, enabled toggle, lag, last success, last error, gap warning + acknowledge), editor dialog per
  type (secrets shown as "set / not set"), Send test, Skip to now (confirm), bodies toggle disabled
  with "available in a later release". Mirror wire types in `api/types.ts`; add `res:export` to
  `TOPIC_QUERIES`.
- Tests: CLI commands; dashboard list/editor/test/skip.

## Task 8: docs

README (operator section: destinations, startFrom, Langfuse-via-OTLP example, recommended ES mapping,
webhook signature verification), `docs/operations.md` (lag, gap warning, skip-to-now, restore
behaviour), `ARCHITECTURE.md` (worker, cursor, fencing), `docs/roadmap.md` (export in core, alerting
still a plugin), CLAUDE.md only if a new invariant must be stated (one line each: the worker never
writes the main SQLite file; export tables carry no `config_version` trigger).
