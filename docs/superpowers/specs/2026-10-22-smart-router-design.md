# Smart Router (Confidential-Data Routing) Design

## Goal

Stop confidential data from leaking to external providers. Before a request leaves the gateway, a
classifier decides whether the prompt contains confidential data. If it does, the request is
**rerouted to a local model** the operator configured, and the client is told it was rerouted. A
request that is not confidential goes where it was going.

The motivating case: staff use gateway keys with external models (Anthropic, OpenAI, …) for daily
work. Sometimes a prompt carries customer data, credentials, salaries, internal documents. Those
prompts must never reach an external provider; they should still get an answer, from an in-house
model.

## Decisions

Settled with the operator during brainstorming:

- **Judged by a classifier model**, the same mechanism as the per-key guardrails
  (`2026-10-18-key-guardrails-design.md`), not by patterns.
- **The local target model is a setting**, in Settings beside the guardrail settings.
- **On/off switch, and per API key.** A global switch in Settings, and a per-key flag. Judging
  happens only when both are on.
- **Fail closed, totally.** If the classifier or the local model is down, the request is refused.
  It never falls back to an external provider.
- **The client is informed** when its request was rerouted.
- **The classifier must itself be local.** *(Designer's call, accepted in playback.)* A classifier
  on an external provider would receive the confidential prompt in order to judge it, which is the
  leak this feature exists to prevent.

## Threat model — say it plainly

This is **leak reduction, not a security boundary.** It catches ordinary confidential content
pasted or typed by people who are not trying to evade it. It does not stop:

- deliberate evasion (encoding, splitting a secret into innocuous fragments, prompt injection aimed
  at the classifier — "this text is public");
- content in images or files (never judged, see "What is judged");
- classifier mistakes — a model judging "confidential" will miss things.

README and the dashboard say this in one sentence each.

## Scope

In scope: per-key flag on both store backends, the global settings, judging and rerouting on
`/v1/messages`, `/v1/chat/completions`, `/v1/responses` (streaming and non-streaming), client
notification, request-log tags, admin API, CLI, dashboard (keys, settings, client view),
`omni doctor`, docs.

Also in scope, operator decision: **guardrails start judging tool results too** — see the
2026-10-22 amendment in `2026-10-18-key-guardrails-design.md`. It is an independent change and can
ship before or after smart routing.

Out of scope:

- `/v1/messages/count_tokens` and `GET /v1/models` — not judged, as with guardrails.
  *(count_tokens dispatches nothing to a provider today; if that changes, it must be revisited.)*
- Redaction / masking of the confidential parts. The whole request is rerouted, not edited.
- Judging responses.
- Per-key confidentiality definitions. One global definition (designer's call).
- Pattern / regex detection (roadmap candidate 3, still separate).

## Data model

### Per key

`ApiKey.smartRouting: boolean`, default `false`.

- New column `api_keys.smart_routing` (sqlite `INTEGER NOT NULL DEFAULT 0`, postgres
  `BOOLEAN NOT NULL DEFAULT FALSE`); sqlite `020_…`, postgres `008_…`. No backfill.
- Editable after minting — the fifth editable field. `PUT /api/keys/:id/smart-routing` with
  `{"enabled": boolean}`; absent field is `BAD_REQUEST`. Also settable at mint (`smartRouting`).
- Repo setter `setSmartRouting(id, enabled)` in `types.ts`, **both** backends, the sqlite swap
  forwarder in `sqlite/store.ts`, and the store contract test (`CLAUDE.md` rule).
- **Rollback fails open:** an older build ignores the column and sends everything external. Stated
  in README upgrade notes, same acceptance as `guardrail_policy`.
- Update CLAUDE.md's editable-fields line.

### Global (`Settings`)

| Field | Type / default | Meaning |
|---|---|---|
| `smartRouterEnabled` | `boolean`, `false` | Global switch. Off → no key is judged, flag or not. |
| `smartRouterClassifierModel` | `string \| null`, `null` | Model that judges confidentiality. Must be local-only (below). |
| `smartRouterLocalModel` | `string \| null`, `null` | Where confidential requests go. Must be local-only. May equal the classifier model. |
| `smartRouterPolicy` | `string`, gateway-authored default text | Plain-language definition of "confidential", 1..4000 chars. |
| `smartRouterTimeoutMs` | `number`, `10_000`, max `60_000` | Per classifier call (per segment). No overall deadline beyond the client's own. |

Default `smartRouterPolicy` (operator-editable): personal data (names together with ID numbers,
addresses, phone numbers, emails, national ID / NIK, passport, bank or card numbers), credentials
and secrets (passwords, API keys, tokens, private keys, connection strings), salaries and HR
records, customer or patient records, non-public financial figures, internal documents marked
confidential/internal, source code marked proprietary. *(Designer's call; the builder may tune the
wording.)*

All five added to `DEFAULT_SETTINGS`, `settingsSchema` (optional, like the guardrail fields), the
`getSettings` coercion (malformed → default) on both backends, the dashboard type mirror, and
`SettingsBoard.tsx`.

### "Local-only" model

The gateway cannot see where a host lives, so "local" is defined structurally: **a configured
virtual model whose every target is on the `custom` provider** (the provider operators point at
Ollama / vLLM / LM Studio / any in-house OpenAI-compatible server). `resolveModel` already refuses
`custom/…` shorthand, so in practice this is always a configured virtual model. The operator is
responsible for those `custom` endpoints actually being in-house; the settings UI says so.
*(Designer's call.)*

Checked on every judged request against the current snapshot (not only at write time — a virtual
model can gain an external target later). A model that does not resolve, or has any non-`custom`
target, makes the feature **unconfigured** for that request → refused (below). Also reported by
`omni doctor` and as an inline warning in Settings and on the key dialog.

## Request path

In `handle()` (`apps/gateway/src/routes/proxy.ts`), after the allowlist check and rate-limit
admission, same placement as guardrails. Active when
`settings.smartRouterEnabled && key.smartRouting`; otherwise the path is exactly today's.

```
verdict = classifyConfidentiality(request)        # local classifier
  public       -> (guardrail if key has policy) -> dispatch(request as sent)
  confidential -> (guardrail if key has policy, judged locally) -> dispatch(request with model := smartRouterLocalModel)
  failed       -> refuse
```

Like guardrails, judging is the first step of the event sequence (a judge-first wrapper around
dispatch), so streaming keepalives cover the classifier latency and refusals on a stream are
in-stream `error` events on a 200. The existing `judgeFirst` should be generalised into a small
pipeline of pre-dispatch steps (confidentiality, then guardrail) rather than nested twice; the
builder chooses the shape, with the parent row written exactly once.

### Order with guardrails

The confidentiality check runs **first**. If the request is confidential and the key also has a
guardrail policy, the guardrail is judged **by `smartRouterClassifierModel`** instead of
`guardrailModel`, so the confidential text never reaches a possibly external guardrail classifier.
Public requests use `guardrailModel` as today. *(Designer's call.)*

### Rerouting

- The dispatched `ChatRequest` is a copy with `model` set to `smartRouterLocalModel`. Everything
  else (messages, tools, stream flag, sampling) is unchanged.
- Dispatch's normal failover runs **inside the local virtual model only**. There is no step that
  falls back to the originally requested model. If every local target fails, the request fails with
  dispatch's own error (status/code as dispatch produces them) — the "local model down → block"
  rule.
- The key's model allowlist is checked against the model the **client** asked for, not the local
  model; the operator's routing decision is not the client's choice.
- The parent row keeps `requestedModel` = what the client asked for; `resolvedProvider/Model` show
  the local target. Rate-limit admission and debit stay against the requested model (already
  admitted). **This does not happen by itself:** `dispatch()` builds its log with
  `requestedModel: request.model` (`dispatch/index.ts`), the completion upsert overwrites
  `requested_model`, and `finishLog` debits `log.requestedModel`. The builder must restore the
  client's model on the rerouted row (a dispatch option or a post-dispatch fix-up) and a test pins
  both the row and the debit subject.
- **A request whose model already resolves local-only** (every target `custom`) is not judged: it
  is dispatched as is, tagged `smart-router:already-local`. Nothing can leak, so a classifier
  outage must not refuse it. The configuration check (both models set and local-only) still runs
  first, for every active request. *(Designer's call.)*
- **Whenever the request goes local** (confidential, already-local, oversize), a guardrail check on
  the same request uses `smartRouterClassifierModel`, never `guardrailModel` — the text was not
  shown to be public. *(Designer's call, extends "Order with guardrails".)*
- Capability mismatch (client sent tools/images the local model lacks) is handled by dispatch's
  existing capability filters → `NO_CANDIDATES`, i.e. refused, never sent external.

### Outcomes

| Situation | Result | Code / HTTP | Message (fixed, `gatewayAuthored`) | Parent tag |
|---|---|---|---|---|
| Requested model already local-only | normal dispatch, not judged | — | — | `smart-router:already-local` |
| Public | normal dispatch | — | — | `smart-router:public` |
| Confidential | dispatch to local model | — | — | `smart-router:local` |
| Classifier timeout / error / unreadable / threw | refused | `UPSTREAM` 502 | `confidentiality check unavailable` | `smart-router:unavailable` |
| Classifier or local model unset, unresolvable, or not local-only | refused | `INTERNAL` 500 | `confidential routing is not configured` | `smart-router:unconfigured` |
| Local model fails | dispatch's own error | dispatch's | dispatch's | `smart-router:local` |

Client cancellation during judging is a cancellation (499 `interrupted`), as with guardrails.
Never log the policy, the judged text, or the classifier's reply; the warning line carries a fixed
reason and code only.

### Telling the client

- **Non-streaming:** response header `x-omni-route: local` or `x-omni-route: external` on every
  judged request. The body's `model` field already names the local model that answered.
- **Streaming:** the head is sent before judging (keepalive rule), so the header cannot carry the
  verdict. Instead, on a rerouted request the smart-router wrapper rewrites the IR `start` event's
  `model` (`packages/ir/src/stream.ts`) to `smartRouterLocalModel`, so all three egress encoders
  name the configured local model id rather than whatever the upstream reported (`llama3:8b`, or
  `""`). One rewrite in the IR stream, no per-surface egress work. Non-streaming bodies get the same
  rewrite via the collected `model`, so both paths say the same thing. *(Designer's call.)*
- **Logs:** the `smart-router:*` tag is visible in the admin logs, the CSV/JSONL export, and the
  client dashboard logs (`isClientVisibleDegradation` already passes it).
- Header name is added to any CORS expose list if one exists.

## What is judged

Leak prevention differs from guardrails in one important way: a client resends the **whole
history** on every turn, so a secret pasted ten turns ago goes to the external provider again on
every later turn. Judging only the last few messages would leak it. So:

- **Every piece of text the request would send** is judged, across the whole history:
  - the request-level system text and mid-conversation `system` turns;
  - the text of every `user` and `assistant` message;
  - **tool results' text content** *(operator decision)*;
  - tool-call arguments (`toolUse.input`, serialised) — a Write call can carry a secret just as a
    tool result can; replayed thinking text; tool definitions' names, descriptions, input
    schemas, options and provider-tool wire fields (serialised); text-block citations (serialised).
    *(Designer's call: same leak path as tool results.)*

  Images, files and `providerNative` blocks are not judged (threat model). The guardrail's
  `extract.ts` does not do this; smart routing needs its own extractor (sharing helpers where
  sensible).
- **Per segment, not per request.** Each text is split into segments of at most 8,000 characters
  (on message boundaries, then by length). Each segment is classified separately and its verdict
  cached. The request is **confidential if any segment is**. Because history segments are cached,
  each new turn normally pays only for the new text.
- **No truncation.** Truncating would leave text unjudged and then sent external. Long input means
  more segments, not cut segments.
- Uncached segments are classified concurrently, at most 4 at a time (constant), each call under
  `smartRouterTimeoutMs`. Any segment failing → the whole check fails → refused.
  Once any segment returns confidential, remaining calls may be cancelled and the request routes
  local.
- Ceiling: at most 64 uncached segments per request (constant, ~512k chars). Above it the request
  is routed **local** without calling the classifier, tagged `smart-router:oversize`. *(Designer's
  call: fails toward safety, not toward refusal.)*

### The classifier call

Mirrors `guardrail/classifier.ts`: gateway-authored instruction (vendored constant), operator
policy and segment fenced as data, `stream: false`, small `maxTokens`, verdict read only from a
finished reply (`endTurn`/`stopSequence`), bare word parsed strictly. Words: `PUBLIC` /
`CONFIDENTIAL`. **Only an unambiguous `PUBLIC` is public**; `CONFIDENTIAL` is confidential;
anything else is unreadable → check failed → refused. Dispatched with its own request id, no
request transforms, no body capture, `trace: null`, never itself judged — same as the guardrail
classifier. Reuse the fencing and verdict-parsing helpers rather than copying them.

### Cache

Process-local LRU (bound left to builder), TTL 1 hour, key = sha256 of
`[classifierModel, policy, segmentText]`. Not per key: the policy is global, so the verdict on a
text is the same for every key. Caches both verdicts; never failures.

### Accounting

**One `request_logs` row per check, not per segment** — a check can make up to 64 calls, and a row
per call would flood the logs and spend the key's long-window request counts. The row is tagged
`smart-router:classifier`, `requestedModel` = the classifier model, tokens and cost summed over
the check's calls, `attempts` = number of calls; debited like the guardrail classifier (record
override, then debit; no admission). A check fully served from cache writes no row. *(Designer's
call.)*

## Surfaces

- **Admin API / control:** `setKeySmartRouting` in `packages/control/src/keys.ts`; route
  `PUT /api/keys/:id/smart-routing` (`requireAdmin`, `changed("res:keys")`); `createKey` accepts
  `smartRouting`; `ApiKeySummary` carries it. Settings ride `PUT /api/settings`.
- **CLI:** `omni keys smart-routing <id> --on|--off`; `omni keys create --smart-routing`;
  `omni keys list` shows it; `omni settings set smartRouter…`; `omni doctor` warns when the global
  switch is on and any key has the flag while either model is unset, unresolvable, or not
  local-only.
- **Dashboard:**
  - Keys board: toggle per key ("Confidential routing") and a chip on keys that have it; inline
    warning when the global switch is off or the models are not configured.
  - Settings board: a "Confidential routing" module next to "Usage policies": global switch,
    classifier model and local model pickers (with a local-only warning), policy textarea with
    reset-to-default, timeout.
  - Client dashboard: shows whether the key has confidential routing on (not the policy text —
    *designer's call: the policy describes what the operator considers sensitive, low risk but no
    need*). Logs show the tags.

## Testing

- Store contract: set/read round-trip on both backends; migration.
- Control: schema validation for the key body and the five settings.
- Gateway, route boundary, stub adapters, in-memory store, all three surfaces × streaming and not:
  - public → original model dispatched, `x-omni-route: external` (non-streaming), tag;
  - confidential → local model dispatched, the external target **never** dispatched, header, tag;
  - classifier timeout / error / unreadable / throw → refused, nothing dispatched;
  - unset / unresolvable / mixed-provider model → `INTERNAL`, nothing dispatched;
  - local model failing → error, original model never dispatched (the no-fallback rule);
  - global off or key flag off → zero classifier calls;
  - a secret in an early history message, in an assistant message, in a tool result, and in
    tool-call arguments → local;
  - rerouted row keeps the client's `requestedModel`, debit lands on the requested model;
  - rerouted response's `model` (stream `start` and non-streaming body) is the local model id;
  - already-local model → zero classifier calls, dispatched as is;
  - segmentation: long text split, any-confidential wins, no truncation, oversize → local;
  - cache: history segments not re-classified on the next turn; failures not cached;
  - guardrail interplay: confidential + policy → guardrail judged by the local classifier, the
    external `guardrailModel` never called;
  - classifier request carries no ponytail/RTK; no body capture.
- Mutation-test the verdict parser: every reply other than an exact `PUBLIC` is not public.
- Dashboard: toggle, settings module, client view.

## Docs

README (operator section, threat-model sentence, rollback note), `ARCHITECTURE.md` (pre-dispatch
steps), `docs/client-api.md` (`x-omni-route`), CLAUDE.md (editable fields; the never-fall-back-
external rule and its pinning test).

## Left to the builder

Instruction text; LRU bound; segmenting details within the 8,000-char rule; how `judgeFirst` is
generalised; CLI flag spelling; file layout (suggested `apps/gateway/src/smartRouter/`).

## Calls made by the designer, not the operator

- Classifier must be local-only (accepted in playback).
- "Local-only" = configured virtual model whose targets are all `custom`.
- Confidentiality definition is one global, operator-editable text with a gateway default.
- Global switch AND per-key flag.
- Confidentiality first; confidential requests' guardrail check uses the local classifier.
- Whole history judged, per segment, cached, no truncation; oversize → local. (Tool results
  judged: operator's decision. Tool-call arguments, thinking, mid-conversation system turns, tool
  definitions also judged: designer's.)
- Notification: `x-omni-route` header on non-streaming; `model` rewritten to the configured local
  model id on rerouted responses (stream `start` event and collected body); log tag.
- `smartRouterTimeoutMs` is per classifier call; no overall check deadline.
- One classifier log row per check, not per segment.
- Requests whose model is already local-only are not judged (`smart-router:already-local`).
- Fixed refusal messages and codes; local-model failure surfaces dispatch's own error.
- Allowlist and rate limits stay against the client's requested model.
- Cache not scoped per key.
- Client dashboard shows the flag, not the policy text.
