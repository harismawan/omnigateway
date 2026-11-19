# Request Traceability Design

Date: 2026-10-24
Status: implemented

Corrections recorded at implementation, against the clients' current source:

- **OpenCode's own session header is `x-opencode-session-id`** (`packages/core/src/session/model-request.ts`), sent beside `x-opencode-session` (an affinity value). The id wins; the affinity header is the fallback. Its user agent is `opencode/<channel>/<version>/<app>`.
- **Pi sends OpenCode's headers** when it talks to an OpenCode endpoint, with `x-opencode-client: pi`; it is recognised as Pi first. Its user agent is `pi/<version> (…)`, or `pi` in short mode.
- **The sessions summary is also on the client surface** (`GET /api/client/sessions`), scoped by the session like `/api/client/logs`.
- **Upstream id capture** is a per-attempt `HttpClient` decorator (`dispatch/upstreamRequestId.ts`), which tests see through via `unwatched`.

## Goal

Answer three questions the request log cannot answer today:

1. **Which agent session, and which turn inside it, did this request belong to?** A Claude Code
   session makes dozens of requests; today they are indistinguishable rows under one API key.
2. **What did the caller want this request labelled as?** A team, an experiment, a job name.
3. **Which request is this, on every side of the gateway?** The id the client knows, the id the
   gateway minted, and the id the provider's support desk will ask for.

The motivating case: "this key burned $40 yesterday — which session was it, and what was it
doing?" Today the answer requires body capture and guesswork. After this design it is a filter.

This is the first of three designs written together. `2026-10-24-log-export-design.md` ships the
fields defined here to external stores; `2026-10-24-prompt-management-design.md` adds one more
column to the same row. Each stands alone.

## Prior art

Langfuse's `ai-gateway` (Rust, `langfuse/langfuse/ai-gateway`) does the same three things for its
own generations: coding-agent correlation headers become a session and a turn, `langfuse-*`
caller headers become tags and metadata, and every response carries a gateway request id while
the upstream provider id is recorded. This design borrows the header inventory and the
"bounded, ignore-invalid, never reject inference" stance; it does not borrow the trace-id
derivation (see *Out of scope*).

## Decisions

- **Stored on `request_logs`, as columns.** Not in `degradations`, not in a side table. They are
  filtered and exported, so they must be queryable.
- **Caller-supplied, bounded, never fatal.** A malformed or oversized value is dropped and noted;
  the request proceeds. Traceability must never refuse inference.
- **Agent headers are recognised, never trusted for identity.** They group rows; they never pick
  a key, a model, a route or a limit.
- **Claude Code's `metadata.user_id` is not parsed or stored.** It carries `account_uuid` and
  `device_id`; today it is hashed whole for cache affinity and that stays its only use. The session
  comes from the `x-claude-code-session-id` header instead.
- **The gateway request id is returned on every inference response**, success or failure,
  streaming or not, as `x-omni-request-id`.
- **The upstream provider request id is operator-only.** Stored and exported, never sent to the
  client and never shown on the client dashboard.

## Scope

In scope: extraction at ingress for all three surfaces, seven new `request_logs` columns on both
backends, the response header, per-attempt upstream id capture, OTLP span attributes, admin API
filters, a per-session summary query, console and client-dashboard display, CLI, docs.

Out of scope:

- **Deriving the OTLP trace id from the turn**, as Langfuse does. The gateway's spans already join
  an inbound `traceparent`; inventing trace ids would fork that. Session and turn ride as span
  attributes instead.
- **A sessions rollup table.** The per-session summary is a grouped query over `request_logs`,
  bounded by the time range. A rollup is warranted only if that query proves slow.
- **Widening the plugin `RequestCompleted` event.** Its doc comment calls widening a security
  change; the exporter in the sibling design reads the store instead.
- **User ids.** OpenAI `user`, Responses `user`/`safety_identifier` and Anthropic's account uuid
  stay unread. Attribution is per key plus whatever the caller labels.
- **Searching by metadata value.** Metadata is stored and exported; the console filters by
  session, turn, agent and tag only.

## Data model

New nullable columns on `request_logs`. SQLite migration `021_request_trace.sql`, Postgres
`009_request_trace.sql`, no backfill — old rows read as absent.

| Column | Type | Meaning |
|---|---|---|
| `session_id` | TEXT NULL | `<agent>:<id>` for an inferred session, or the caller's explicit id verbatim |
| `turn_id` | TEXT NULL | Same shape as `session_id` |
| `agent` | TEXT NULL | `claude-code` \| `opencode` \| `codex` \| `pi` \| null |
| `tags` | TEXT NOT NULL DEFAULT `'[]'` | JSON array of strings |
| `trace_metadata` | TEXT NOT NULL DEFAULT `'{}'` | JSON object, string → string |
| `client_request_id` | TEXT NULL | Caller's `x-request-id` |
| `upstream_request_id` | TEXT NULL | Provider's id from the attempt that produced the row's outcome |

Indexes: `(session_id, at DESC)` and `(api_key_id, session_id)`, partial on `session_id IS NOT
NULL` where the backend supports it. Tags are filtered with a `LIKE` on the JSON text (bounded by
the time range and the existing keyset index); a tag index is not warranted yet.

`RequestLog` (`packages/store/src/types.ts`) gains the seven fields. `RequestLogQuery` gains
`sessionId`, `turnId`, `agent` and `tag` (exact match on one tag). `usage.begin` writes the
trace fields at row creation so a pending row is already filterable; `usage.append` writes
`upstream_request_id`.

## Extraction

One pure function, `extractTrace(headers: Headers, request: ChatRequest): TraceContext`, in a new
`apps/gateway/src/trace/` directory, called from `routes/proxy.ts handle()` right after parse. All
three ingress parsers already receive the full `Headers`. The function reads `request.vendor` for
Codex's `client_metadata`; nothing else of the body.

### Caller headers (explicit — always win)

| Header | Becomes |
|---|---|
| `x-omni-session-id` | `session_id`, verbatim |
| `x-omni-turn-id` | `turn_id`, verbatim |
| `x-omni-tags` | `tags` — comma-separated, trimmed, deduplicated, order kept |
| `x-omni-metadata` | `trace_metadata` — comma-separated `key:value`, split at the first colon; percent-decode each key and value |
| `x-request-id` | `client_request_id` |

### Agent inference (used only when the explicit header is absent)

| Agent | Detected by | Session | Turn |
|---|---|---|---|
| Claude Code | `x-claude-code-session-id` present | that header | — |
| OpenCode | `x-opencode-session-id` or `x-opencode-session` present, or `user-agent` starting `opencode/` | `x-opencode-session-id`, else `x-opencode-session`, else `x-session-id`, else `x-session-affinity` | `x-opencode-request` |
| Codex | `client_metadata["x-codex-turn-metadata"]` in the Responses body, else the `x-codex-turn-metadata` header, else flat `client_metadata.thread_id`/`turn_id` | `thread_id` | `turn_id` |
| Pi | `user-agent` `pi/…` or `pi`, or `x-opencode-client: pi` (checked before OpenCode) | `x-opencode-session`, else `x-session-id`, else `session_id`, else `x-session-affinity` | — |

An inferred value is stored as `<agent>:<value>` so ids from different agents cannot collide.
Generic headers (`x-session-id`, `x-session-affinity`) are read only once an agent-specific header
or user agent has identified the caller; an unidentified caller's generic session header still
feeds cache affinity exactly as today and is not stored. The exact user-agent prefixes are
confirmed by the builder against current client releases and pinned in a test table.

The Codex turn snapshot is parsed only for `thread_id` and `turn_id`; nothing else in it is
stored. Codex's `client_metadata` is already replaced on egress by `codexLite`; extraction reads
the inbound copy before that and does not change egress.

### Bounds

- Each id (session, turn, client request id): at most 256 characters after trim, printable ASCII
  only (0x21–0x7E). Otherwise dropped.
- Tags: at most 16, each 1..64 characters, `[A-Za-z0-9._:/-]`. Invalid tags are dropped
  individually; over 16 keeps the first 16.
- Metadata: at most 16 entries; key 1..64 characters `[A-Za-z0-9._-]`, value at most 256
  printable characters. Invalid entries dropped individually; duplicate keys keep the last.
- Any header line over 4 KiB is ignored whole.
- Anything dropped or cut adds the degradation `trace:invalid` (a constant; no request data).

## Request ids

### Gateway id to the client

`x-omni-request-id: req_<uuid>` on every response from `/v1/messages`, `/v1/chat/completions`,
`/v1/responses` and `/v1/messages/count_tokens`:

- non-streaming success: beside the rate-limit headers at `proxy.ts` ~915;
- streaming: in the SSE head (`SSE_HEADERS` spread at ~381), so it arrives before the first event;
- errors from the terminal catch (~974), including auth and rate-limit refusals.

The id is minted before authentication so even a 401 carries one. `app.ts:267` defines the
factory; inference routes already call it before authentication (`routes/proxy.ts:421`), but
`count_tokens` calls it only after auth and parse (`:1081`) — move that call to the top of the
route. The body-level ids (`msg_…`/`resp_…`) are unchanged.

`count_tokens` stays unlogged: it creates no `request_logs` row today because rows feed usage
aggregates, and that does not change. It returns `x-omni-request-id` (useful for correlating a
client's own logs) but that id names no row.

No CORS is configured today, so no `Access-Control-Expose-Headers` is needed.

### Upstream id from the provider

No per-attempt HTTP wrapper exists today: dispatch passes `deps.http` straight to the adapter
(`dispatch/index.ts` ~674–690), and the only wrapper (`routes/proxy.ts:643–650`) is per request and
exists only when body capture is on. Add a thin, always-on per-attempt wrapper around `deps.http`
at that dispatch site. The shared `http-client.ts` already assembles the full response headers
(~118–129) before `onResponseHead` fires, so the wrapper reads them there: `request-id`
(Anthropic) or `x-request-id` (OpenAI, xAI, Kimi, Kilo, custom), bounded to 256 printable
characters. It must compose with the body-capture wrapper rather than replace it.
The row stores the id of the attempt that produced its final outcome (the serving attempt, or the
last tried on failure). Earlier attempts' ids are not stored — `attempts` already counts them.

Not sent to the client: it names a request on the operator's provider account, and the client
dashboard already hides credential identity.

## Classifier rows

Guardrail and smart-router classifier rows (`guardrail:classifier`, smart-router equivalents)
inherit the parent's `session_id`, `turn_id`, `agent`, `tags`, `trace_metadata` and
`client_request_id`, so a session's cost includes its classifier spend. Their
`upstream_request_id` is their own.

## Telemetry

The `gateway.request` span gains `omni.request.id`, `omni.session.id`, `omni.turn.id` and
`omni.agent` when present; `provider.http` gains `omni.upstream.request_id`. `SpanAttrs` is a
closed type, so this is a typed widening. Tags and metadata are not span attributes (unbounded
cardinality for trace backends; they are exported through the log-export design instead).
Prometheus is unchanged: none of these are metric labels.

## Surfaces

### Admin API and control

- `GET /api/logs` and `/api/logs/export` accept `session`, `turn`, `agent`, `tag`; export gains the
  seven columns (CSV: tags and metadata as JSON text, formula-neutralised like other cells).
- `GET /api/logs/sessions?since&until&apiKeyId?&agent?` — reader access. One row per
  `(api_key_id, session_id)` — an explicit session id reused across keys is two sessions, because
  keys are the unit of attribution. Returns `sessionId, apiKeyId, agent (MAX over the group; null
  for an explicit id from an unrecognised caller), firstAt, lastAt, requests, failed, turns
  (distinct non-null turn_id), tokens{4}, costUsd`, ordered by `costUsd` desc, capped at 500 rows.
  `since`/`until` required, range at most 31 days. Clicking a row filters the Logs tab by both
  session and key.

### Console

- Logs table: a Session cell (truncated, monospace, click filters by it). Detail panel: session,
  turn, agent, tags as chips, metadata as a key/value list, client request id, upstream request id
  (operator view only), each with copy.
- Filter bar: `session:`, `turn:`, `agent:`, `tag:` search terms, matching the existing
  `model:`/`error:` grammar.
- A **Sessions** tab on the Logs screen showing the summary query for the selected range; a row
  opens the Logs tab filtered to that session.

### Client dashboard

`toClientLog` passes through session, turn, agent, tags, metadata and client request id — the
key holder supplied them. It never passes `upstream_request_id`. The Sessions summary is
available to the client view scoped to its own key.

### CLI

`omni logs --session <id> --turn <id> --agent <name> --tag <t>`; `omni logs sessions --since
--until [--key] [--agent]`; `omni logs show <id>` prints the new fields.

## Testing

- `extractTrace` table tests: each agent's header set (fixtures captured from real clients),
  explicit-over-inferred precedence, generic headers ignored without an identifying agent, every
  bound (length, charset, counts, 4 KiB line), percent-decoding, `trace:invalid` on any drop, and
  that `metadata.user_id` never reaches the context.
- Store contract on both backends: round-trip, filters, sessions summary grouping, pending row
  carries trace fields before completion, migration on a populated database.
- Gateway, route boundary: `x-omni-request-id` present on success, streaming head, 401, 429 and
  5xx on all three surfaces, equal to the row id; present on count_tokens (including its 401),
  which still writes no row.
- Upstream id: stub adapter returns each provider's header; failover stores the serving attempt's
  id; an absent header stores null; never present in any client response or `toClientLog` output.
- Classifier rows inherit trace fields.
- Span attributes present when sampled.
- Console: filter terms, detail rendering, Sessions tab navigation; client view lacks upstream id.

## Docs

README (operator section: the headers a caller can send, the agent table), `ARCHITECTURE.md`
(where extraction sits), `docs/operations.md` (sessions query), CLAUDE.md if it lists
`request_logs` columns.

## Left to the builder

User-agent prefixes per agent (pinned in a test table); index shapes per backend; whether
`extractTrace` lives in `trace/` or `ingress/`; console layout details; exact CLI flag spelling.

## Calls made by the designer, not the operator

- Columns on `request_logs`, not a side table; no sessions rollup.
- `<agent>:` prefix on inferred ids; explicit ids stored verbatim.
- Header names `x-omni-session-id`, `x-omni-turn-id`, `x-omni-tags`, `x-omni-metadata`,
  `x-omni-request-id`.
- All bounds above (256 / 16×64 / 16 entries / 4 KiB).
- `metadata.user_id` stays unparsed; no user ids stored.
- Upstream request id operator-only; only the final attempt's id is kept.
- Classifier rows inherit the parent's trace fields.
- No OTLP trace-id derivation; tags and metadata are not span attributes.
- Sessions summary capped at 500 rows and 31 days; grouped by `(api_key_id, session_id)`.
- `count_tokens` returns the header but stays unlogged.
- A new always-on per-attempt HTTP wrapper in dispatch captures the upstream id.
