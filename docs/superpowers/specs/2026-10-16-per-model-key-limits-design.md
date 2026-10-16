# Per-Model API Key Limits Design

## Goal

Let an operator give one API key a different ceiling for one model than for everything else: key K
may send 600 requests a minute overall, but only 20 a minute, $5 per five hours, and 2 at once to
`opus`.

Today `api_keys.limits` is a single sparse `(dimension, window)` matrix per key
(`packages/ratelimit/src/catalog.ts`), judged once per request before the body is parsed
(`apps/gateway/src/routes/proxy.ts:512`). Nothing in it knows which model a request names, so the
only way to cap expensive-model traffic is to cap the whole key, or to mint a second key for it.

## Decisions

Settled during brainstorming, each with the alternative it beat:

- **Overrides stack with the key-wide limits; the stricter wins.** A request for a model with an
  override must pass both. Rejected: an override *replacing* the key-wide limits for that model's
  traffic, which would let a key exceed its own key-wide ceiling by spreading load across models.
  Rejected: per-model defaults applying to every key, which reintroduces the inherit-versus-unlimited
  distinction the rate-limiting spec ruled out.
- **The model is the requested model**, after `[1m]` normalization — `chatRequest.model`, the value
  the allowlist checks and `request_logs.requested_model` records. Rejected: the resolved upstream
  model, which is unknown until routing, changes on failover, and has no rollup column to seed long
  windows from.
- **Stored nested in `api_keys.limits`**, as an optional outer member `models`. Rejected: a new
  `api_keys.model_limits` column or an `api_key_model_limits` table. Both fail **open** on rollback
  (an older build ignores the column and silently stops enforcing); nesting fails **closed** (an
  older build's strict parse refuses the key at auth), which is the direction the rate-limiting
  spec chose for unknown limit keys.

## Scope

In scope: the schema extension, per-`(key, model)` counting and enforcement on all three inference
surfaces and `count_tokens`, combined headers and `Retry-After`, model-filtered store sums on both
backends, `limitUsage` readings, and CLI and console editing.

Out of scope, deliberately:

- **Pattern or prefix matching** of model names. Exact match only; a glob is a second rule about
  which override wins, and nothing yet asks for it.
- **Limits by resolved provider or provider model.** See Decisions.
- **Installation-wide or per-virtual-model defaults.** Still per key, still no inheritance.
- **Validating that the model exists or is allowlisted.** Same exemption a dangling pin has: an
  override on a model the key cannot call is harmless, and refusing it would make unrelated edits
  unsavable once a model is renamed.

## The limit model

```json
{
  "requests": { "1m": 600 },
  "concurrency": 8,
  "models": {
    "opus": { "requests": { "1m": 20 }, "spend": { "5h": 5 }, "concurrency": 2 },
    "llama3:8b": { "tokens": { "1w": 2000000 } }
  }
}
```

- An override is the existing strict key-wide shape — every dimension, every window, the same
  value rules — **without** `models`. No nesting.
- Model names: 1–256 characters, matched exactly. At most 64 overrides per key.
- **An empty override is refused at write**: `{}`, or one whose every value is `null`. An override
  is removed by omitting it from `models`; an empty husk would read as a ceiling that is not there.
  `models: {}` is accepted and means no overrides, like an absent key.
- `assertNoProto` already walks nested keys, so a model named `__proto__` is refused with the
  existing message.
- **One lookup**: `modelOverride(limits, model): LimitConfigBase | undefined` in
  `@omni/ratelimit/catalog`, using `Object.hasOwn`. zod's record yields a plain object, so a bare
  `limits.models?.[model]` returns `Object.prototype.constructor` for a model named `constructor`.
  Every consumer — limiter, control readings, console — calls this helper; none indexes `models`
  directly.
- Types: `LimitConfigBase` is the per-scope matrix; `LimitConfig = LimitConfigBase & { models?: … }`.
  The pure evaluator takes `LimitConfigBase`, so it cannot be handed a `models` member it ignores.

### Storage contract

`models` is an outer JSON key of `api_keys.limits`, so it joins the storage contract `DIMENSIONS`
and `WINDOWS` already form. It is **not** a dimension: `DIMENSIONS`, `WINDOWS`, `WINDOW_MS`, and the
`@omnigateway/plugin-api/events` mirror are unchanged, and `limitVocabulary.test.ts` needs no edit.
No migration: the column and its type are unchanged.

**Rollback.** A build without this feature parses a row carrying `models` as an unknown key and
refuses it, so `authenticateApiKey` answers `INTERNAL` for that key — fail closed. `keys.list()`
still lists the key, marked, as it does any unparseable row. Keys without overrides are unaffected.
The README states this beside the existing rollback notes.

## Enforcement

### Admission placement

`admit` moves from before the body parse to after it, and after the model allowlist check:

```ts
admit(keyId: string, limits: LimitConfig, model: string, requestId?: string): Promise<Admission>
```

One admission claims the key-wide subject and, when `modelOverride` returns one, the model subject;
evaluates both; and on any refusal or failure **rolls back both**. Keeping the key-wide admission
early and adding a second one later would leave a request refused by its model ceiling holding a
key-wide `1m` stamp and gauge slot — the "a denied request keeps nothing" rule broken.

Consequences, accepted:

- A malformed body or a disallowed model from a key over its limit now answers 400 / `AUTH` rather
  than 429. Both are more specific.
- An over-limit key's body is parsed before it is refused. Body size is already bounded.

`count_tokens` likewise moves `consume` after its allowlist check (`proxy.ts:929`). An override's
`requests` applies there; `tokens`, `spend`, and `concurrency` do not, exactly as key-wide.

A model without an override costs nothing beyond today: one `hasOwn`, no extra claim, read, or slot.

### Counter subjects

A subject is what the ring, gauge, and buckets are keyed by. Key-wide stays `keyId`. A model
override's subject is `` `${keyId}/m/${encodeURIComponent(model)}` `` — `encodeURIComponent` removes
`/` and `:` from the model part, so no model name can produce another subject's key, and the
existing `lim:<subject>:<window>` bucket names stay unambiguous.

The existing per-subject machinery runs unchanged for each: synchronous claim before any `await`
(the `Coord` visibility invariant holds per call, so claiming two subjects in sequence is as safe as
claiming one), rollback, named gauge slot with a limiter-owned uuid, third-of-TTL renewal capped at
`MAX_RENEWED_MS`, and seed-under-lock. An admission may hold two gauge slots; its `release` frees
both and stops both renewals, idempotently; its `renew` renews both.

### Long windows and the store

`usage.sumSince`, `usage.sumBuckets`, and `usage.oldestSince` gain an optional trailing
`requestedModel?: string`. When present:

- hour grain filters `usage_rollup.requested_model`;
- finer grain filters `request_logs.requested_model` within the one key's rows
  (`idx_request_logs_key_at` still bounds the scan);
- pending rows stay excluded.

Both `sqlite/` and `postgres/` implement it; the sqlite swap forwarder forwards the new argument
(TypeScript permits the lower arity, so `swap.test.ts` must cover it); contract tests run against
both.

`UsageDebit` becomes `(keyId, requestedModel, usage) => void`. `finishLog` already knows the
requested model; the limiter debits the key-wide subject and, when the model has an override, the
model subject. The limiter's `limits` map, which tells `debit` whether a long window is configured,
records per subject.

### Decisions, headers, and Retry-After

New pure `combine(key: Decision, model: Decision): Decision` in `@omni/ratelimit`:

- `violation` is `lastToClear` over both violations — the one that clears last, so `Retry-After`
  never sends a client back while the other scope still refuses it;
- per dimension, `headroom` is the entry nearer exhaustion by `used / limit`, the same rule
  `evaluate` uses across windows.

Headers keep each vendor's dialect and report the scope that will deny first. On the refusal path,
`exactReset` queries `oldestSince` for the **violated** subject, passing the model when the override
tripped. `RateLimitExceeded` is unchanged.

### Logs, metrics, failure

- `"rate limit rejected"` adds the existing `model` `LogFields` key (already length-capped). No new
  field.
- `onRejected` and `/metrics` gain no model label: model names are operator- and client-chosen, and
  a label per name is unbounded cardinality.
- Store failure behaves as today, per subject: long windows stop enforcing and are logged; `1m` and
  `concurrency` keep enforcing exactly.

## Surfaces

### Control and admin API

No new route. `setKeyLimits` / `PUT /api/keys/:id/limits` and minting accept the extended schema,
written whole. `LimitReading` gains `model: string | null` (null for key-wide); `readLimitUsage`
emits a reading per configured override slot through the model-filtered `sumSince`.
`concurrency.used` stays `null`.

`/api/client/summary` carries the key's own overrides in `limitUsage`. They are the holder's own
limits and name no credential; `clientSurface.test.ts` asserts the field and that nothing else is
added.

### CLI

On `omni keys create` and `omni keys limits`:

- `--model-limit <model>:<dimension>:<window>=<n>` or `<model>:concurrency=<n>`
- `--unset-model-limit <model>:<dimension>[:<window>]`; removing an override's last slot removes the
  override.

Parsed **anchored on the right** against the closed dimension/window vocabulary, so `llama3:8b`,
`openai/gpt-4o`, and `claude-opus-4@20250514` all parse as model names. `__proto__` refused as for
`--limit`.

### Console

`EditLimitsDialog` gains a "Per-model overrides" section: one row per override, model chosen with
`ModelPicker` (free text allowed), slots edited with the existing `LimitFields` / `LimitMatrix`,
add and remove controls. A row whose model the key's allowlist excludes shows a hint, not an error.
`KeysBoard` and `ClientBoard` group readings under a model heading; `nearestExhaustion` keeps its
rule and names the model when an override is nearest. Mirror wire shapes in `api/types.ts`. No new
colours.

## Testing

Narrowest boundary first; every new seam mutation-checked (guard order, second-subject inputs, loop
scope).

- **`packages/ratelimit`**: schema accept/refuse — nested `models`, empty override, all-null
  override, `__proto__`, 65 overrides, 257-char name; `modelOverride` for `constructor` and
  `toString`; `combine` — last-to-clear across scopes, tighter headroom per dimension, key-wide-only
  and model-only violations.
- **Store contract, both backends**: model-filtered `sumSince` / `sumBuckets` at minute and hour
  grain, `oldestSince`, pending rows excluded, another model's rows excluded; `swap.test.ts`
  forwards `requestedModel`.
- **`apps/gateway/test/auth/rateLimit.test.ts`**: 10 parallel requests against a model ceiling of
  3 admit exactly 3; a model refusal rolls back the key-wide stamp and slot; key-wide refusal rolls
  back the model claim; both gauge slots released and renewed; no extra claim for a model without an
  override; per-subject seed and debit; `exactReset` reads the violated subject.
- **`apps/gateway/test/routes/rateLimit.test.ts`** and header tests: streaming and non-streaming on
  Anthropic and OpenAI surfaces; headers from the tighter scope; `count_tokens` charged `requests`
  only; a row with `models` refused by a parser without the member (fail-closed pin, using the
  previous schema shape).
- **Dashboard**: dialog edit-and-save round trip, readings grouped by model, allowlist hint.
- **CLI**: right-anchored parse including `llama3:8b`; unset removing a whole override; `__proto__`
  refusal.

## Documentation

- `ARCHITECTURE.md#rate-limiting`: a paragraph on override subjects and single admission.
- `README.md`: operator syntax and the rollback note.
- `CLAUDE.md`: one line beside the limit invariants — `modelOverride` is the single lookup;
  admission claims both subjects and rolls back both.
