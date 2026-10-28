# Codex 0.163.0 fingerprint for the OpenAI OAuth leg

Status: implemented, 2026-10-16. Builder's calls recorded under "Left to the builder".

## Current fingerprint — 2026-10-28

The current profile and bundled catalog are **Codex 0.165.0** (`rust-v0.165.0`,
released 2026-10-27). The sections below retain the original 0.163.0 design/history.
The current sanitized capture is `packages/providers/test/fixtures/codex-0.165.0.json`.

Re-captured the real 0.165.0 Linux binary locally with synthetic credentials, using
`gpt-6.1-terra` in the interactive TUI and an exec tool-loop follow-up. Headers,
their order, top-level body fields, turn metadata and client metadata are unchanged
apart from the version. The gateway continues to claim its Windows profile.

Changes from 0.163.0:

- Added `gpt-6.1-terra` to both catalogs. API prices per million tokens: input $1,
  output $5, cache read $0.05, standard cache write $1.25. API input cap 922,000,
  output cap 128,000; Codex default input cap 500,000. Catalog prices are the
  short-context tier; API and OAuth Terra prompts above 272K need long-tier prices.
  The API reasoning default
  is medium; the bundled Codex default is low, with node REPL review required.
- Lite developer/user messages carry `content_item_metadata`, one provenance per
  content part (`harness` with `hook: false` for developer instructions, `user`
  for user content, `tool` for tool-result media moved into user messages).
  Replayed assistant messages and tool items omit this field;
  non-lite models omit it everywhere. Base instructions also carry a turn id and
  creation time.
- Astra, Sol 6.1 and Terra 6.1 enable reasoning effort updates in the bundled
  catalog. They carry `configuration_update: {reasoning: {effort}}` after the
  current user prompt, before its assistant/tool loop. The gateway knows only the
  current request's effort, so does not invent historical effort changes.

Deliberate remaining gaps: the capture's prefix ids are UUIDv7 although this
release's `core/src/client.rs` still constructs UUIDv5 prefix ids. Keep the existing
deterministic UUIDv5 derivation for cache/retry stability. Client prompts/tools
remain the client's, and replayed reasoning ids and call namespaces follow the
existing exceptions below. No live-account acceptance probe was performed for
this refresh: local capture establishes client shape, not backend acceptance.

Sources: [model details](https://developers.openai.com/api/docs/models/gpt-6.1-terra),
[release](https://github.com/openai/codex/releases/tag/rust-v0.165.0), and its
[`models.json`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/models-manager/models.json).

## Intent

The OpenAI OAuth leg (`chatgpt.com/backend-api/codex/responses`) presents itself as the Codex CLI.
The operator wants that presentation to match the **latest** Codex release exactly, as a standing
hygiene rule rather than in response to a block or warning. Today the leg claims Codex `0.159.2`
but does not match even that release for the models it serves. This change brings it to
`rust-v0.163.0`: headers, header order, body shape, body encoding, and the per-turn metadata the
real client sends.

The operator chose **exact** over behaviour-preserving where the two conflict: fields Codex sends
that change model behaviour (`parallel_tool_calls: false`, `text.verbosity`) are sent as Codex
sends them, accepting that every client routed to an OpenAI OAuth target (Claude Code included)
gets one tool call per turn and terser answers.

## Goals

- Every request on the OAuth leg is indistinguishable, field by field, from what Codex 0.163.0's
  interactive TUI sends for the same model, except where this document names a deliberate gap.
- The shape is the **responses-lite** shape for every model whose Codex catalog entry sets
  `use_responses_lite: true` (every 0.163.0 catalog row but `gpt-5.5`; see History), and Codex's
  non-lite shape for the rest.
- Prompt-cache behaviour is unchanged (measured: identical hit rates, History).
- Updating to the next Codex release is a documented, repeatable procedure built on a local capture,
  not on reading source.

## Non-goals

- The API-key leg (`api.openai.com/v1/responses`) is untouched: standard Responses shape, standard
  fields. Everything here sits behind the existing `oauth` flag (`toResponsesWire` `opts.oauth`).
- Codex's own prompt **content** — its base instructions, `<skills_instructions>`,
  `<multi_agent_role>`, `<environment_context>` messages, its built-in tools (`exec`, `clock`,
  `collaboration` namespaces). The client's system prompt and tools are what get sent; only the
  container shape follows Codex. Fabricating Codex's prompt would change what the model is told.
- WebSocket transport. Codex tries `wss://…/responses` first and falls back to HTTPS; the gateway
  stays on HTTPS, which the backend serves to real Codex too.
- `/v1/responses` ingress handling of Codex-shaped *client* input (`additional_tools` items arriving
  from a Codex client of this gateway). Separate concern.
- Other providers' fingerprints.

## Anti-goals

- Tool calling breaking for any client. The decoder must keep returning tool calls exactly as now.
- A fingerprint that claims 0.163.0 in one place and 0.159.2 shape in another. Version and shape
  move together or not at all.
- Any new free-text in `LogFields`, or any of the new identity values (installation id, turn ids)
  being derived from client-supplied identifiers without hashing (same rule `cacheKey` follows).

## Constraints

- Provider rules: everything lives in `packages/providers/src/openai/` (boundary rule 2). `grok/`
  and `custom/` forks are not changed.
- `HttpRequest.body` / `CodecHttpRequest.body` are strings today and body capture
  (`apps/gateway/src/bodyCapture.ts`) parses them as JSON. Compression must not reach the captured
  artifact: captured request bodies stay readable JSON.
- Header order and casing go on the wire verbatim through `HttpClient`
  (`packages/providers/src/http-client.ts`); Bun `fetch` is never used for this.
- Env overrides in `openai/profile.ts` (`OMNI_OPENAI_CLI_VERSION`, `OMNI_OPENAI_ORIGINATOR`,
  `OMNI_UA_OPENAI`, `OMNI_ORDER_OPENAI`, platform/arch/terminal) keep working.
- `session-id` is what routes the Codex prompt cache (client-identity spec History). It must stay
  stable for a conversation and equal `prompt_cache_key`, `thread-id`, `x-client-request-id`, as
  Codex sends it.

## The target, as captured

Captured from Codex 0.163.0 (npm `@openai/codex@0.163.0`, binary `codex-cli 0.163.0`) run
interactively (`codex-tui`) against a local TLS capture server with a synthetic ChatGPT login.
Values shown are the gateway's (Windows profile), the structure is the capture's.

### Headers, in order

```
version: 0.163.0
x-codex-beta-features: remote_compaction_v2
x-codex-window-id: <thread>:0
x-codex-turn-metadata: <json, below>
x-openai-internal-codex-responses-lite: true
x-codex-routing-hint: model=<model>
x-client-request-id: <thread>
session-id: <thread>
thread-id: <thread>
accept: text/event-stream
content-encoding: zstd
content-type: application/json
authorization: Bearer <token>
chatgpt-account-id: <account>
originator: codex-tui
user-agent: codex-tui/0.163.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.163.0)
host: chatgpt.com
content-length: <compressed length>
```

Changes from today's profile: `originator` and the UA prefix become `codex-tui` (0.163's TUI runs
through the app-server and sets that originator; `codex_cli_rs` is now only the library default);
the UA gains the ` (codex-tui; 0.163.0)` client suffix; four headers are new
(`x-codex-window-id`, `x-codex-turn-metadata`, `x-openai-internal-codex-responses-lite`,
`x-codex-routing-hint`); `content-encoding: zstd` is new; the order changes (`originator` moves
after `chatgpt-account-id`, `host` and `content-length` last as hyper writes them on HTTP/1.1).

### `x-codex-turn-metadata`

A JSON object, keys in this order (from the TUI main-turn capture):

`installation_id`, `session_id`, `thread_id`, `agent_name` (`"/root"`), `turn_id`, `window_id`
(`<thread>:0`), `window_number` (`0`), `context_window_id`, `request_kind` (`"turn"`),
`history_initialization` (`"new"`), `root_turn_id` (= `turn_id`), `thread_source` (`"user"`),
`turn_trigger` (`"user"`), `sandbox`, `sandbox_mode` (`"workspace-write"`),
`auto_review_enabled` (`false`), `node_repl_auto_review_required` (`true`),
`node_repl_disabled` (`false`), `turn_started_at_unix_ms`, `analytics_enabled` (`false`),
`model`, `reasoning_effort`.

The same string is repeated inside the body's `client_metadata` (below). `history_initialization`
stayed `"new"` on the follow-up request of a turn in the capture; nothing observed it change.

### Body

Top-level keys in this order, absent ones skipped:

`model`, `stream`, `service_tier`, `input`, `tool_choice`, `parallel_tool_calls`, `reasoning`,
`store`, `stream_options`, `include`, `prompt_cache_key`, `text`, `client_metadata`,
`access_programs`.

No `instructions`, no `tools` (lite mode carries both inside `input`). Values Codex sends for the
GPT catalog models: `tool_choice: "auto"`, `parallel_tool_calls: false`,
`reasoning: {effort, context: "all_turns"}` (no `summary` when the catalog default is `none`),
`store: false`, `include: ["reasoning.encrypted_content"]`, `text: {verbosity: "low"}`
(catalog `default_verbosity`), `prompt_cache_key: <thread>`.

`client_metadata` is a string→string map: `session_id`, `thread_id`, `turn_id`, `root_turn_id`,
`x-codex-installation-id`, `x-codex-window-id`, `x-codex-turn-metadata` (the header's JSON string),
`guardian_credits_requested: "true"`, `mcp_attribution: "{\"status\":\"none\"}"`. Its key order
varies between captures (Rust `HashMap`), so no order is pinned.

### `input` in lite mode

1. `{type: "additional_tools", id: "at_<uuid>", role: "developer", tools: [<namespace>…]}`. The
   client's tools go in one namespace `{type: "namespace", name: "functions", description: "",
   tools: [{type: "function", name, description, strict: false, parameters}…]}`.
2. The client's system prompt: `{type: "message", id: "msg_<uuid>", role: "developer",
   content: [{type: "input_text", text}], internal_chat_message_metadata_passthrough:
   {content_item_kinds: ["model.base_instructions"]}}`.
3. History, each item carrying an `id` and `internal_chat_message_metadata_passthrough`:
   - user message: `id: msg_<uuid7>`, passthrough `{turn_id, create_time, content_item_kinds:
     ["user.text"]}`;
   - assistant message: `status: "completed"`, `id: msg_…`, passthrough `{turn_id,
     content_item_kinds: ["unknown"]}`; output parts carry `annotations: []`;
   - `function_call`: `status: "completed"`, `id: fc_…`, passthrough `{turn_id}`;
   - `function_call_output`: `id: fco_<uuid7>`, passthrough `{turn_id, create_time}`;
   - mid-conversation system turns already go as `developer` messages; they get the same
     treatment as user messages.

Ids in Codex's prefix items (`at_`, base-instructions `msg_`) are UUIDv5 over the thread id and the
item's payload, so they are stable across a conversation's turns. History ids in Codex are
server-assigned or uuid7 at creation.

## Decided

- **Exact match** where model behaviour is affected: `parallel_tool_calls: false`,
  `text.verbosity` from the catalog default (`"low"` for all current models). Operator's decision.
- Identity is the interactive TUI (`codex-tui`), not `codex_exec`. My call: it is the identity the
  profile already claimed to be, and an agent gateway serving interactive sessions reads as a TUI.
- Client tools all go in the single `functions` namespace. Measured: the backend returns calls from
  that namespace with no `namespace` field, so the decoder is unchanged. A replayed
  `function_call` may carry `namespace: "functions"` or omit it; both are accepted. My call: omit it,
  matching what the backend returns.
- The `include`, `reasoning`, `text` values above apply only when the client did not ask
  otherwise. A client's own vendor-bag values still win through the existing `Object.assign` merge,
  and `reasoning.summary` keeps today's rule (sent unless the client's display is
  `omitted`/`updates`): Codex users can configure `model_reasoning_summary`, so `summary: "auto"`
  is a value real Codex sends.
- Reasoning items replayed from history keep today's id-stripping (`wire.ts` `providerNative`
  branch). My call: that rule was measured against the backend; it is not reopened here.
- Compression is a transport concern. The codec returns the JSON string body plus an encoding
  marker; `nodeHttpClient` compresses and writes `content-length` of the compressed bytes. Body
  capture keeps seeing the JSON string.
- Version and fingerprint values live in `openai/profile.ts`; `0.159.2` disappears from code, tests
  and the client-identity spec's "current" tables in the same change.
- **Decoding follows the client, not our default `include`.** Today `codec.ts` reads
  `nativeReasoning` from the built body's `include`; with Codex's default `include` on every
  request that would turn every reasoning item into an openai `providerNative` block, hide
  thinking from Claude Code, and pin every conversation to OpenAI from turn 2. The wire carries
  Codex's `include`; `nativeReasoning` is decided from the **client's** vendor bag alone, exactly as
  today. When the client did not ask, the encrypted blob the backend returns is dropped on decode
  and reasoning reaches the client as `thinking`, as now. My call.
- **API-key leg.** It keeps today's body shape and gets none of the Codex-backend-only additions
  (lite shape, `x-codex-turn-metadata`, `x-codex-window-id`, lite header, routing hint,
  `client_metadata`, zstd, the behaviour-changing defaults). It does take the shared profile
  values — `version`, `originator`, UA — and the UUID-form cache key, since those are one
  profile; so it moves to 0.163.0 too and "byte-identical" does not apply. My call.
- **Purity and identity ids.** `buildRequest` stays deterministic per request: everything it
  generates is derived from inputs that do not change between the attempts of one request
  (failover, AUTH-refresh retry). The host passes the request's start instant into `CodecInput` as
  an optional field (additive; codecs that ignore it are unaffected); `turn_started_at_unix_ms` and
  `create_time` derive from it, `turn_id` and fresh history ids from `requestId`. Measured: ids,
  `turn_id` and `create_time` on history items may change on every request without costing a cache
  hit (History), so stability across requests is not needed for caching. Turn boundaries follow
  Codex: a user message that is not only tool results starts a turn; the items after it carry that
  turn's id; the current request's `turn_id` is the last such turn's, so a tool-loop follow-up
  shares its turn's id as Codex does. Each past turn's id is derived from the thread id and the
  turn's index. My call.
- **`installation_id`** is a UUIDv4-shaped hash of `providerData.accountId` — already in
  `CodecInput`, no contract change. Two credentials on one ChatGPT account share it, which is what
  one person's machine would show anyway. A credential without `accountId` hashes the thread id's
  derivation input instead. My call.
- **Vendor-bag precedence.** `client_metadata` is always ours: a Codex client's own map would send
  its real installation id upstream unhashed and contradict our turn-metadata header, so the
  client's is dropped (recorded as degradation `openai:client-metadata-replaced`). `text` and
  `reasoning` merge **per field**, the client winning per field: a client `text.format` keeps our
  `verbosity`; a client `reasoning.effort` replaces ours and keeps `context`. Every other bag key
  keeps today's whole-value `Object.assign`. My call.
- **Reasoning under "exact".** Codex always sends `reasoning.effort`. Client effort → sent as today.
  Omitted → the model's catalog default. `off` and `betweenTools` → the model's lowest supported
  level (`none` is not in the catalog's supported list for any current model; existing
  `betweenTools` degradation kept). `budget` → catalog default, existing degradation kept.
  `context: "all_turns"` always. My call, following the operator's exact rule.
- **Per-model values come from Codex's bundled catalog** (`codex-rs/models-manager/models.json` at
  the release tag): `use_responses_lite`, `default_verbosity`, default reasoning level, lowest
  supported level. Copied into the openai provider's own model data (`openai/models.ts` or beside
  it), with the release they were read from noted. Current GPT models all read lite / `low`
  verbosity / `low` lowest level. **Correction found while building:** the *default* reasoning
  level is not `low` for all of them — `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-terra` and
  `gpt-5.6-luna` default to `medium` in the 0.163.0 catalog, and that is what is copied. The two
  `node_repl_*` flags the turn metadata repeats are per-model too (`node_repl_auto_review_required`
  is `true` for `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol` only) and are copied beside them.
  **Every row is copied** (review fix): the hidden `gpt-daybreak-blue-latest`,
  `gpt-daybreak-red-latest` (verbosity `high`, default `medium`) and `codex-auto-review`, and
  `gpt-5.5`, which is **not** lite (default `medium`) — so "every GPT model is lite", as this line
  first said, was wrong. A model id not in that data uses the lite shape and `low`/`low`/`low`
  with both flags `false`: every other row is lite, and a non-lite 0.163 request was never
  captured. My call; the flag defaults are the builder's call. Data: `openai/codexCatalog.ts`.
- **Absent fields.** `service_tier`, `stream_options`, `access_programs` did not appear in any
  capture. They stay in the key order so a client bag value lands in Codex's position; the gateway
  never adds them.
- **Capture tooling is committed.** The local capture harness — raw-socket TLS capture server,
  synthetic ChatGPT `auth.json`/`config.toml` writer, pty runner for the TUI, request printer —
  goes under `scripts/codex-capture/` with a README giving the bump procedure. Tests pin
  hand-sanitized fixtures derived from the capture (ids replaced with fixed placeholders, no paths,
  no installation id); raw captures are never committed. My call.

## Left to the builder

- **Deterministic identity values.** Codex's thread id is a uuid7 minted at thread start. Ours must
  be stable per conversation without state: derive it from today's `cacheKey` input (same hashing,
  same precedence: client `prompt_cache_key` → client `session_id` → hashed `conversationId` →
  fallback). Format it as a valid UUIDv7 (version and variant bits), timestamp field never in the
  future. A client-supplied key that is already a UUID may pass through unchanged; any other
  supplied key is hashed into the UUID form. Changing the key format resets every conversation's
  cache once at deploy; that is accepted.
- `context_window_id` and the `at_`/`msg_` prefix ids: stable per thread (UUIDv5-style over the
  thread id and payload, as Codex does). History ids follow the purity rule under Decided; the
  backend resolves none of them under `store: false` (measured: fabricated ids accepted).
- `sandbox` for a Windows profile: read `SandboxType` in Codex 0.163 source for the Windows
  default (`windows_sandbox` restricted token vs `windows_mxc` vs `none`); `seccomp` would
  contradict the Windows UA.
- `reasoning_effort` in turn metadata: the effort actually sent, else the catalog default.
- The OAuth authorize URL's `originator` query (`openai/oauth.ts`): check what 0.163's login sends
  from the TUI and match it.
- Whether zstd uses `Bun.zstdCompressSync` or `node:zlib`; compression level as Codex's
  (check source).
- The harness itself is already written outside the repo (`/tmp/codexrun/srv/` on the machine
  this design was made on: `capture.ts`, `mkauth.ts`, `tui.py`, `show.ts`) and may be lifted as a
  starting point; it needs a throwaway CA (`openssl`, `CODEX_CA_CERTIFICATE`) because Codex refuses
  a non-HTTPS workspace backend origin, and an `accounts/check` answer naming that origin.

### Builder's calls

What the builder decided for each point above, and for the gaps found while building. Code in
`packages/providers/src/openai/` (`codexIdentity.ts`, `codexLite.ts`, `codexCatalog.ts`, `wire.ts`,
`codec.ts`, `profile.ts`); pins in `openaiCodexFingerprint.test.ts` against the sanitized fixture
`test/fixtures/codex-0.163.0.json`.

- **Thread id** (builder's call). `threadIdFrom(seed)`: a UUIDv7 whose random bits are
  `sha256(seed)` and whose 48-bit instant is drawn from the same digest into a fixed one-year
  window ending 2026-10-01 — entirely past, so never a future time whatever day it is sent, and
  stable per conversation. The seed is today's `cacheKey` input unchanged (conversation JSON or
  instructions + opening item); a supplied non-UUID key is hashed as `{"key": …}`. A supplied
  UUID — a Codex client's own thread — passes through verbatim. Header-safety and length checks on
  supplied keys are unchanged. The API-key leg uses the same key.
- **Prefix ids** (builder's call): Codex's derivation exactly — namespace `UUIDv5(NAMESPACE_OID,
  thread id)`, `at_` = `UUIDv5(ns, JSON of the namespace array)`, base-instructions `msg_` =
  `UUIDv5(ns, text)`. Verified bit-exact against both prefix ids of the real TUI capture (serde's
  key order is the declaration order the literal repeats). The test pins vectors computed with
  Python's `uuid.uuid5`, not with the repository's helper.
- **`context_window_id`, turn ids, history ids** (builder's call). `context_window_id` is a
  UUIDv7 seeded by the thread at the thread's instant. Turn `n`'s id is a UUIDv7 seeded by
  `thread:turn:n` at the thread's instant + `n` ms, so a past turn keeps its id and a tool-loop
  follow-up shares its turn's. The thread's instant is its own v7 timestamp when it is a v7 not
  after the request's start (a Codex client's real thread), else derived into the past window.
  History ids (`msg_`/`fc_`/`fco_`) are UUIDv7s at the request's start, seeded by `requestId` and
  the item index (thread id when there is no request id). `create_time` is the request's start in
  fractional seconds plus one microsecond per item index, so it reads monotonic as Codex's does.
  Without `requestStartedAt` (outside dispatch) the thread's instant stands in, keeping the build
  pure.
- **Turn boundary inside a message** (builder's call): a user message opens its turn at its first
  block that is not a tool result, so a tool result answering the previous turn's call stays in
  that turn even when new user text follows it in the same IR message.
- **Passthrough on replayed reasoning** (builder's call). Codex stamps `{turn_id}` on reasoning
  items (capture), so a replayed openai `reasoning` block gets it too; its id is still stripped
  (the rule above). Other `providerNative` item types are replayed untouched: not every Responses
  item type carries the passthrough field, and none was captured.
- **`content_item_kinds`** (builder's call): one per content part, as Codex's
  "aligned with the item's content entries" says — `user.text`/`user.image` for user and
  developer messages, `unknown` for assistant parts. A message holding a part Codex has no kind for
  (`input_file`, moved there from a tool result) is sent without the list rather than with a
  guessed kind, since the backend types the field.
- **Lite and non-lite.** Codex 0.163 sends base instructions inside `input` for every model,
  lite or not (`instructions` left the request struct), so the OAuth leg never sends the body
  field. What follows `use_responses_lite`, from `client.rs` `build_responses_request` and
  `tool_spec.rs`: lite puts the tools in the `additional_tools` namespace item, sends
  `parallel_tool_calls: false`, `reasoning.context: "all_turns"` and the
  `x-openai-internal-codex-responses-lite` header. Non-lite (`gpt-5.5`) sends the same function
  objects flat in `tools` (`create_tools_raw_json_for_responses_api`), `parallel_tool_calls` as
  the model's `supports_parallel_tool_calls` (true on every row; builder's call, since
  `prompt.parallel_tool_calls` was read as that flag, not captured), no `reasoning.context`, and
  no lite header. Pinned by `openaiCodexFingerprint.test.ts`.
- **Per-credential secrets** (review fix, builder's call on the details). `installation_id` and the
  derived ids were recomputable without a secret: the installation id hashed the account id sent
  in the next header, and turn and context-window ids hashed the thread id beside them. The
  OpenAI OAuth flow (`openai/oauth.ts`, provider-local, no store migration) now mints a random
  UUIDv4 `installationId` and a 32-byte hex `idSalt` into `providerData` at connect, keeps valid
  stored values on every refresh, and mints any missing or malformed one on refresh — which the
  refresher (`control/src/oauth/refresh.ts`) merges over the stored row, so existing credentials
  backfill on their next refresh. The codec reports the stored installation id and keys with
  HMAC-SHA256 over the salt: the derived thread id (a supplied UUID still passes through), turn
  ids, `context_window_id` and history ids. Codex's own UUIDv5 prefix ids stay unkeyed, as Codex
  derives them. Until a credential has both values, today's unkeyed derivation stands. This also
  closes the no-account case, whose installation id changed per conversation. Costs: the derived
  thread id changes once at a credential's backfilling refresh (one cache reset), and two
  credentials on one account now present two installations and two keys for one conversation.
  **Reconnect** (second review): `connect.ts` replaced `providerData` whole with the exchange's
  result, so reconnecting re-minted both values. The exchange now receives the reconnected
  credential's stored `providerData` as an optional field control does not interpret
  (`OAuthProvider.exchange`, `PluginFlowBase.exchange`), and the OpenAI flow keeps valid values
  from it. It is passed only when the stored row's provider is the flow's provider (`start`
  checks this, but the row is re-read at finish), so one provider's state never reaches another's
  flow. Remaining cost: none for ids; a reconnect that logs in to a different ChatGPT account
  keeps the old installation id and salt, which reads as one machine switching accounts. The
  refresher's merge order (refreshed value over stored) is what lets a refresh repair a malformed
  stored value; it is pinned in `refresh.test.ts`.
  `providerData` is stored unencrypted. `GET /api/credentials` returns it to every reader — the
  admin **and** the read-only viewer (`requireReader`) — and it travels in database snapshots,
  like Kimi's device id. The salt guards against recomputation upstream, not against anyone who
  can read the console or a snapshot.
- **`sandbox`** (builder's call): `windows_elevated` for a Windows profile. `sandbox_tags.rs` maps
  `WindowsSandboxSelection::Elevated` to that label (a fourth value beside the three named
  above); the TUI's first-run setup recommends the elevated sandbox and managed requirements
  prefer it, and `none` would describe a user who declined. Derived from
  `OMNI_OPENAI_UA_PLATFORM`, so a macOS UA sends `seatbelt` and anything else `seccomp`, never a
  Windows label beside a non-Windows UA.
- **`reasoning_effort`**: `body.reasoning.effort` after the client's bag merged, else the catalog
  default.
- **Reasoning, two details** (builder's call). `adaptive` with no effort named sends the catalog
  default (not today's `medium`), with `summary: "auto"` under the existing display rule. `off`
  maps to the lowest level as decided and records a new degradation,
  `openai:reasoning-off-as-lowest`, because the client asked for no reasoning and got some.
  `betweenTools` on this leg records `openai:reasoning-between-tools-as-lowest` (review fix): the
  older `openai:reasoning-between-tools-as-off` described the API-key leg, which keeps it, and rows
  carrying either stay readable.
- **Effort in the header** (review fix). `reasoning_effort` in turn metadata is the sent effort only
  when it is a named member of Codex's `ReasoningEffort` (`none` … `ultra`, `persistent`); a bag
  value outside it — free text bound for a header — reports the catalog default instead, while the
  body still carries what the client sent. `asciiJson` escapes everything outside printable ASCII
  per UTF-16 unit; both pinned.
- **Framing** (review fix, then made non-breaking; operator-approved). `codecAdapter` checks a
  codec's framing headers against its `bodyEncoding`. Marked `zstd`: exactly one
  `content-encoding: zstd` and no codec `content-length` (the transport counts compressed bytes).
  Unmarked: a codec `content-length` is accepted once, in any casing, when it equals the body's
  UTF-8 byte length — the transport then writes no second one — and `content-encoding: identity`
  once is accepted; a mismatched length, either header twice, or any other `content-encoding` is
  refused. A first version refused every codec `content-length` and `identity`, which would have
  broken a plugin codec that correctly set either. **No plugin-API generation bump**
  (`PLUGIN_API_VERSION` stays 3): everything a codec written before the marker could correctly
  send is still accepted; what is refused — a wrong length, a duplicate, a real encoding the
  transport never applied — already produced a request the upstream would misread. The
  repository keeps no changelog (releases use `gh release create --generate-notes` from PR
  titles), so the plugin-facing note lives in `docs/writing-a-plugin.md` §6 and the PR
  description.
- **`tool_choice`** (builder's call): a client's tool choice is encoded as today; absent, the OAuth
  leg sends Codex's `"auto"`. Overriding a client's forced choice would change behaviour the
  design did not ask to change.
- **Routing hint** (builder's call): `model=<model>`, plus `;tier=<service_tier>` when the merged
  body carries one, as Codex's `build_routing_hint_header` writes it. A value outside printable
  ASCII is left out rather than failing the header write.
- **Authorize URL `originator`**: `codex-tui`. The TUI's login runs in its in-process app-server
  after `initialize` has set the process originator to the client name (`initialize_processor.rs`
  → `set_default_originator`), and `build_authorize_url` reads `originator()`. It reads the
  profile's `OPENAI_ORIGINATOR`, so `OMNI_OPENAI_ORIGINATOR` moves it with the headers. The token
  and usage requests wear the shared profile and so moved with it (new values, `originator`
  after the protocol headers).
- **zstd** (builder's call, corrected after review): `node:zlib`'s `createZstdCompress` at level
  3, the body written to the stream once. Codex uses `zstd::stream::encode_all(…, 3)`
  (`codex-rs/http-client/src/request.rs`), which never pledges a size: no frame content size, not
  single-segment, level 3's own windowLog 21 (window descriptor `0x58`). The first version used
  `Bun.zstdCompressSync`, a one-shot compress that knows the size, writes it, and shrinks the
  window (descriptor `0xa0`/`0x38`) — decodable, but not Codex's frame. A namespace import keeps
  the browser bundle of the package root building (its `node:zlib` has no zstd export); the
  package root now lists `node:zlib` among its bare imports (`oauthStoreEdge.test.ts`). The marker
  is `bodyEncoding: "zstd"` on `CodecHttpRequest`/`HttpRequest`; the codec places
  `content-encoding` itself.
- **`host` header**: the OAuth leg sets `host: chatgpt.com` so it lands in hyper's position.

### Known gaps

Recorded, not fixed.

- **Id timestamps.** The thread, turn and context-window UUIDv7 instants are derived (a past
  window, or a Codex client's own thread instant), not near `turn_started_at_unix_ms`; and
  `turn_started_at_unix_ms` is each request's start, so it changes on every request of a tool loop
  where Codex keeps the turn's original start. Both need per-conversation state this gateway does
  not hold.
- **HTTP/1.1 framing.** Bun's `node:http` adds `Connection: keep-alive` and writes
  `Content-Length` capitalised; hyper writes `content-length` and no `connection` header. The
  transport is shared by every provider, so its casing is left.
- **Transport and TLS.** The gateway speaks HTTP/1.1 over Bun's TLS. Codex uses reqwest 0.12
  (default features include `http2`) over rustls, so it very likely speaks HTTP/2 to
  `chatgpt.com`, and its TLS ClientHello differs from Bun's. **Operator decision, 2026-10-16:**
  this is a known gap, not follow-up work; no transport change.
- **Fixture provenance.** `test/fixtures/codex-0.163.0.json` combines two captures: headers, turn
  metadata and body keys from the TUI's main turn (`codex-tui`), and `followUpInput` from a
  `codex exec` follow-up (`codex_exec`, `turn_trigger: exec`, `sandbox_mode: read-only`), the only
  run driven through a tool loop. Item shapes do not depend on the entry point; the exec-only
  values are not in the fixture.
- **Body order** (builder's call): one `openaiBodyOrder` for both legs, Codex 0.163's declaration
  order with `instructions` kept after `input` and `metadata` last for the API-key leg. The
  API-key leg's key order therefore moves where it has `tools`/`reasoning`; its keys and values
  do not.
- **Harness**: lifted into `scripts/codex-capture/` with paths taken from arguments and
  environment, and the CA steps in its README.

## Testing

- `openaiCodec.test.ts`: exact header names and order against the captured list; turn-metadata key
  order; body key order; lite `input` structure (additional_tools first, base instructions second,
  ids and passthrough on every history item); `content-encoding` header present and the transport
  marker set; API-key leg keeps today's body and header set with only the profile values moved.
- Purity: two `buildRequest` calls with the same input produce identical requests; turn ids group
  by user turn; a tool-loop follow-up shares its turn's id.
- Decode mode: a request without client `include` decodes reasoning as `thinking` even though the
  wire carries `reasoning.encrypted_content`; with client `include` it stays native.
- Vendor bag: client `client_metadata` replaced and the degradation recorded; `text.format` and
  `reasoning.effort` merge per field.
- Reasoning mapping: each IR mode (`omitted`, effort, `off`, `betweenTools`, `budget`) to its sent
  effort.
- `http-client` test: an encoded request is compressed, `content-length` matches the compressed
  bytes, and round-trips through zstd decompression to the original JSON.
- Body capture: an encoded request is captured as the JSON it was before compression.
- `openaiCacheKey.test.ts`: UUID format, determinism per conversation, distinct conversations
  distinct, precedence unchanged, supplied UUID passthrough.
- `profile.test.ts` / `profileEnvOverride.test.ts`: new defaults, overrides still apply.
- Decoder: unchanged; existing tool-call tests must pass untouched.
- Streaming and non-streaming paths both (non-streaming is served by collecting the stream).

## History

**2026-10-16, the outage that started this.** From 01:28 UTC every OpenAI request failed:
the backend began sending `response.metadata` (moderation metadata) before `response.completed`,
the decoder's `KNOWN_EVENTS` allowlist refused it as `UPSTREAM`, and the single credential's
breaker opened, turning the rest into `NO_CANDIDATES`. Codex has listed `response.metadata` as an
ignored event since at least 0.159.2, so this was a backend rollout, not a client release. Fixed
separately by allowlisting the event.

**What 0.159.2 → 0.163.0 changed.** Headers, UA builder and `x-codex-beta-features` are unchanged
in source. `ResponsesApiRequest` lost `instructions` (base instructions now always go into `input`,
lite or not) and reordered its fields (`stream`, `service_tier` moved up). More significant: the
bundled catalog (`codex-rs/models-manager/models.json`) sets `use_responses_lite: true` for every
GPT model the gateway routes to, in **both** releases, so the gateway's shape did not match
0.159.2 either. The capture also showed the TUI's originator is `codex-tui`.

**Live probes**, one `openai-oauth` account, `gpt-6-astra`, 23 requests, all `200`:

| Probe | Result |
|---|---|
| Today's shape, version 0.163.0 | ok, tool call returned |
| Today's shape + lite header | ok |
| Lite: `additional_tools` namespace `functions`, ids + passthrough | ok, call returned with no `namespace` |
| Lite, no ids/passthrough | ok |
| Lite, flat tools in `additional_tools` | ok |
| Lite + zstd body | ok |
| Roundtrip, replayed call with / without `namespace: "functions"` | both ok |
| Roundtrip, fabricated `msg_`/`fc_`/`fco_` ids + passthrough on every item | ok |

Cache, each variant with its own unseen ~9.9k-token prefix, three sends 4s apart, each appending
one exchange: today's shape 0 / 9728 / 9728 cached; lite + zstd 0 / 9728 / 9728. No difference.
Then a third variant with the bulk (~9.7k tokens) moved into the **first history item** and every
history item's `id`, `turn_id` and `create_time` regenerated on each send: 0 / 9728 / 9728. Ids
and passthrough metadata are not part of the cached prompt.

**Forced tool choice in lite mode**, measured 2026-10-16, two more live requests (25 in total),
same account and model: `tool_choice: {type: "function", name}` and `tool_choice: "required"`,
each with the tool only inside the `functions` namespace of `additional_tools`, both answered
`200` with the call returned. No code change: a client's tool choice is encoded as before.

**zstd byte identity**, a one-off verification on 2026-10-16. The four captured Codex 0.163.0
request bodies (TUI title request and main turn, exec first request and follow-up; 13,024 to
25,584 compressed bytes) were decompressed and sent back through `nodeHttpClient` with
`bodyEncoding: "zstd"`; all four came out byte-identical to what Codex sent. The captures carry a
local installation id and paths, so they are not committed; `http-client.test.ts` pins the frame
header (no content size, windowLog 21) and a level-3 golden over a synthetic body instead.

**Large-body zstd**, measured 2026-10-16 to settle a claim. An earlier version of this spec said
`encode_all` feeds zstd in `ZSTD_CStreamInSize` (~128 KiB) chunks, so a large body might differ
in block layout; a review read `encode_all` as one `write_all`. Codex 0.163.0 (`codex exec`,
`gpt-6-astra`) was run once through the local capture harness with a 307 KB prompt on stdin. Its
`/responses` request was 383,101 bytes of JSON, sent as 82,668 zstd bytes. Recompressed through
`nodeHttpClient` (one write), the result was byte-identical. The chunking claim was wrong; the
gap is closed. Segmentation does matter to the bytes — the 406 KB synthetic body in
`http-client.test.ts` compresses to 67,060 bytes in one write and 67,069 in 128 KiB writes — so
the test pins the one-write golden.
