# Codex 0.163.0 fingerprint for the OpenAI OAuth leg

Status: draft, 2026-10-16.

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
  `use_responses_lite: true` (all current GPT targets; see History).
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
  it), with the release they were read from noted. Current GPT models all read lite / `low` / `low` /
  `low`. A model id not in that data uses the lite shape and the same defaults: every GPT model in
  the catalog is lite, and a non-lite 0.163 request was never captured. My call.
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
