# Log Export Design

Date: 2026-10-24
Status: draft

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
| `body_retention` | `every` \| `latestPerConversation`, default `every`; export-only mode only (see *Latest body per conversation*) |
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

Bodies reach a destination in one of two modes, chosen install-wide by
`Settings.bodyLoggingTarget: "store" | "export"` (default `"store"`):

- **`store`** — today's body capture, unchanged: bounded artifacts (512 KiB, 64 KiB per string)
  kept in the store and readable on the dashboard; export attaches the client part to the metadata
  record. Described in the rest of this section.
- **`export`** — full, unbounded bodies that never touch the store and exist only to be shipped.
  Described in *Export-only bodies* below.

In `store` mode, `include_bodies` exports the *client* request and response from the body artifact
(the pre-RTK client view, already masked by `MASK_RULES` at capture). Provider attempts and stream
chunks are not exported.

The exporter checks every gate **at send time**, for each record. Turning a gate off stops body
export immediately, even for artifacts captured earlier and still retained (artifacts outlive the
capture gates; `bodies.get` does not consult them):

1. `OMNI_BODY_LOGGING_ALLOWED` and `settings.bodyLoggingEnabled`, as currently set;
2. the row's key is not `bodyLoggingOptOut`;
3. **`OMNI_EXPORT_BODIES_ALLOWED=true` at boot** — new, so a console admin alone cannot start
   sending prompt content to a third-party system;
4. the destination's `include_bodies` is on, set only by an admin.

If any gate fails, the record carries no `body` field at all. When all hold, `body.state` is:

- `"included"` — the artifact was read; client request and response attached;
- `"truncated"` — as included, but a part exceeded 256 KiB serialized (head kept);
- `"unavailable"` — no artifact found. This covers both "never captured" and "pruned by body
  retention" (one day by default, against thirty for logs): pruning deletes the artifact's pointer
  row too, so the two cannot be told apart without new capture-provenance storage, which this design
  does not add. Operators who need bodies exported should keep export lag well under body retention.

Classifier rows have no artifact by design and read `"unavailable"`.

## Export-only bodies

*Operator decisions:* log every body in full with no size cap; send it only to export destinations;
keep the database (Postgres or SQLite) to metadata alone; **hold bodies in memory only — no disk
spool** — and ship them quickly so little is held; when memory is full, drop the oldest; optionally
keep only the latest body per conversation.

### What changes when `bodyLoggingTarget = "export"`

- **No body reaches the store.** `bodies.put` is not called and the existing collector
  (`bodyCapture.ts`) is bypassed entirely: no `request_bodies` row, no Postgres `bytea`, no artifact
  file. Nothing is written to disk anywhere. The dashboard's body view and `omni bodies` show "sent
  to export destinations" for these requests instead of content.
- **`request_logs` gains one column**, `body_capture TEXT NULL`, written by `usage.begin` in the
  statement it already runs: `store` | `export` | null (body logging off). It records the
  **decision at admission** and never changes, so an exported metadata row is never stale. The
  metadata record carries it as `"bodyCapture": "export"`: "a body for this request id was meant to
  follow on the body channel".
- **Capture is unbounded.** No 512 KiB artifact ceiling, no 64 KiB string cap, no array or depth
  bounding. What is captured is the **client view, as raw bytes**:
  - **Request:** in export mode the route reads `await request.arrayBuffer()` once, hands those bytes
    to capture, and parses JSON from the same buffer (`JSON.parse(new TextDecoder().decode(buf))`),
    replacing today's `request.json()` (`routes/proxy.ts:580`). No second read, no re-serialisation.
  - **Non-streaming response:** serialised once for the response; capture encodes its own copy.
  - **Streaming response:** the exact encoded bytes enqueued to the client — events, keepalive
    comments and delimiters — captured at the point the SSE `ReadableStream` enqueues them, not from
    the parsed-event callback (`:355`, `:365–366`), which omits keepalives and trailing delimiters.
  - Provider attempts and parsed stream frames are not captured; the raw SSE bytes already hold every
    event.
- **The limits that remain are not ours to lift:** the HTTP server's request-body limit (Bun's
  `maxRequestBodySize`, unchanged by this design), the memory budget below, and each receiver's own
  limits, handled by segmenting.
- **Gates.** Export mode needs the same capture gates as store mode (`OMNI_BODY_LOGGING_ALLOWED`,
  `bodyLoggingEnabled`, key not `bodyLoggingOptOut`) plus `OMNI_EXPORT_BODIES_ALLOWED`; the settings
  schema refuses `"export"` without the latter. Switching the target applies to requests admitted
  after the change.
- **Durability: none, by decision.** Bodies live only in the gateway process's memory until a
  destination accepts them. A restart, deploy or crash loses whatever was not yet sent — normally
  well under a second's worth (see *Shipping*), but everything held if a destination was down. Every
  loss that the gateway can still observe is reported (below); losses at process exit cannot be, and
  a receiver finds them by joining: a metadata record with `bodyCapture: "export"` and no body
  document.

### The body worker

A dedicated Bun `Worker`, the **body worker** (`apps/gateway/src/export/bodyWorker.ts`), separate
from the metadata export worker so neither can delay the other. It opens no database at all — it
holds bodies in memory and sends them. Started whenever `bodyLoggingTarget = "export"`.

- **Configuration** arrives by message from the main thread: the destination rows (≤ 10, secrets
  still encrypted; the worker decrypts with `OMNI_ENCRYPTION_KEY`) on start and on every
  destination change, and the capture gates on every settings change. These are configuration
  events, not per-request messages.
- **Memory budget.** `OMNI_BODY_BUFFER_BYTES` (default 1 GiB) bounds **every retained allocation**
  of export-only capture, accounted in one shared **held-bytes** counter:
  - the 16 MiB shared-memory ring (reserved once at start);
  - bodies being captured and finished bodies waiting to be sent — chunk bytes plus a fixed 64-byte
    charge per chunk descriptor, with chunks smaller than 4 KiB coalesced on arrival so descriptor
    count stays proportional to size;
  - **send-side working memory**, from a **dedicated send pool** carved out of the budget and never
    available to capture: `max(128 MiB, 2 × the largest destination's maxRequestBytes)`. Each
    in-flight send reserves its encoded request size from that pool before encoding begins and
    releases it when the request completes. At most 4 sends are in flight per destination and 16 in
    total; a send that cannot reserve waits only for other sends — which always finish — so capture
    filling its share can never starve delivery. Capture admission sees `OMNI_BODY_BUFFER_BYTES` minus
    the send pool;
  - conversation-key work: the parse of the first user message is a streaming scan of the raw
    request bytes that stops at the end of that message, with its own fixed 1 MiB cap (a first
    message larger than that is hashed as it streams, never buffered).
  Unaccounted allocations are limited to fixed-size bookkeeping (slot table, per-destination
  state), independent of traffic.

### Capture path: nothing blocking on the inference thread

- **Shared ring buffer.** At start the main thread allocates a 16 MiB `SharedArrayBuffer` ring shared
  with the body worker. A request id slot is assigned at admission from a fixed table in the same
  shared memory.
- **Main thread, per chunk:** a non-blocking reservation (`Atomics.compareExchange` on the ring's
  write index) for a small frame header (slot, part, sequence, length) plus the bytes, then a copy
  into the ring, an `Atomics.store` publishing the frame, and an `Atomics.notify`. No syscall, no
  allocation proportional to body size, no await.
- **Large pieces are handed off, never waited for.** A piece over 1 MiB — the raw request body, a
  non-streaming response — skips the ring. The main thread reserves its size atomically against a
  shared **held-bytes** counter (the budget above) and, if it fits, transfers the `ArrayBuffer` to the
  body worker with `postMessage(…, [buffer])` — an O(1) ownership transfer, no copy, no wait. **The
  reservation travels with the buffer**: the message carries `reserved: n`, the worker adopts it as
  that chunk's accounting and does **not** add it again; only the release (`Atomics.sub`) happens on
  the worker side. Ring bytes are accounted the opposite way: the ring is pre-reserved, and when the
  worker copies a frame out of the ring into a chunk it reserves the chunk (`Atomics.add`) before
  freeing the ring space. **Only
  buffers nothing else will ever read are transferred:** the raw request buffer after `JSON.parse`
  has run on it, and the capture-owned copy of a non-streaming response. That copy is
  **reserved before it is allocated**: the main thread reserves `3 × string.length` (UTF-8's
  worst case for a JavaScript string) against held-bytes, encodes only if the reservation
  succeeded (otherwise abandons with `buffer_overflow`, allocating nothing), and corrects the
  reservation down to the actual byte length right after encoding. **SSE bytes are never
  transferred**: the `Uint8Array`s enqueued to the client belong to the response stream, and
  detaching them would corrupt client output; SSE always goes through the ring.
- **Overflow never blocks.** A full ring, or a held-bytes reservation that does not fit, abandons
  that request's capture: the main thread marks its slot `abandoned` and stops copying for it. The
  body worker records the outcome `incomplete` (or `dropped` if nothing had been accepted), reason
  `buffer_overflow`. The client stream is unaffected.
- **End and abandonment never need ring space.** Each slot in the shared slot table has a state word
  and a `finalSeq` word. `finishLog` ends a capture by storing `finalSeq` (the last sequence number it
  emitted) and setting the state to `ended` with `Atomics.store` + `Atomics.notify` — no ring
  reservation, so a full ring cannot strand it. Abandonment is the same: state `abandoned` plus the
  reason code in the slot. The worker scans slot states on every wake and treats a slot as finished
  once its state is `ended` and every sequence up to `finalSeq` has been assembled, or as soon as it
  is `abandoned`. A request whose process path never reaches `finishLog` (a bug, not a normal path)
  is reclaimed by the worker after the gateway's maximum request duration as `incomplete`,
  reason `not_ended`. Slots are recycled only after the worker acknowledges them in the state word.
- **Body worker side:** waits on the ring with `Atomics.waitAsync` (never the blocking
  `Atomics.wait`, which would starve its `postMessage` handler and its sends). Ring frames and
  handoffs carry a per-slot sequence number assigned on the main thread in emission order; the worker
  assembles each request's pieces in order whichever channel delivered them. Assembled bodies are
  kept as lists of chunks, never concatenated into one buffer.

### Shipping: as soon as a body is finished

The body worker does not poll. A body is ready the moment its `end` frame is assembled, so the worker
**flushes every 250 ms**, sending every ready body for every destination that is not in backoff, plus
immediately whenever ready bodies exceed 16 MiB. With a healthy receiver a body is held for its own
request's duration plus at most ~250 ms and the receiver's response time; steady-state memory is
roughly throughput × that, a few MB for typical traffic. Memory grows only while a destination is
slow or down.

- **Per-destination pending sets**, in memory. A body is held once, whatever the number of
  destinations, and released when every body-enabled destination has accepted it (or it is evicted).
  With no body-enabled destination, bodies are released as soon as they finish — there is nothing to
  wait for — and the console warns "export-only body capture is on but no destination receives
  bodies".
- **Gates are rechecked at send time.**
- **Masking happens in the body worker at send time**, not on the request path, as a
  **bounded-state streaming transducer** equivalent to applying `MASK_RULES` in order to the whole
  text. Every rule matches a run of token characters (`[A-Za-z0-9_-]`, plus `.~+/=` after a
  `bearer` scheme), optionally preceded by `bearer\s+`, and decides on at most its first 64
  characters: `OPAQUE` at 41, the prefixed rules at prefix + 8. So the transducer holds back only the
  current unfinished run, **capped at 64 characters**, plus a flag for "inside a `bearer` context"
  (the whitespace after the scheme is passed through as it streams, however long). Once a run passes
  the cap its fate is decided — elided whole, or elided after its kept prefix — and the rest of the run
  is dropped as it streams. Memory is constant regardless of body or run length. The builder
  implements it as a hand-written state machine, not by running the regexes over windows, and a
  differential test asserts equality with `maskString` on the whole text for generated inputs,
  including runs of millions of characters and boundaries at every offset. The opaque-token rule also
  elides long base64 runs (inline images) — accepted, it is the existing rule.
- **Body documents are separate from metadata records**, joined by request id:
  - **Elasticsearch:** index `bodyIndex` (default `omni-bodies-{yyyy.MM.dd}`), one document per part
    segment, `_id` = `<requestId>:<part>:<n>`, fields `requestId`, `apiKeyId`, `at`, `part`,
    `contentType`, `complete`, `segment`, `segments`, `text`. README's recommended mapping sets `text`
    to `index: false`.
  - **Webhook:** one `POST` per part segment with the raw bytes as the body, its original content
    type, and `x-omni-request-id`, `x-omni-body-part`, `x-omni-body-segment`,
    `x-omni-body-segments`, `x-omni-body-complete` headers; signed like metadata batches.
  - **OTLP logs:** one LogRecord per part segment, body as the string value, request id and part as
    attributes. **OTLP traces** destinations cannot enable bodies (the API refuses it).
- **Segmenting by encoded size, not raw size.** Each destination has `maxRequestBytes` — the limit
  on the **final encoded HTTP request** including envelope and escaping (defaults: Elasticsearch
  90 MiB under its 100 MB `http.max_content_length`; webhook 50 MiB; OTLP 4 MiB). The encoder fills a
  segment until the next code point would push the encoded request past the limit (JSON escaping can
  expand text up to sixfold), so every request fits. Boundaries are a pure function of the masked
  text and the limit, so a resend produces identical segments and ids. Small bodies are batched into
  one bulk request up to the same limit.
- **Failures** follow *Delivery*'s backoff: a retryable error keeps the body pending for that
  destination; a hard 4xx pauses that destination's body delivery (metadata delivery is independent
  and continues). A `413` despite the encoded limit halves that destination's effective limit once,
  logs it, and retries. Bodies pending during backoff count against the memory budget and are subject
  to eviction.
- **Cluster:** each node ships the bodies it captured; no lease, no coordination — no other node holds
  them.

### Latest body per conversation

*Operator decision.* Agent clients resend the whole conversation every turn, so each body mostly
contains the previous one. A destination with `body_retention = "latestPerConversation"` keeps only
the newest body per conversation, so receiver storage — and the body worker's memory during an
outage — scales with conversations rather than with requests.

- **Conversation key** = `sha256(api_key_id + "\0" + session_id + "\0" + branch)`, hex, computed by
  the body worker from the raw request bytes. Session id comes from the traceability design's
  `session_id` (inferred or explicit), passed to capture at admission; the API key id is included so
  equal session ids under different keys never share a key. **`branch`** identifies one linear
  conversation inside a session:
  - when the client supplies an explicit thread or conversation identity, that wins: Codex's
    `thread_id` from its turn metadata (one per thread, including subagent threads). Turn ids are
    not used: a turn is one request, not a conversation;
  - otherwise it is derived from the **first message the user authored**, found per surface
    (Anthropic `messages`, Chat Completions `messages`, Responses `input`), skipping client-injected
    context turns (user turns consisting only of `<system-reminder>…</system-reminder>`,
    `<environment_context>…</environment_context>` or `AGENTS.md` instruction blocks; a pinned
    table extended by tests captured from real Claude Code, Codex and OpenCode requests). A first
    message alone does **not** prove one linear conversation — two branches can share it — so this
    derivation is used only where it has been verified: the worker keeps, per (API key, session,
    first-message hash), the message count and the hash of the message prefix of the newest body.
    A new body extends that branch only if its message list **starts with** the stored prefix
    (same messages, in order) and is longer or equal; a body that diverges from it is a different
    branch and **falls back to `every`** for itself, leaving the stored branch unchanged. Prefix
    hashes are computed in the same streaming scan, chained per message, with constant memory.
    **Branch state is bounded:** each entry is a fixed ~200 bytes, charged to the body memory budget;
    entries live in an LRU capped at 100,000 and expire 24 h after their last body.
    **Message-derived branches carry an incarnation**, because absence from the worker's memory
    does not prove absence at the receiver: when the worker starts a branch entry (first body seen,
    or the entry was evicted, expired or lost to a restart), it mints a random 64-bit incarnation
    and the key becomes `sha256(api_key_id + session_id + first-message hash + incarnation)`. A
    branch that resumes after its entry was lost therefore gets a **new** key and a new manifest; it
    can never overwrite what an earlier incarnation exported, whether that history matches or
    diverges. The cost is an extra conversation document on the receiver after a restart or an
    eviction, which a reader groups by `sessionId` and orders by `at`. Explicit thread identities
    (Codex `thread_id`) need no incarnation — the client vouches for the conversation;
  - if neither yields a value, or the request shape is not recognised, the request **falls back to
    `every`** (its key is its request id). Ambiguity always falls back; it never guesses.
  Consequences, all intended:
  - the main conversation, each subagent, and one-off utility calls (title, summary) in the same
    session have different first messages, so they get different keys and never overwrite each
    other;
  - for message-derived branches, a compaction replaces the history, so the first message changes and
    a new key starts; the pre-compaction body is kept. For explicit thread identities (Codex
    `thread_id`), compaction stays in the same thread and the compacted body replaces the old one —
    the pre-compaction history is then lost on the receiver, stated in README;
  - a request **without** a session id, or whose body cannot be parsed for a first user message,
    falls back to `every` for that request (its key is its request id).
- **Ordering.** Requests in one conversation can finish out of order (a long stream overtaken by a
  short one), and an older body must never replace a newer one. **Conversation order is admission
  order**: a client sends turn N+1 only after it has the answer to turn N, so within one
  conversation the later request is always admitted later — including a compacted request, which
  is admitted after the history it replaces even though it carries fewer messages. Concurrent
  captures in one conversation (a client retry, parallel calls) are ordered by admission too: the
  later-admitted one wins. So each body's `version` is an **admission sequence**, unique across the
  cluster and never truncated:
  - Cluster mode: `INCR omni:body-version` on coord (Redis) — a 64-bit counter, persistent in Redis,
    far beyond any realistic total (2⁶³). The body worker issues it when it first sees the slot at
    admission (off the request path; a few ms after admission at most, and slots are seen in
    admission order per node). Single-node mode: `version = max(nowMicros × 1024, last + 1)`, where
    `nowMicros` is wall-clock microseconds since the epoch and `last` the previous version issued
    by this process. It needs no persistence: after a restart the clock alone is already past
    every version issued before (a restart takes far longer than 1 µs), and within a process
    `last + 1` keeps it strictly increasing even if the clock steps back. The only exposure is a
    wall clock stepped backwards *across* a restart by more than the restart took; the worker
    refuses to issue versions (falls back to `every`) while the clock reads earlier than the
    `startedAt` the main thread recorded for its previous start, if known, and README tells
    operators to run NTP with slewing rather than stepping.
  - Cross-node nuance: two nodes can admit two turns of one conversation within milliseconds only if
    the client sent the second before the first was answered — that is a concurrent capture, and the
    rule "later INCR wins" is the ordering policy for it.
  - If coord is unavailable, the body falls back to `every` rather than risk a version that could
    collide or go backwards.
  - **Versions are `bigint` end to end.** `nowMicros × 1024` (~1.8 × 10¹⁸) is beyond JavaScript's
    safe-integer range, so every version computation uses `bigint`; Redis `INCR` replies are parsed
    as `bigint`; versions are written into Elasticsearch requests as JSON integer literals produced
    from the `bigint`'s decimal string (never through `number`), and stored manifests are parsed with
    a lossless integer reader for the `version` field. Elasticsearch external versions accept any
    value up to 2⁶³−1, which both schemes stay below.
  - Message count plays no part in ordering; it is used only for branch verification (above).
- **Elasticsearch: immutable segments plus one manifest**, so replacement is atomic from a reader's
  point of view and never depends on deleting the right documents:
  - **Index.** Conversation bodies go to a **non-dated** index, `conversationIndex` (default
    `omni-conversations`), so the same key always lands in the same index regardless of date. (The
    dated `omni-bodies-*` index is used only for `every` bodies.) Retention there is the operator's
    ILM/delete-by-query job on `at`; README gives one.
  - **Segments** are written first, as immutable documents
    `_id = <conversationKey>:<version>:<requestId>:<part>:<n>` (plain `index`, idempotent on
    resend). The request id makes the id globally unique even if two versions were ever equal. A
    segment is never modified or reused.
  - **Manifest** last: one document per key, `_id = <conversationKey>`, written with
    `version_type=external` and the body's version, holding `{ conversationKey, sessionId, apiKeyId,
    requestId, version, at, parts: { request: segments, response: segments }, complete, turns }`.
    Elasticsearch accepts it only if its version is higher than the stored one; a `409
    version_conflict` means a newer body is already current and counts as **delivered**. The
    manifest is written only after every segment of that body was accepted, so a manifest never
    points at missing segments.
  - **Readers** fetch the manifest, then its segments by id. Segments of superseded versions are
    unreachable through the manifest and are garbage, but are **kept for a reader-safety interval of
    10 minutes** after being superseded, so a reader holding manifest V can still fetch V's segments
    after V+1 is published. After a manifest write succeeds, the worker schedules a
    `delete_by_query` for that key's segments with `version < manifest.version` **and `supersededAt`
    older than 10 minutes** (each segment of the previous version gets `supersededAt` via an
    `update_by_query` when its successor's manifest lands), run by a cleanup pass every minute and
    retried until it succeeds. README's reader contract also says: if a segment is missing, re-fetch
    the manifest and retry — needed only for reads slower than the interval; segments are filtered by `version` and `requestId` fields
    stored on each segment document. An older body arriving late writes
    segments under its own version — they cannot collide with or resurrect anything — and its
    manifest write is rejected with `409`. **A `409` is not proof of a newer body**: a retry of a manifest
    write that succeeded but whose response was lost also gets `409`, at the *same* version. So on
    `409` the worker reads the stored manifest: same version **and** same `requestId` → the earlier
    attempt succeeded, the body is delivered, nothing is deleted; anything else (strictly higher
    version, or an equal version naming another request) → this body is superseded and the worker
    deletes **this body's** segments explicitly (`delete_by_query` on `conversationKey`,
    `version = this` and `requestId = this`), retried with backoff until it succeeds or the body's
    destination entry is dropped. Whether these segments were ever referenced cannot be proven — an
    earlier attempt of this same body may have published its manifest, lost the response, and been
    superseded by V+1 before this retry — so they get the **same treatment as superseded
    segments**: marked `supersededAt` now and deleted by the cleanup pass after the 10-minute
    reader-safety interval, never immediately. Cleanup never touches a segment named by the stored manifest.
- **Webhook and OTLP** cannot replace. They receive the newest body per key *at the time of
  sending*; a body already sent stays sent. Each delivery carries `x-omni-conversation-key` / the
  `omni.conversation.key` attribute and the version, so a receiver can do its own upsert.
- **In memory, by version, not by finish order.** For each key the worker keeps, per
  `latestPerConversation` destination, at most one pending body: the one with the **highest
  version**. When a body finishes, it replaces the pending one only if its version is higher; if it
  is lower (an older request that finished late), the finishing body is the one superseded for that
  destination. Superseded bodies are released once no destination still needs them (`every`
  destinations still do), counted (`omni_export_bodies_superseded_total`), not reported as losses.
  The worker also remembers, per key and destination, the highest version already **delivered**. An
  entry is **pinned** while any capture with the same key and an older version is still in flight
  (the worker tracks in-flight captures per key), so it cannot be forgotten while it still matters;
  unpinned entries live in an LRU of 100,000 keys. A finishing body older than the remembered version
  is superseded at once rather than sent. If an unpinned entry was evicted and an old body for that key
  later finishes, the Elasticsearch manifest's external version still rejects it (`409`), so the
  memory bound costs at most one redundant send, never a regression.
- **What is given up**, stated in README: per-turn bodies; anything the client rewrote out of its
  history between turns (dropped thinking blocks, cleared tool results from context editing, changed
  system reminders); and every response except the newest, beyond what survives as assistant
  messages in the latest request.

### When memory is full: drop the oldest

Before accepting more bytes would exceed `OMNI_BODY_BUFFER_BYTES`, the body worker frees memory:

1. It drops the **oldest finished** bodies (by finish time), whether or not some destinations already
   have them, until the new bytes fit.
2. If none remain, it abandons the **oldest in-flight** capture (by admission time) and marks its
   slot `abandoned` so the main thread stops copying for it.
3. Only if the bytes belong to the oldest capture itself and nothing else can be freed is that capture
   abandoned.

The main thread's own reservations (handoffs) fail fast against the shared counter rather than wait
for this; they abandon their capture as in *Capture path*.

### Reporting losses

Every body the gateway can still observe ends in one **outcome**: `complete` | `incomplete` |
`dropped`, with `reason` `buffer_overflow` | `evicted` | `worker_crash`.

- **To destinations.** A body that was cut short is sent with `complete: false`. A body with no
  content left gets a small **tombstone** (`{ requestId, part: "outcome", state, reason }`), sent like
  a body. Tombstones are held in memory too, capped at 100,000; beyond that the oldest are folded into
  a per-destination **gap counter** (`count`, `fromAt`, `toAt`), sent as one gap tombstone on that
  destination's next successful send and reset only by that send's acceptance (a snapshot is taken
  before sending; drops during the send accumulate into the next one).
- **Worker crash.** The held-bytes counter, the slot table, and the **loss ledger** live in shared
  memory owned by the main thread. The ledger holds, per destination, two counters: bodies not yet
  delivered to that destination, and outcomes (tombstones and the gap counter) not yet delivered to
  it — with the oldest and newest `at`. The **main thread increments** the per-destination body
  counter atomically when it accepts a capture at admission (one `Atomics.add` per body-enabled
  destination, at most ten), so a body that is still in the ring or in a queued handoff — not yet seen
  by the worker — is already counted. The worker decrements on delivery, supersession and release,
  and moves a count from "bodies" to "outcomes" when it turns a body into a tombstone. When
  the body worker dies, the main thread reads the ledger, adds the totals to
  `omni_export_bodies_dropped_total{reason="worker_crash"}`, marks every in-flight slot
  `abandoned`, resets the held-bytes counter, and restarts the worker with backoff (as in *Failure
  isolation*), passing the per-destination ledger values in its start message. The new worker seeds
  each destination's gap counter with them, so every destination is told — as one gap tombstone —
  about bodies and outcomes it will never receive. Their content and individual request ids are
  gone.
- **Metrics:** `omni_export_bodies_dropped_total{reason}`, `omni_export_bodies_superseded_total`,
  `omni_export_body_buffer_bytes` (current held bytes), `omni_export_bodies_sent_total{destination}`.
  The console and `omni doctor` warn when the buffer has been over 80% for more than a minute.
- **Dashboard mirror.** The main thread records each final outcome into two dashboard-only columns,
  `body_outcome` and `body_outcome_reason`, batched once per second off any request. A row whose
  outcome stays empty was lost at process exit.

### Sizing, stated in README

A full 1M-token prompt is roughly 4–5 MB of JSON; responses are far smaller. With a healthy receiver
the body worker holds a few MB. During a receiver outage, `every` fills a 1 GiB buffer in minutes
under agent traffic (each turn resends the conversation), after which the oldest bodies are dropped;
`latestPerConversation` holds about one body per active conversation (e.g. 50 × 5 MB) and stops
growing. Operators who need full per-turn history through long receiver outages should use store mode
or accept the loss; this design deliberately has no disk buffer.

## Asynchrony

Export is asynchronous in two senses, and both are requirements, not aspirations.

### 1. Nothing on the request path

Inference does no export work: no enqueue, no queue table, no event, no message to the worker, no
await. `request_logs` itself is the queue; each destination's cursor is its read position, and the
worker discovers new rows only by polling. The single touch is `completed_at`, written as one more
column in the `UPDATE` that `usage.append` / `sweepPending` already run — no extra statement, no
extra transaction. A request completes identically whether zero or ten destinations exist, and
whether they are healthy, failing, hanging or unreachable.

**The one exception is export-only body capture**, when the operator turns it on
(`bodyLoggingTarget = "export"`). Capture has to happen while the bytes pass, so the request path
then copies each chunk into a shared-memory ring with a non-blocking atomic reservation — no
syscall, no await (see *Capture path*). A full ring abandons that request's capture rather than slow
the client; assembly, masking and sending happen in the body worker. It
replaces, rather than adds to, today's store-mode capture, which awaits `bodies.put` in
`finishLog`. Nothing about destinations — their health, their number — reaches the request path
even then.

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
  (Elasticsearch and OTLP do; webhook opt-in via config).
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
- Export-only bodies:
  - a 200 MiB request and a 200 MiB streamed response are exported byte-identical (after masking),
    SSE keepalives and delimiters included, while process RSS stays within `OMNI_BODY_BUFFER_BYTES`
    + a fixed bound;
  - the request body is read once (`arrayBuffer`) and parsed from the same bytes; `JSON.parse` never
    sees a detached buffer;
  - main-thread capture performs no syscall and no await (instrument `fs` on the main thread and
    assert zero calls during a captured request); a receiver that hangs does not change client
    latency;
  - nothing is written to disk by capture or the body worker, on either backend — no
    `request_bodies` row, no file;
  - SSE buffers enqueued to the client are never detached (byte-identical client output with capture
    on, including chunks larger than the ring);
  - the body worker processes handoffs while idle on the ring (`waitAsync`) and assembles pieces in
    sequence order across ring and handoff;
  - flush: with a healthy stub receiver, a finished body is sent within 250 ms + receiver time, and
    held bytes return to ~0 between bursts;
  - memory full: held bytes never exceed `OMNI_BODY_BUFFER_BYTES` under a single endless stream and
    under a burst; eviction order is oldest finished, then oldest in flight; handoffs fail fast
    without waiting; every eviction and overflow yields an outcome (`complete: false` or a
    tombstone) and its counter; tombstones beyond 100,000 fold into one gap tombstone; drops during
    a gap send appear in the next one;
  - worker crash: the main thread counts held bodies and undelivered outcomes from the shared ledger
    as `worker_crash`, abandons in-flight slots, restarts the worker, and each destination then
    receives one gap tombstone covering them; inference unaffected;
  - accounting: held bytes include descriptors and in-flight send buffers; a handed-off buffer is
    counted once; a non-streaming response copy is reserved before encoding and nothing is allocated
    when the reservation fails; with capture filling its whole share, sends still proceed from the
    send pool (no starvation); with 16 concurrent sends of maximum size the budget still holds; tiny
    SSE chunks are coalesced;
  - crash ledger: a body still in a queued handoff when the worker dies is counted and reported;
  - end/abandon with the ring completely full still finishes or abandons the capture; a slot never
    reaching `finishLog` is reclaimed as `not_ended`;
  - with zero body-enabled destinations, bodies are released as soon as they finish;
  - masking: the streaming transducer equals `maskString` on the whole text for generated inputs,
    including multi-million-character runs and `bearer` with unbounded whitespace, at constant
    memory; masking across segment boundaries equals masking the whole text;
  - segmenting: every encoded request ≤ `maxRequestBytes` for worst-case escaping input (control
    characters, quotes); segment ids are stable across resends;
  - the settings schema refuses `"export"` without `OMNI_EXPORT_BODIES_ALLOWED`; OTLP-traces
    destinations cannot enable bodies; switching the target applies to newly admitted requests
    only; the exported metadata row's `bodyCapture` never changes after admission;
  - latest per conversation: the main conversation, a subagent and a title request in one session
    get three keys; a compaction starts a new key; a request without a session id is kept as
    `every`; equal session ids under two API keys get two keys; Codex threads (main and subagent)
    get separate keys from `thread_id`; injected `<system-reminder>`/`AGENTS.md`/environment user
    turns are skipped when choosing the first message; two branches sharing a first message — the
    diverging one falls back to `every` and the stored branch is not overwritten; an unrecognised
    shape falls back to `every`; a late old body whose delivered-version entry was evicted is still
    rejected by the manifest; a rejected version's segments are deleted; a manifest retry after a
    lost-but-successful write (equal-version `409`, same request id) is treated as delivered and
    deletes nothing; versions from two nodes never collide (64-bit coord counter); a later-admitted
    turn always outranks an earlier one regardless of node clocks; a Codex compacted body (fewer
    messages, same `thread_id`) replaces the pre-compaction body; a single-node restart never
    reissues a lower version; coord unavailable → `every`; versions above 2⁵³ survive a round trip
    through Redis, the bulk request and the manifest read without precision loss; a reader that
    fetched manifest V can still read all of V's segments for 10 minutes after V+1 is published;
    branch state stays within its cap; a branch resumed after its entry was evicted or the worker
    restarted gets a new incarnation and key and never overwrites the earlier manifest; an older body finishing after a newer one never replaces it, in memory (version
    compare) or in Elasticsearch (manifest `409`); a reader following the manifest never sees
    segments of two versions or a missing segment, including when an old body's segments arrive
    after a newer manifest; bodies land in the non-dated conversation index across a date change;
    superseded bodies are not sent to `latestPerConversation` destinations but still are to `every`
    destinations, and are not counted as losses; during a receiver outage memory holds about one
    body per conversation for a `latestPerConversation`-only setup.
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

README (operator section, `OMNI_EXPORT_BODIES_ALLOWED`, `bodyLoggingTarget`, `body_retention`,
`OMNI_BODY_BUFFER_BYTES`, the no-durability statement and the sizing paragraph from *Export-only
bodies*, recommended Elasticsearch mappings for
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
- A third gate, `OMNI_EXPORT_BODIES_ALLOWED`, for body export; in store mode client bodies only,
  256 KiB cap; all gates rechecked at send time; "never captured" and "expired" collapse into
  `unavailable`.
- *Operator decisions:* export-only body mode (`bodyLoggingTarget = "export"`) with no size cap and
  no body in the database; **bodies held in memory only, no disk spool**, shipped every 250 ms; when
  memory is full the oldest are dropped.
- Export-only bodies: raw client-view bytes (request read once as `arrayBuffer`, SSE captured as
  enqueued bytes; no provider attempts); a dedicated body worker with no database, fed by a 16 MiB
  shared-memory ring for small chunks and zero-copy `ArrayBuffer` handoff for pieces over 1 MiB, all
  under one `OMNI_BODY_BUFFER_BYTES` budget (default 1 GiB) — the main thread never blocks, overflow
  abandons the capture; flush every 250 ms or at 16 MiB ready; masking in the body worker by a
  bounded-state transducer (64-character carry); separate body documents `<requestId>:<part>:<n>`;
  segments sized by final encoded bytes (ES 90 MiB, webhook 50 MiB, OTLP 4 MiB); each node ships its
  own bodies without a lease; eviction oldest finished then oldest in flight; `body_capture` fixed
  at admission, outcomes shipped as `complete: false` bodies or tombstones (100,000 cap, then a gap
  counter) and mirrored to dashboard-only columns; losses at process exit are not reported and are
  found by joining metadata to bodies; no dashboard view of these bodies.
- *Operator decision:* per-destination `body_retention = latestPerConversation`. Designer's calls
  within it: key = sha256(API key + session id + branch), branch = explicit thread id (Codex) or the
  first user-authored message with injected context turns skipped **and** a verified message-prefix
  extension of the stored branch, plus a random incarnation per branch entry so a lost entry never
  reuses a key; divergence or ambiguity → `every`; version = a 64-bit cluster-wide admission sequence
  (coord `INCR`), so ordering ignores clocks, survives compaction, and versions are unique; segment ids include the request
  id; equal-version `409`s are checked against the manifest's request id; supersession
  by version, never finish order; Elasticsearch writes immutable versioned segments then one
  externally versioned manifest per conversation in a non-dated `omni-conversations` index, with
  stale segments cleaned up afterwards; superseded bodies dropped without tombstones.
- Body memory budget covers ring, chunks, descriptors and send buffers, with a dedicated send pool
  capture cannot use; response copies reserved before allocation; ≤ 4 sends per destination, 16
  total; handoff reservations transfer with the buffer; end/abandon signalled through the shared
  slot table, never the ring; a shared loss ledger survives worker crashes and becomes gap
  tombstones.
- Key labels and credential ids included in records.
- Private hosts allowed for destinations, no redirects.
- 10-destination cap; new destinations start from now unless told otherwise.
- Langfuse via OTLP traces with GenAI attributes, not a native client.
