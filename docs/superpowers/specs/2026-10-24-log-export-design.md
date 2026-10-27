# Log Export Design

Date: 2026-10-24
Status: draft (revised 2026-10-25: bodies stay in the store, 64 MiB per artifact; export-only and latest-per-conversation modes removed)

## Goal

Ship every completed request-log row to stores the operator already runs — Elasticsearch or
OpenSearch, any HTTP endpoint that takes JSON, an OTLP collector — durably, so the gateway's
30-day local log stops being the only record.

The motivating case: an operator with an existing ELK or Grafana stack wants gateway traffic next
to everything else, kept for a year, searchable by session and tag, without polling
`/api/logs/export` from a cron job and without losing rows when the gateway restarts.

Sibling designs: `2026-10-24-request-traceability-design.md` defines the session, turn, tag,
metadata and request-id fields this exports; `2026-10-24-prompt-management-design.md` adds the
applied-prompts field. Export works without either; it exports whatever columns the row has.

## Relationship to the roadmap

`docs/roadmap.md` places spend and quota *alerting* in a plugin because a notifier in core "buys a
configuration surface, a retry policy and an outbound origin that nobody asked the gateway for."
This design puts *export* in core anyway, by operator decision: plugin events are at-most-once,
per-node and dropped on overflow (`plugins/events.ts`), so a plugin cannot give the durable,
resumable, single-sender delivery export needs without reimplementing a store cursor. Alerting
stays a plugin candidate; update the roadmap to say export was the exception and why.

## Decisions

- **In core, durable, resumable.** The exporter tails the store with a persisted cursor. A restart,
  a crash or a failover to another node resumes where it stopped.
- **At-least-once.** A row may be delivered twice (crash between send and cursor commit); it is
  never skipped while the cursor is behind retention. Elasticsearch writes are idempotent by
  document id; webhook and OTLP receivers get a stable record id to dedupe on.
- **One sender per destination across a cluster**, by lease.
- **Metadata by default; bodies optional per destination**, behind the same two-key gate body
  capture already uses plus a third, export-specific one.
- **First-release destinations:** Elasticsearch/OpenSearch, HTTP webhook (JSON), OTLP (logs or
  traces). Langfuse is reached through OTLP traces; no native Langfuse client.
- **Destination secrets are encrypted at rest** with `OMNI_ENCRYPTION_KEY`, write-only through the
  API.

## Scope

In scope: a completion cursor on `request_logs`, a destinations table on both backends, the export
loop, three destination encoders, optional body inclusion, admin API, console screen, CLI,
Prometheus metrics, docs.

Out of scope:

- **Alerting and webhooks on events** (budget crossed, quota pace). Still a plugin.
- **Exporting anything but request-log rows** — no rollups, quota samples, health or audit.
- **Backfill of rows older than the destination.** A new destination starts from "now" by default;
  the operator may choose "from the oldest retained row" at creation (see *Cursor*). Nothing older
  than retention can be exported.
- **Transforming or filtering records per destination** beyond a key/model/state filter (see
  *Destination*). No field mapping, no scripting.
- **Kafka, S3, ClickHouse, Loki-native.** The webhook covers ad-hoc receivers; each of those is a
  future destination type earning its own encoder.
- **Native Langfuse ingestion API.**

## Cursor

`request_logs` has no monotonic completion order: a row is inserted pending at route time and
completed later (`usage.begin` / `usage.append`), keeping its start `at`. A cursor on `at` would
permanently skip a long stream that finishes after shorter, later requests were exported.

Add `completed_at INTEGER NULL` (SQLite) / `BIGINT NULL` (Postgres), set in the same statement that
flips `state` to `done` — `usage.append` and `sweepPending` both. Index `(completed_at, id)`.

- **Clock source.** SQLite is single-node: the application clock. Postgres may have several nodes
  with skewed clocks: `completed_at` is set from the database clock
  (`(extract(epoch from clock_timestamp()) * 1000)::bigint`), so all writers share one clock.
- **Settle lag.** The exporter reads only rows with `completed_at <= now - 10s` (database clock on
  Postgres). A transaction that commits more than 10 seconds after taking its timestamp can still
  be skipped; `usage.append` is a single short transaction, so this is accepted and documented.
- **Order.** `ORDER BY completed_at, id`, keyset `(completed_at, id) > (cursorAt, cursorId)`.
- **Old rows.** The migration backfills `completed_at = at + duration_ms` for every `done` row, so
  every completed row is exportable and on the same cursor. (One `UPDATE` at upgrade; it runs once,
  at boot, before the gateway serves traffic.) A destination created with `startFrom: "oldest"`
  starts at cursor `(0, '')`.
- **Retention.** Maintenance keeps deleting `request_logs WHERE at < horizon` exactly as today and
  is **not changed at all** by this design — no extra query, no extra write, no message. Export never
  blocks, delays or adds work to pruning. What export adds is a **warning, computed entirely in the
  worker**, that rows may have been pruned before they were sent. It is a flag, not a count: an
  exact count needs the delete and every cursor serialised against each other across the worker, a
  separate state database and other cluster nodes, and every protocol for that reviewed so far had
  races. A conservative flag needs none of it.

  The worker tracks each destination's **effective position** `E = max(cursor_at,
  caught_up_through)`, where `caught_up_through` is the settle bound (`now - 10 s`, database clock)
  of the last pass that found no rows ahead of the cursor — every row completed by then has been
  sent. It is written with the cursor, under the same epoch fence. So an idle but caught-up
  destination keeps advancing `E` every pass; a disabled, failing or lagging one does not.

  **Before every batch, and on every tick even while a destination is disabled or backing off,**
  the worker compares the committed `E` with the current prune horizon `H = now −
  logRetentionDays` (setting read through its read-only handle): if `E < H + 24 h`, it sets
  `gap_possible_at` (once, until acknowledged) and increments `omni_export_gap_warnings_total`.
  The console and `omni doctor` show "export is within a day of log retention or past it; rows may
  have been pruned before export" until the operator acknowledges.

  Why this cannot miss a loss (apart from the edge below): a row is lost only if it is deleted
  (`at < H`) while unsent (`completed_at > E`). Then `E < completed_at`, and `completed_at ≤ at +
  duration < H + duration`. For any request shorter than 24 h, `E < H + 24 h` — so the flag is raised
  no later than the first check after the loss; the check needs no record of what was deleted, so a
  worker that was down for longer than retention still raises it on its first check. Because `H`
  only grows, checking before each batch uses the pre-batch `E`, so a batch cannot advance past an
  unsent deleted row unflagged.

  **Retention changes.** The argument above holds while `logRetentionDays` only stays put or grows;
  an operator can also shorten it, which jumps `H` forward between a check and the batch that
  follows. Comparing the current value is not enough (shorten, prune, restore — the worker would
  never see it), so the change is recorded where it happens: `putSettings`, which already writes the
  settings JSON on the main thread, also sets `Settings.logRetentionLoweredAt` (epoch ms) in the same
  write whenever the new `logRetentionDays` is smaller than the stored one. No extra statement. The
  marker must never go backwards, so: its value is `max(stored + 1, now)` (monotonic even under
  clock steps); every settings write keeps `max(stored, incoming)` for it, so a client resubmitting
  a stale settings object cannot erase it; and Postgres `putSettings` — today an unlocked
  read/merge/write (`postgres/config.ts:138–145`) — becomes a transaction that reads the settings row
  `FOR UPDATE` before merging. That serialisation also fixes the existing lost-update race for every
  other setting; SQLite's single writer already serialises it. Each
  state row stores `seen_retention_lowered_at`, written with every cursor or `caught_up_through`
  commit. Before committing either, the worker re-reads the setting; if `logRetentionLoweredAt >
  seen_retention_lowered_at`, it sets `gap_possible_at` **before** committing, then commits with the
  new value. Any shortening, however briefly it lasted, therefore raises the warning for every
  destination at its next commit or tick — the cheap, conservative answer to an infrequent operator
  action. Lengthening only moves `H` back, which can only make the check stricter.

  Accepted edge: a single request running longer than 24 h whose start falls out of retention while
  it still runs. Documented; the margin is a constant.

  Conservative by design: a destination that falls within a day of retention is flagged whether or
  not any row was actually lost, and whether or not its filter would have selected them.

Migrations: SQLite `022_log_export.sql`, Postgres `010_log_export.sql` (renumber if the
traceability migration has not landed first).

## Destination

Configuration and runtime state are two tables, because they have different writers (see
*Asynchrony*): configuration is written only by the main thread through the admin API; state is
written only by the export worker.

`export_destinations` — configuration, in the main database on both backends:

| Column | Meaning |
|---|---|
| `id` TEXT PK | slug, `[a-z0-9-]{1,40}` |
| `generation` | immutable UUID minted at creation; identifies the destination's runtime state |
| `type` | `elasticsearch` \| `webhook` \| `otlp` |
| `enabled` | boolean |
| `config` | JSON, type-specific, non-secret |
| `secret` | encrypted envelope (`encrypt()` from `packages/store/src/encryption.ts`), nullable |
| `filter` | JSON: optional `apiKeyIds[]`, `models[]` (requested or resolved), `failedOnly` |
| `include_bodies` | boolean, default false |
| `max_request_bytes` | integer, nullable — the encoded-request limit for this receiver; null takes the type's default (see *Bodies*) |
| `start_at` | the starting cursor, fixed **at creation** by the main thread: the database clock's now for `startFrom: "now"`, `0` for `"oldest"`. The worker initialises state from this value, never from its own start time, so a worker that starts late (crash, backoff) skips nothing |
| `created_at`, `updated_at` | |

`export_state` — runtime state, one row per **generation**:

| Column | Meaning |
|---|---|
| `generation` TEXT PK | the destination's `generation` |
| `cursor_at`, `cursor_id` | export position; initialised to `(start_at, '')` |
| `epoch` | fencing token, incremented by each new pass holder (see *Delivery*) |
| `last_success_at`, `last_error`, `last_error_at` | status; `last_error` is a gateway-authored summary plus HTTP status, never a receiver body |
| `exported_total`, `dropped_total` | counters (`dropped` = rejected by the receiver or skipped by *Skip to now*) |
| `caught_up_through` | settle bound of the last pass that found nothing ahead (see *Cursor*) |
| `seen_retention_lowered_at` | `Settings.logRetentionLoweredAt` as of the last commit; a newer value raises the gap warning |
| `gap_possible_at` | set when rows may have been pruned before export (see *Cursor*); cleared by the operator |
| `skip_requested_at` | set by *Skip to now* (see below), cleared by the worker when applied |

State is keyed by generation, not by slug: deleting a destination and creating another with the same
id, or importing a configuration whose slug matches, gets a new generation and therefore fresh state
— it can never inherit an unrelated, advanced cursor. Restoring a snapshot restores the
configuration row *with* its generation, so the destination it describes picks its own cursor back
up.

**Where `export_state` lives.** Postgres: a table in the main database, with **no**
`bump_config_version` trigger, so worker writes never invalidate routing snapshots. SQLite: a
**separate database file**, `export.db`, beside the main file, opened only by the worker — see
*Asynchrony* for why it cannot be in the main file. A state row whose generation no longer exists
in configuration is deleted by the worker after 7 days (long enough to survive restoring a recent
snapshot that still holds it).

At most 10 destinations. `secret` is never returned by any read; summaries carry `hasSecret`.

Type-specific config:

- **elasticsearch** — `url` (cluster base), `index` (pattern, default `omni-logs-{yyyy.MM.dd}` on
  the row's `at` in UTC), `auth`: `apiKey` | `basic` | `none` (credential in `secret`),
  `flavor`: `elasticsearch` | `opensearch` (affects only the bulk content type/version checks the
  builder finds necessary). Writes through `_bulk` with `index` actions and `_id` = request id, so
  a resend overwrites rather than duplicates. The gateway does not create index templates; README
  ships a recommended mapping.
- **webhook** — `url`, `headers` (non-secret), optional secret headers in `secret`, optional
  signing secret: when set, `x-omni-signature: sha256=<hex HMAC of the body>` and
  `x-omni-timestamp`. Body: `{"schema":"omni.request_log/v1","records":[…]}`.
- **otlp** — `endpoint` (base; `/v1/logs` or `/v1/traces` appended), `headers` in `secret`,
  `signal`: `logs` | `traces`. `logs`: one LogRecord per row, attributes from the record.
  `traces`: one span per row (start `at`, end `at + duration_ms`), GenAI semantic-convention
  attributes (`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.system`,
  `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) plus `omni.*` for the rest; session
  as `session.id`. This is what makes Langfuse's OTLP endpoint usable as a destination. These
  spans are separate from the gateway's live operational OTLP telemetry (`OMNI_OTLP_*`), which is
  sampled and lossy and unchanged by this design.

**Outbound URL rules.** `http:` or `https:`; no credentials, query or fragment in the base URL
(reuse the custom-provider endpoint validation in `packages/control/src/credentials.ts`). Private
and loopback hosts are allowed — the operator configures this, and an in-cluster Elasticsearch is
the common case — matching custom-provider endpoints. Redirects are not followed.

## Record

One JSON object per row, versioned:

```
{
  "schema": "omni.request_log/v1",
  "id": "req_…",                  // stable; dedupe key for every receiver
  "at": "2026-10-24T09:12:03.120Z", "completedAt": "…",
  "nodeId": "…",
  "apiKey": { "id": "…", "label": "…" },
  "model": { "requested": "smart", "resolved": "claude-…", "provider": "anthropic" },
  "credentialId": "…",
  "status": 200, "errorCode": null, "attempts": 1,
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "costUsd": 0.0, "ttftMs": 0, "durationMs": 0,
  "degradations": [], "rtk": { … },
  // when the traceability columns exist:
  "session": { "id": "…", "turn": "…", "agent": "claude-code" },
  "tags": [], "metadata": {},
  "requestIds": { "client": "…", "upstream": "…" },
  // when the prompt-management column exists:
  "prompts": ["team-rules@3"],
  // only when include_bodies applies (see below):
  "body": { "state": "included" | "truncated" | "unavailable", "client": { "request": …, "response": … } }
}
```

The key label is included because export receivers are operator systems; credential ids are
included for the same reason. The record builder is one pure function shared by all encoders and
by the console's "preview record".

## Bodies

*Operator decisions (2026-10-25):* bodies stay in the store and the export worker reads them from
there — there is no export-only mode and no in-memory body path. The store's limit on a body is
raised to **64 MiB per artifact**, and the structural limits inside it (per-string, array, depth,
key count) are removed, so a body is stored whole up to that size. An artifact holds the client
request and response and every provider attempt. Disk is bounded by body retention (1 day by
default) and the existing 100,000-row cap. No per-conversation deduplication: every request's body
is exported as its own.

Why 64 MiB and not unlimited (operator-approved): a 1M-token prompt is ~4–5 MB of JSON and Anthropic
refuses requests over 32 MB, so 64 MiB keeps every realistic body whole while the existing envelope
(uint32 length), Postgres `bytea` (≈1 GB field) and whole-artifact decrypt/parse all stay valid and
memory stays computable. Unlimited would need a chunked storage format, streaming capture into a
worker and streaming reads.

### What changes in body capture

- **`MAX_ARTIFACT_BYTES` = 64 MiB** (was 512 KiB). An artifact over it after masking still gets
  today's omission marker (`omitBodies`, `truncated: true`), so an oversized body is recorded as
  omitted, never silently dropped.
- **No structural bounding.** `boundValue` (64 KiB per string, last 24 array items, depth 6, first 80
  keys) is no longer applied to captured bodies. Masking (`MASK_RULES`) still runs on every string.
- **Stack-safe walking.** With the depth bound gone, masking (`maskSecrets`, recursive today) is
  rewritten as an iterative walk with an explicit stack, so deeply nested but small JSON is masked
  rather than overflowing. Serialization and parsing use the native `JSON` functions, which can still
  throw on pathologically deep input however small it is; on a `RangeError` the artifact is written as
  an omission marker with reason `nesting too deep`, never a failed capture with nothing recorded.
- **Capture caps follow the artifact cap.** `MAX_CAPTURED_BODY_BYTES` (wire request, response text,
  drained stream bytes, SSE frame sink) becomes the same 64 MiB per side. Bytes past it are still
  drained and discarded, never left in the pipe, and mark the side `truncated`, as today.
- **Readers follow.** `MAX_ENVELOPE_BYTES`, `MAX_BINARY_ENVELOPE_BYTES`, the gunzip
  `maxOutputLength` and the Postgres read's SQL length filter all derive from `MAX_ARTIFACT_BYTES`,
  so they move with it and keep their meaning: past them an envelope is `corrupt`. Every existing
  integrity check (authenticated header, claimed length, digest, gzip output length and consumed
  input) is unchanged. Artifacts written under the old cap still read.
- `bodyLoggingCaptureStreamChunks` is unchanged and optional; turning it on roughly doubles what a
  streamed response stores.

### Memory and the request path

Raising the cap 128× makes three things that were negligible at 512 KiB real, and the design bounds
each:

**1. A global capture budget, never back-pressure.** `OMNI_BODY_CAPTURE_BUDGET_BYTES` (default
512 MiB) bounds all bytes held for body capture across in-flight requests: collector buffers, the
frame sink, and parts queued for the body writer. Each collector reserves against it as bytes arrive
(a shared counter in the main thread; capture is main-thread code today). A reservation that would
exceed the budget **abandons that request's capture**: its buffers are freed, further bytes are
drained and discarded, and the artifact is written as an omission marker with reason
`capture budget exhausted` and `truncated: true`, counted in
`omni_bodies_dropped_total{reason="budget"}`. The client stream is never slowed. Reservations are
released when the body writer acknowledges the write (or the capture is abandoned).

**2. Sealing off the main thread.** At 512 KiB the artifact was masked, serialized, compressed,
encrypted and written inside `finishLog`, awaited. Now:

- `finishLog` **does not await** the body write. It hands the request's parts to the **body writer**
  — a dedicated `Worker` (`apps/gateway/src/bodies/writer.ts`) — and returns. Row completion, debits,
  telemetry and the client response never wait on a body.
- **What crosses to the worker is raw text, not parsed trees.** Collectors keep what they already
  keep as strings/chunks (wire request body text, response chunks, frames); the client request is
  passed as the **raw request text** the route read, not the parsed object (the route reads the body
  as text once, `JSON.parse`s it for the IR, and keeps the text for capture — replacing
  `captured.client.request = body`). The client response is passed as the serialized JSON the route
  already sends (non-streaming) or the frame list (streaming). No structured clone of an object tree
  happens on the main thread. Joining chunks, `JSON.parse`, masking, `JSON.stringify`, gzip and
  AES-GCM all run in the worker.
- **Handed over in bounded chunks, never one big copy.** A string is copied by `postMessage`
  synchronously on the sender, so the main thread never posts more than 1 MiB of text per message:
  each part is encoded to bytes in 1 MiB slices and each slice's `ArrayBuffer` is **transferred**
  (zero-copy) in its own message, yielding to the event loop between slices (`setTimeout(0)`), so a
  64 MiB part costs the loop sixty-four ~1 MiB encodes spread over turns rather than one 64 MiB
  stall. The encode copy is reserved against the capture budget before it is made and released when
  the worker acknowledges the slice; the worker reassembles slices by `(requestId, part, seq)`.
- **Who writes what.** The worker seals and, in SQLite mode, writes the encrypted file; the database
  write stays on the connection that writes today:
  - **SQLite:** the worker writes the artifact to a **staging path**
    (`request_bodies/.staging/<requestId>.<nonce>`), `fsync`s it, renames it to its final relPath,
    and posts `{ requestId, at, relPath, size, sha256, truncated, generation }` back; the **main
    thread** runs the existing one-row `request_bodies` upsert. One writer connection for the main
    file means `PRAGMA data_version` does not move for other connections' commits (a worker writing
    the row would make every captured request rebuild the routing snapshot via
    `sqlite/store.ts` `routing.version()`) and no new writer-lock contention.
  - **Postgres:** the worker writes the `bytea` row through its own small pool (2 connections).
    `request_bodies` carries no `bump_config_version` trigger, so it moves no routing version. A
    64 MiB parameter is well inside Postgres' field limit and Bun SQL's parameter handling.
- **Queue limit.** At most 1,000 requests may be waiting for the writer; past that a capture is
  abandoned the same way (reason `backlog`).
- **Failure isolation.** A writer crash loses what it held (`reason="writer_crash"`, each affected
  request's capture state set to `failed`), is restarted with backoff, and never affects inference.

**3. Bounded reads.** Decoding an artifact (decrypt, gunzip, `JSON.parse`) of up to 64 MiB is still
done whole — that is what the cap buys — but never on the main thread:

- The admin body route (`GET /api/requests/:id/body`) and `omni bodies` decode in the body writer
  worker (a `read` message) and return a **preview**: each part's first 1 MiB of serialized JSON plus
  its full size and a `previewTruncated` flag. The dashboard renders only that.
- A new `GET /api/requests/:id/body/raw?part=…` (admin-only, like the existing route) streams one
  part's full JSON, decoded in the worker, as a download.
- The export worker decodes in its own thread (see *Exporting bodies*).

### SQLite staging and the orphan sweep

`sweepOrphans` deletes artifact files with no pointer row. The worker's file exists briefly before
the main thread writes its row, so:

- The worker writes only under `request_bodies/.staging/` until the file is complete, and the sweep
  never lists `.staging/`.
- After the rename to the final path, the window until the pointer row lands is covered by a
  **pending-publication set** in the main thread. The worker posts `publishing { relPath }` and
  **waits for the main thread's `publish-ok` before renaming**; the main thread adds the relPath to
  the set before replying. So by the time the file exists under its final name the main thread
  already protects it. The set entry is removed when the pointer row lands, when the worker reports
  failure, or when the worker is restarted (a crashed worker's pending paths are cleared and those
  files, if present, become ordinary orphans for the next sweep). The sweep already re-checks each
  candidate against the table immediately before unlinking; it now also checks this set.
- Staging files older than one hour are removed by the sweep (a crash mid-write leaves one).

### Capture state on the row

Body persistence is now asynchronous, so a row can complete before its body exists. `request_logs`
gains one column, `body_state TEXT NULL`, written by the main thread:

- `null` — body capture was not attempted for this request;
- `pending` — set at `begin` when capture is on for the request;
- `ready` — the writer's acknowledgement landed (SQLite: the pointer upsert and the `body_state`
  update run in **one transaction** on the main connection, `ready` or `omitted` chosen from the
  writer's result; Postgres: the worker writes the `bytea` row, and the main thread updates
  `body_state` on its acknowledgement);
- `omitted` — written, but as an omission marker (over 64 MiB, budget, backlog);
- `failed` — writer crash or write error.

Updates are single-row `UPDATE … SET body_state` on the main connection, the same kind of write
`usage.append` already makes; they never block inference beyond that. `sweepPending` treats a row
still `pending` an hour after completion as `failed`.

### Exporting bodies

`include_bodies` on a destination attaches the body to each exported record.

- **The export waits for the body, briefly.** A destination with `include_bodies` does not send a row
  whose `body_state` is `pending`: the export pass stops at that row (it is the cursor's next row,
  so nothing after it is sent either) until it becomes terminal, for at most **60 seconds after the
  row's `completed_at`**. Past that the row is sent with `body.state: "unavailable"` and
  `omni_export_bodies_late_total` is counted. Destinations without `include_bodies` never wait.
- **What is exported:** the client request and response (the pre-RTK client view, masked at
  capture). Provider attempts and stream chunks stay in the store.
- **Gates, checked at admission for every HTTP send**, even for artifacts captured earlier
  and still retained:
  1. `OMNI_BODY_LOGGING_ALLOWED` and `settings.bodyLoggingEnabled`, as currently set;
  2. the row's key is not `bodyLoggingOptOut`;
  3. **`OMNI_EXPORT_BODIES_ALLOWED=true` at boot** — new, so a console admin alone cannot start
     sending prompt content to a third-party system;
   4. the destination's `include_bodies` is on, set only by an admin.
  One database statement snapshots settings, key existence/opt-out and destination
  generation/revision/enabled/include-bodies after encoding. This is the policy linearization
  point; the identity must match the prepared sender (including its config/secret revision).
  Boot gates and local cancellation/deadline checks follow synchronously before transport.
  A subsequent database edit cannot retract an already-admitted send. Every segment and replay
  takes a new admission snapshot; cross-node changes need no local notification.
- If any gate fails, the record carries no `body` field. When all hold, `body.state` is:
  - `"included"` — the artifact was read and is whole;
  - `"incomplete"` — read, but the artifact or the client side is `truncated` (client hung up, stream
    ended on an error, a side passed 64 MiB); the parts that exist are attached;
  - `"omitted"` — the artifact is an omission marker (over 64 MiB, budget, backlog, or a legacy
    artifact the old 512 KiB cap omitted); no parts attached, `reason` carried;
  - `"unavailable"` — no artifact: never captured, failed, waited past 60 s, or pruned by body
    retention (1 day by default against 30 for logs — operators exporting bodies keep lag well under
    body retention).
- Classifier rows have no artifact by design and read `"unavailable"`.

**Inline or separate.** A body rides inside the metadata record when the whole encoded record fits
the destination's `maxRequestBytes`. Otherwise the metadata record carries
`body: { state, parts: { request: n, response: m } }` and the body follows as separate **body
documents**, joined by request id:

- **Elasticsearch:** index `bodyIndex` (default `omni-bodies-{yyyy.MM.dd}` on the row's `at`), one
  document per part segment, `_id` = `<requestId>:<part>:<n>`, fields `requestId`, `apiKeyId`, `at`,
  `part`, `segment`, `segments`, `text`. Idempotent on resend. README's recommended mapping sets
  `text` to `index: false`.
- **Webhook:** one `POST` per part segment with the JSON text as the body and `x-omni-request-id`,
  `x-omni-body-part`, `x-omni-body-segment`, `x-omni-body-segments` headers, signed like metadata
  batches.
- **OTLP logs:** one LogRecord per part segment, body as the string value, request id and part as
  attributes. **OTLP traces** destinations cannot enable bodies (the API refuses it).
  Inline body-bearing records use the complete JSON request record as
  `LogRecord.body.stringValue`, retaining metadata attributes. Metadata-only records
  retain their existing short title string.

**Segmenting by encoded size.** Each destination has `maxRequestBytes` — the limit on the final
encoded HTTP request, envelope and escaping included (defaults: Elasticsearch 90 MiB under its
100 MB `http.max_content_length`; webhook 50 MiB; OTLP 4 MiB). The encoder fills a segment until the
next code point would push the encoded request past the limit (JSON escaping can expand text up to
sixfold), so every request fits. Boundaries are a pure function of the text and the limit, so a
resend produces identical segments and ids. A `413` despite the limit halves that destination's
effective limit once, logs it, and retries.

**Export-worker memory.** Decoding is whole-artifact, so the export worker bounds it with a
worker-wide **body budget of 192 MiB** shared by all destinations, and admits one body at a time:

- **One body in the worker at a time, all destinations included** (a semaphore held from decode to
  the body's last segment being accepted or the pass ending). That rules out reservation deadlock by
  construction: no second body can hold budget while the first waits for room.
- **The reservation is taken once, up front, for everything that body will need:** the decode
  workspace and the export after it. It is computed from the artifact's plaintext length `P`,
  read **before** decrypting and then verified:
  - **binary (`OGBA`) envelopes:** `P` is the header's claimed length, already capped at
    `MAX_ARTIFACT_BYTES` by `parseBinary` before any decrypt; it is used provisionally for admission,
    and the decode then enforces it (GCM authenticates the header; gunzip must produce exactly `P`) —
    a mismatch is `corrupt`, as today;
  - **legacy `enc:v1:` envelopes** (no length header): `P` = the ciphertext length derived from the
    validated hex (`(envelope length − 65) / 2`, the AES-GCM plaintext being ciphertext minus tag),
    which bounds the plaintext exactly; these were written under the 512 KiB cap, so they are small.

  **Implementation ruling (2026-10-27):** the previous formula undercounted simultaneous
  strings, WebCrypto copies and gzip buffers. Reserve
  `max(8E + 8P + 65536, 32P + 12S + 1048576 + 8M)` bytes, where `E` is envelope
  bytes, `M` encoded metadata size, and `S = min(maxRequestBytes, 6P + 4M + 4096)`.
  The decode branch covers envelope/decrypt/legacy-hex copies, expanded UTF-8,
  worst-case UTF-16 source/client spans and scanner stack. The export branch covers
  inline composition, nested OTLP quoting, retained slices, encoding trials, UTF-8,
  incompressible gzip overhead and native workspace. Trials examine at most
  `maxRequestBytes` code units; encoded segment arrays are never retained. This
  accounts body allocations, not total RSS or GC arenas.
  This is a conservative estimate for the pinned runtime, not a proof about all
  native allocator internals. The real three-destination large-pipeline probe
  records heap/external growth against a post-fixture GC baseline, wire-buffer
  sizes, concurrent decodes, cancellation and replay; runtime upgrades must recheck
  that evidence. Released attachments clear client references before slot handoff.
  The parsed tree is never built for export: the client request and response are extracted
  by a streaming JSON scanner over the decrypted text that copies out only the two client fields, so
  no node-heavy object graph exists to under-estimate.
- If that reservation exceeds the whole budget, the body is exported with `body.state: "omitted"`,
  reason `export budget`, counted — never partially sent. With the defaults this is an artifact over
  approximately 2 MiB of plaintext on a default Elasticsearch destination (less with
  large metadata, more with a smaller receiver cap); operators exporting larger bodies raise
  `OMNI_EXPORT_BODY_BUDGET_BYTES`.
- Decode references leave scope after extraction. Keep the conservative reservation
  without shrinking until the last segment is accepted or the pass ends; early release
  must not rely on GC timing.
- A batch never holds more than one record's body: rows with bodies are sent body by body (metadata
  for the rows before it go first in their own batch).
- A pass checks for cancellation (lease loss, pause, stop) between segments and releases the
  semaphore and its reservation on cancellation.

### Restore, import and shutdown

The body writer joins the lifecycle the export worker already has (see *Restore and import*): before
a swap the main thread sends it `pause`; it finishes or abandons its current write, stops accepting,
closes its handles, discards its queue (each request counted as `writer_crash`-equivalent
`reason="restore"`), and acks. Acknowledgements carry the **generation** the main thread stamped at
enqueue; after a swap the generation increments, so a late ack from before the swap is ignored and
cannot write a pointer into the restored database. Staging files are cleaned on resume. On shutdown
the writer gets the same 5 s as everything else; whatever is unwritten is lost and was counted.

### Sizing, stated in README

A full 1M-token prompt is ~4–5 MB of JSON; an artifact also stores each provider attempt's request
and response, so failover doubles it. Coding agents resend the whole conversation every turn, so
stored body volume tracks *conversation length × turns*: ten agents on long sessions can write
several GB an hour. Body retention (1 day default) and the 100,000-row cap bound disk; size the disk
(SQLite) or database (Postgres) for a day of traffic, or shorten body retention. The capture budget
(512 MiB default) bounds memory; raise it if `omni_bodies_dropped_total{reason="budget"}` grows.

## Asynchrony

Export is asynchronous in two senses, and both are requirements, not aspirations.

### 1. Nothing on the request path

Inference does no export work: no enqueue, no queue table, no event, no message to the worker, no
await. `request_logs` itself is the queue; each destination's cursor is its read position, and the
worker discovers new rows only by polling. The single touch is `completed_at`, written as one more
column in the `UPDATE` that `usage.append` / `sweepPending` already run — no extra statement, no
extra transaction. A request completes identically whether zero or ten destinations exist, and
whether they are healthy, failing, hanging or unreachable.

Body capture is not export work and is not affected by any destination. Its own move off the
request path — the body-write queue and the body writer — is described in *Bodies*.

### 2. Nothing on the gateway's event loop, and no lock inference waits on

Being off the request path is not enough. `bun:sqlite` is synchronous — each statement blocks the
loop (the comment on `PRAGMA synchronous` in `sqlite/db.ts` measures a request's whole store time at
~315 µs for exactly that reason) — and an export batch is 500 rows read, up to 500 body artifacts
read, decrypted and decompressed, ~5 MiB of JSON serialised and gzipped. On the main thread that is
tens to hundreds of milliseconds of blocked loop every few seconds: stalled streams for every
in-flight request. Three further couplings would stall inference even with the work moved off the
loop, and the design closes each:

- **Routing-snapshot invalidation.** SQLite's routing version is connection-wide `PRAGMA
  data_version` (`sqlite/store.ts:237–240`): *any* commit to the main file by another connection,
  to any table, makes the next inference request rebuild the routing snapshot
  (`dispatch/snapshotCache.ts:68–82`). On Postgres, any table carrying a `bump_config_version`
  trigger does the same.
- **The SQLite write lock.** The main connection waits synchronously up to `busy_timeout` (5 s,
  `sqlite/db.ts:149`) for the single writer lock. Any worker write to the main file, however short,
  can make an inference commit wait behind it.
- **Writes hidden in reads.** `bodies.get` writes `detail_state` back when a read's outcome differs
  from the stored state (`sqlite/bodies.ts:74–76,142,146`).

So:

- **The exporter runs in a dedicated Bun `Worker`** (`apps/gateway/src/export/worker.ts`), started
  after the main store has opened and migrated, only when at least one destination exists, and on
  the first destination's creation. The main thread never runs an export query, reads a body,
  builds or encodes a record, compresses a batch, checks for gaps, or awaits a receiver.
- **The worker never writes the main SQLite file.** It opens the main file **read-only**
  (`new Database(path, { readonly: true })`, the same pragmas minus writes, no migrations) for
  `request_logs`, `export_destinations` and `request_bodies`, and opens its own **`export.db`** for
  `export_state` (created and migrated by the worker; one table). WAL readers never block the
  writer, and no commit lands in the main file, so `data_version` does not move. Each read is a
  single short statement, so the worker never pins a long read transaction that would stop WAL
  checkpoints.
- **Bodies are read through a read-only artifact reader** — the same `readArtifact` decrypt and
  verify path, minus `recordState`. A body that reads as missing or corrupt is exported as
  `"unavailable"` and its stored state is left for the next operator read to update.
- **Postgres:** the worker opens its own small pool (2 connections). `export_state` is a main-database
  table with no `bump_config_version` trigger; neither is `export_destinations`. Worker writes
  therefore never move `config_version`. In cluster mode it also opens its own Redis coord client
  for leases.
- **Worker writes emit no store change events and no routing changes**, on either backend. The
  console learns about export progress only through the status messages below.
- **Inputs at start:** database path or URL, `OMNI_ENCRYPTION_KEY`, `OMNI_REDIS_URL`,
  `OMNI_EXPORT_BODIES_ALLOWED`, and the current body-capture gates (re-sent on every settings
  change, since `settings.bodyLoggingEnabled` lives in the main database the worker can also read).

### Worker protocol

Main → worker:

| Message | Effect |
|---|---|
| `destinationsChanged` | Wake now and re-read configuration (it is also re-read every tick) |
| `gatesChanged { … }` | New body-capture gate values |
| `test { id }` / `preview { requestId }` | Run the console's *Send test* or *Preview record*; reply with the result |
| `skip { id }` | *Skip to now*: write `skip_requested_at`; the lease holder applies it on its next pass |
| `pause` | Cancel in-flight passes, close **every** handle (main read connection, `export.db` or Postgres pool, Redis), reply `paused` |
| `resume` | Reopen fresh handles and continue |
| `stop` | Shut down |

Worker → main:

- `status` — per destination: lag, last success, last error, counters, `gap_possible_at`; read from the
  state rows (≤ 10) at most once per second, coalesced. The main thread keeps the latest snapshot in
  memory, folds it into the Prometheus registry (scalar sets only), serves it in API reads, and
  emits at most one `res:export` console invalidation per two seconds. The main thread never queries
  `export_state`.
- `testResult`, `previewResult`, `paused`.

No row data crosses the boundary except the single record a `preview` asks for.

### Restore and import

Database restore and import replace the main file and its WAL/SHM underneath any open handle
(`control/src/database.ts:603–608`), and the main store's `reopen()` reopens only its own handle.
Today the single-flight guard lives inside the control operation (`routes/database.ts:101–108`
calls into it), so it does not cover anything the route does before or after. **Widen it**: the
route takes one exclusive restore/import guard that spans all of the steps below, and the control
operation runs inside it.

1. Post `pause` and wait for `paused` — sent only after in-flight passes are cancelled and every
   worker handle is closed. On no ack within 5 s, terminate the worker. Automatic restarts are
   suppressed until step 3.
2. Run the swap and the main `reopen()` as today. The worker never resumes before `reopen()` has
   returned, so the main file's WAL and SHM exist again before the read-only handle reopens.
3. On success, **or on any failure before the swap began** (validation, staging, a refused second
   restore): `resume`, or start a worker if destinations now exist and none ran. On
   `SwapFailedError` (the swap began and could not complete): leave export stopped; the operator's
   restart brings it back.

`export_state` is not part of snapshots (in SQLite it is a separate file; in Postgres the snapshot
excludes it). Cursors survive a restore keyed by the destination's generation. Because the cursor is an absolute
`(completed_at, id)`, it stays meaningful against the restored log: rows completed after it are
exported, rows before it are treated as sent — at-least-once, and idempotent on Elasticsearch.

### Failure isolation

An exception in the worker never reaches the main thread. The main thread restarts a dead worker
with backoff (1 s doubling to 60 s) and exposes `omni_export_worker_restarts_total`; a worker that
dies five times in ten minutes stays down until the next destination change, reported by the console
and `omni doctor`. While the worker is down, *Send test*, *Preview* and *Skip to now* return 503
`export worker not running`; inference is unaffected.

## Delivery

- **Polling.** The worker polls on its own 5-second timer; a `destinationsChanged` from the main
  thread also runs a tick at once. Nothing else triggers it. Each destination has **at most one pass
  in flight**; a tick skips a destination whose pass is still running or whose backoff has not
  expired. A pass sends batches back to back until no settled rows remain or 30 s elapse.
  Destinations run concurrently, so one slow receiver never delays another.
- **Latency.** Request completed → batch sent: 10–15 s (10 s settle plus up to 5 s until the next
  tick), plus the receiver's own time. Under sustained load the pass keeps draining, so the lag does
  not grow with traffic while the receiver keeps up.
- **Lease and fencing (cluster mode only).** A Redis lease alone cannot protect a Postgres write — a
  holder can stall past its TTL between checking the lease and committing. So the lease only decides
  *who should try*; correctness comes from a **fencing token in the database**:
  - A pass takes `export:<generation>` (TTL 60 s), then claims the state row:
    `UPDATE export_state SET epoch = epoch + 1 WHERE generation = $1 RETURNING epoch, cursor_at,
    cursor_id`. That epoch is the pass's token.
  - Every cursor commit is conditional:
    `UPDATE export_state SET cursor_at = …, cursor_id = …, <counters> WHERE generation = $1 AND
    epoch = $token`. Zero rows updated means another holder has taken over: the pass stops
    immediately without committing — at-least-once, never a fork, never a cursor moved backwards.
  - Each batch has a hard deadline of 45 s from its last lease renewal covering read, encode, send
    (20 s request timeout) and commit, enforced with an `AbortSignal` passed to the store query, the
    body reads, the encoder loop (checked between records) and the `fetch`. An expired deadline
    aborts the batch uncommitted.
  - The lease is renewed before every batch; a failed renewal ends the pass.
  - A pass ends after 30 s or when caught up, releasing the lease.

  SQLite mode is one process: no lease, but the same epoch fence on `export.db` guards against a
  restarted worker racing a terminated one's last write.
- **Batch.** Up to 500 rows or 5 MiB encoded, whichever first. Gzip where the receiver accepts it
  (Elasticsearch and OTLP do; webhook opt-in via config). *2026-10-26: webhook gzip opt-in
  deferred; part 1 sends webhooks uncompressed.*
- **Commit.** The cursor advances to the batch's last row only after the receiver accepts it, in one
  single-row write to `export_state` together with the counters.
- **Retry.** Transport errors, timeouts, 408, 429 and 5xx end the pass (releasing the lease) and set
  the destination's next attempt to now + backoff (1 s doubling to 5 min, jittered, `Retry-After`
  honoured up to 5 min). **No retry sleeps while holding the lease**; the cursor does not move.
- **Hard failure.** Other 4xx: the destination stays enabled, the cursor does not move, `last_error`
  is set and the backoff applies at its maximum. The operator fixes the config or uses **Skip to
  now** (moves the cursor to the current tail, counting skipped rows as dropped). A broken
  destination never silently discards.
- **Partial failure.** Elasticsearch bulk responses with per-item errors: retryable item statuses
  (429, 5xx) fail the whole batch for retry; non-retryable item errors (mapping conflicts) count
  as `dropped`, are summarised in `last_error`, and the batch commits. OTLP `partialSuccess`
  rejections are treated the same way.
- **Timeouts.** Connect 5 s, request 20 s.
- **Shutdown.** `stopLoops` posts `stop` and does not wait (stoppers are synchronous and the drain
  deadline is 5 s); the worker is terminated with the process. An in-flight batch is abandoned
  uncommitted and resent on the next holder — at-least-once.

## Observability

Prometheus (destination id is bounded by the 10-destination cap):

- `omni_export_records_total{destination, outcome="sent|dropped"}`
- `omni_export_batches_total{destination, outcome="ok|retry|failed"}`
- `omni_export_lag_seconds{destination}` — now minus the cursor's `completed_at`
- `omni_export_gap_warnings_total{destination}` — times a destination fell within a day of retention

`omni doctor` warns on a destination whose lag exceeds one hour or which has been failing for more
than 15 minutes.

## Surfaces

### Admin API and control

All `requireAdmin`; reads `requireReader` (never including secrets).

- `GET /api/export/destinations`, `GET /api/export/destinations/:id`
- `POST /api/export/destinations` — body includes `startFrom: "now" | "oldest"`
- `PUT /api/export/destinations/:id` — config, filter, enabled; `secret` written whole when present,
  `null` clears, absent keeps
- `PUT /api/export/destinations/:id/bodies` — `{ "include": boolean }`; refused with
  `BAD_REQUEST` when `OMNI_EXPORT_BODIES_ALLOWED` is not set
- `POST /api/export/destinations/:id/test` — sends one synthetic record, returns status and latency
- `POST /api/export/destinations/:id/skip` — skip to now
- `DELETE /api/export/destinations/:id`
- `GET /api/export/preview?requestId=` — the record as it would be sent (bodies omitted)

Each mutation emits a change so the console updates over the existing WebSocket.

### Console

A **Export** section on the Settings screen (or its own nav entry if Settings is crowded —
builder's call): list with type, enabled toggle, lag, last success, last error; an editor dialog
per type with secret fields shown as "set / not set"; a "Send test" button; "Skip to now" behind a
confirm; the bodies toggle disabled with an explanation unless all gates hold.

### CLI

`omni export list | show <id> | add <type> … | set <id> … | test <id> | skip <id> | remove <id>`,
secrets accepted from `--secret-file` or stdin, never as a flag value.

### Database snapshots

`export_destinations` (configuration) is included in snapshots and restore like other config
tables. `export_state` is not (see *Restore and import*): cursors survive a restore by destination
generation, and a destination restored without a state row starts from its `start_at`.

## Testing

- Store contract on both backends: `completed_at` set by `append` and `sweepPending`; keyset order;
  settle lag; destination CRUD with encrypted secret round-trip and redacted reads; migration on a
  populated database.
- Cursor correctness: a long request that starts first and completes last is exported; a crash
  between send and commit resends; retention overtaking the cursor raises the gap warning and export
  continues.
- Cluster: two exporters against one Postgres and a shared coord — exactly one sends per
  destination; failover resumes from the committed cursor.
- Encoders: golden files per destination type; Elasticsearch `_id` equals request id and index
  name derives from `at`; webhook signature verifies; OTLP traces carry the GenAI attributes.
- Retry policy table: each status class → retry, hard-fail or partial; `Retry-After` honoured;
  cursor unmoved on failure; skip-to-now counts drops.
- Bodies: each of the four gates off → no `body`, including for an artifact captured before the
  gate was turned off; all on → masked client body; truncated and unavailable states; opt-out key
  never yields a body.
- Gap warning: a destination whose effective position falls within 24 h of the prune horizon is
  flagged before its next batch, including while disabled and on the first check after a worker
  outage longer than retention; an idle caught-up destination is never flagged; a destination well
  inside retention is never flagged; shortening `logRetentionDays` — including shorten-then-restore
  before the worker looks — flags every destination before its next commit; two concurrent Postgres
  settings writes, one lowering retention and one stale, never lose the marker. Maintenance's prune is byte-for-byte unchanged (assert
  its SQL).
- Backfill: after the migration every `done` row has `completed_at`; a `startFrom: "oldest"`
  destination exports pre-migration rows.
- Secrets never appear in API reads, logs, `last_error`, metrics or snapshots in plaintext.
- Request path unaffected: inference latency and outcome identical with a destination failing,
  hanging (receiver that never responds) or slow.
- Bodies:
  - capture stores a 20 MB client request (with its one attempt) whole, and separately a 20 MB
    streamed response whole — no structural bounding — and each reads back byte-identical (after
    masking) on both backends, including a real Bun SQL round trip on Postgres; a request + response
    + attempts whose combined artifact passes 64 MiB is an omission marker; a side over 64 MiB is
    drained, discarded and marked `truncated`; artifacts written under the old 512 KiB cap still read;
  - masking of a 100,000-deep nested JSON body succeeds (iterative walk); a serialization
    `RangeError` yields an omission with reason `nesting too deep`;
  - the main thread hands a 64 MiB part over in ≤ 1 MiB transferred slices and yields between them;
  - the reader's ceilings (envelope, binary envelope, gunzip output, Postgres length filter) follow
    `MAX_ARTIFACT_BYTES`, and an envelope past them is `corrupt`;
  - capture budget: concurrent long streams never hold more than `OMNI_BODY_CAPTURE_BUDGET_BYTES`;
    the request that would exceed it is abandoned as an omission (`reason=budget`) while its client
    stream is byte-identical and unslowed; a full writer queue abandons with `reason=backlog`;
  - `finishLog` does not await the body write: with the writer stalled, client latency and row
    completion are unchanged, and main-thread event-loop lag with 10 concurrent 50 MB captures stays
    within the no-capture bound (only strings cross `postMessage`; no parse or stringify of a body on
    the main thread — assert by instrumenting `JSON.parse`/`JSON.stringify` on large inputs);
  - the route reads the client body as text once and parses the IR from it;
  - SQLite: the worker writes only under `.staging/` until rename, and renames only after
    `publish-ok`; the main thread writes every pointer row and its `body_state` in one transaction
    (`data_version` on the main connection is unchanged by the worker); the orphan sweep never
    deletes a staged file or a file in the pending-publication set; a crashed worker's pending paths
    are cleared; staging files older than an hour are removed;
  - export worker: with three destinations exporting large bodies concurrently, only one body is in
    the worker at a time and peak body memory stays within `OMNI_EXPORT_BODY_BUDGET_BYTES`; the
    reservation is computed from the authenticated plaintext length (a highly compressible gzip
    artifact is reserved at its expanded size); a body whose reservation exceeds the budget is
    exported `omitted` / `export budget`; the client fields are extracted by the streaming scanner
    without building the parsed tree;
  - `body_state` moves `pending` → `ready` / `omitted` / `failed`; a writer crash marks its requests
    `failed`; `sweepPending` fails rows pending over an hour;
  - restore: the writer pauses, drops its queue (counted), and an ack from before the swap is
    ignored (generation); staging is cleaned on resume;
  - the admin body route and `omni bodies` decode in the worker and return a 1 MiB-per-part preview;
    `/api/requests/:id/body/raw` streams a full part and is refused for a viewer;
  - body export: a destination with `include_bodies` holds a `pending` row up to 60 s after
    `completed_at` and then sends it `unavailable` (counted); all four gates checked at send time;
    `included` / `incomplete` / `omitted` (with reason, including legacy 512 KiB omissions) /
    `unavailable` each produced from the matching artifact; a body that fits rides inline, a larger
    one goes as segmented body documents with stable ids and every encoded request within
    `maxRequestBytes` for worst-case escaping input; a `413` halves the limit once; OTLP-traces
    destinations cannot enable bodies; the export worker decodes at most one artifact at a time
    across all destinations.
- Polling: the request path posts nothing to the worker (assert no message other than
  configuration, gate and lifecycle messages); a completed request reaches a stub receiver within
  settle + one tick; a sustained stream of rows is drained pass after pass without falling behind a
  fast receiver.
- Event loop unaffected: with a destination exporting 500-row batches with bodies on, main-thread
  event-loop lag (timer drift probe) stays within the same bound as with export disabled. Pin the
  boundary structurally too: the export cursor query, record builder, encoders, artifact reader and
  `export_state` repository are importable only from `apps/gateway/src/export/worker*` (a lint/test
  that fails if the main-thread module graph reaches them).
- No snapshot churn: with SQLite, `PRAGMA data_version` on the main connection is unchanged across
  a full export pass; with Postgres, `config_version` is unchanged. Inference during export performs
  no routing-snapshot rebuild.
- No lock contention: the worker's SQLite handle on the main file is read-only (a write through it
  throws); `bodies` reads in the worker never write `detail_state`.
- Worker lifecycle: crash → restart with backoff; restore/import pauses the worker, which closes
  every handle before acking, and resumes with fresh handles; a worker that ignores `pause` is
  terminated at 5 s; `SwapFailedError` leaves it stopped; restarts are suppressed during a restore.
- Cluster lease and fencing: overlapping ticks never run two passes for one destination; a holder
  stalled past its lease (simulate by pausing it after send) has its commit rejected by the epoch
  fence and the new holder's cursor is never moved backwards; a batch past its 45 s deadline aborts
  uncommitted; no retry sleep while holding the lease.
- Identity: delete-and-recreate with the same slug starts from its own `start_at`, not the old
  cursor; a destination whose worker starts an hour late still exports from its creation time.
- Restore guard: a second restore while the first is pausing the worker is refused; a restore that
  fails validation resumes export; `SwapFailedError` leaves it stopped.
- Status messages are coalesced to at most one per second regardless of batch rate; no row data in
  any worker → main message except a requested preview.

## Docs

README (operator section, `OMNI_EXPORT_BODIES_ALLOWED`, `OMNI_BODY_CAPTURE_BUDGET_BYTES`, the
64 MiB body limit and the sizing paragraph from *Bodies*, recommended Elasticsearch mappings for
both indices with body `text` unindexed, raising Bun's request-body limit if larger requests are
expected, a
Langfuse-through-OTLP example), `docs/operations.md` (lag, gaps, skip-to-now), `ARCHITECTURE.md`
(the loop and the cursor), `docs/roadmap.md` (export is core, alerting is still a plugin).

## Left to the builder

Exact index-template recommendation; console placement; batch-size tuning within the stated caps; the OTLP
attribute names beyond the GenAI ones listed; CLI flag spelling.

## Calls made by the designer, not the operator

- Export runs in a dedicated Bun `Worker`, not on the main event loop; `request_logs` is the queue
  (no queue table) and the worker finds new rows only by polling every 5 s. The request path adds
  one column to an existing `UPDATE` and nothing else — no wake signal, by operator decision; the
  cost is 10–15 s latency.
- The worker never writes the main SQLite file: read-only handle there, runtime state in a separate
  `export.db`; on Postgres, export tables carry no `config_version` trigger. Configuration and state
  are separate tables with separate writers.
- Test, preview, skip and gap detection all run in the worker; the main thread only relays.
- Rows pruned before export raise a conservative **warning**, not a count, computed only in the
  worker by comparing its effective position with the retention horizon plus 24 h; maintenance is
  unchanged. Chosen after review found races in every exact-counting protocol.
- `completed_at` backfilled for existing rows by the migration.
- Redis lease picks the sender; a Postgres/SQLite epoch fence makes the commit safe; 45 s per-batch
  deadline with cancellation; one pass per destination; no retry sleep under the lease.
- State keyed by an immutable generation UUID, not the slug; starting cursor fixed at creation.
- `export_state` excluded from snapshots; orphaned state kept 7 days so a restore can reclaim it.
- The restore/import guard is widened to span pause → swap → resume.
- `completed_at` completion cursor with a 10 s settle lag; database clock on Postgres; 24 h
  gap-warning margin.
- At-least-once delivery; Elasticsearch `_id` = request id.
- A lease per destination; 5 s polling timer; 500 rows / 5 MiB batches; 20 s request timeout; 60 s
  lease.
- Hard 4xx pauses a destination rather than discarding; per-item bulk errors are dropped and
  counted.
- Export never blocks, delays or changes retention pruning.
- *Operator decisions (2026-10-25):* bodies stay in the store and are exported from it; the body limit
  is 64 MiB per artifact with structural bounding removed; disk is bounded by body retention and the
  100,000-row cap; client and attempts are both stored; no per-conversation deduplication.
- A global capture budget (`OMNI_BODY_CAPTURE_BUDGET_BYTES`, 512 MiB) and a 1,000-request writer
  queue; exceeding either abandons that request's capture as an omission, never slows inference.
- Body sealing in a body-writer `Worker`; only raw text crosses `postMessage` (the route keeps the
  client body as text); SQLite pointer rows still written by the main thread after a staged,
  fsynced, renamed file; Postgres rows written by the worker.
- `request_logs.body_state` (`pending`/`ready`/`omitted`/`failed`) so export can wait for a body; a
  body-enabled destination waits at most 60 s past `completed_at`.
- Exported body states `included` / `incomplete` / `omitted` / `unavailable`; a third gate,
  `OMNI_EXPORT_BODIES_ALLOWED`; client request/response only; gates rechecked at send time.
- A body that does not fit one receiver request is sent as segmented body documents
  `<requestId>:<part>:<n>`, sized by final encoded bytes (ES 90 MiB, webhook 50 MiB, OTLP 4 MiB).
- Reads decode in workers: the dashboard gets a 1 MiB-per-part preview and an admin-only raw
  download; the export worker admits one body at a time across destinations, reserves its whole
  need up front from the authenticated plaintext length under `OMNI_EXPORT_BODY_BUDGET_BYTES`
  (192 MiB), extracts client fields with a streaming scanner, one body per batch.
- Main thread hands bodies to the writer in ≤ 1 MiB transferred slices with yields; SQLite rename only
  after the main thread acknowledges the pending publication; masking walks iteratively.
- Body writer pauses for restore; acks carry a generation so pre-swap acks are ignored.
- Key labels and credential ids included in records.
- Private hosts allowed for destinations, no redirects.
- 10-destination cap; new destinations start from now unless told otherwise.
- Langfuse via OTLP traces with GenAI attributes, not a native client.
