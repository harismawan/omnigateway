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
  The limiter and the control readings call this helper; none indexes `models` directly. The
  console cannot import it — boundary rule 12 keeps `@omni/ratelimit` out of the browser, and its
  catalog would bring zod with it — and needs no lookup by name: it walks the stored overrides as
  own entries and groups readings by their `model` field.
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
(the `Coord` visibility invariant holds per call, so claiming two subjects in sequence never lets a
burst admit past either ceiling), rollback, named gauge slot with a limiter-owned uuid, third-of-TTL
renewal capped at `MAX_RENEWED_MS`, and seed-under-lock.

**A claim is provisional, and a provisional claim is visible.** The key-wide claim of a request that
its model ceiling will refuse counts against every concurrent request for the key until that refusal
rolls it back, so a request for *another* model can be refused in that interval by a claim that is
about to vanish. Measured: key `concurrency: 2`, `opus` override `concurrency: 1`, three requests
`[opus, opus, fast]` started together answered `[ok, 429, 429]` with one request in flight — the
second `opus`'s key-wide slot, held until its model refusal unwound, refused `fast`. This is the
over-counting direction the limiter already permits within one subject (a refused claim is visible to
its siblings there too), never an admission past a ceiling, and it lasts one evaluation. Accepted:
removing it would need judging the model before claiming the key-wide subject, which reopens the
burst the synchronous claim closes. An admission may hold two gauge slots; its `release` frees
both and stops both renewals, idempotently; its `renew` renews both.

### Long windows and the store

`usage.sumSince`, `usage.sumBuckets`, and `usage.oldestSince` gain an optional trailing
`requestedModel?: string`. When present:

- every grain, the hour included, reads `request_logs` — `usage_rollup` has no model column, and
  adding one changes its primary key, which an older build's `ON CONFLICT (api_key_id, hour)`
  upsert cannot survive on rollback;
- the read seeks `idx_request_logs_key_model_at` `(api_key_id, requested_model, at)` (SQLite
  migration 18, Postgres 6), so it is bounded by that model's own rows inside the window — no
  longer by the key's, but still linear in the model's traffic, unlike the flat rollup read the
  key-wide subject gets;
- the hour grain floors `since` to its bucket, as the rollup read does;
- pending rows stay excluded.

That remaining cost is paid by the limiter's seed — on the request path, for the first request
after a restart or once a subject's buckets lapse — and by `readLimitUsage`, once per configured
window of every override (`1m` included) on every `/api/keys` and `/api/client/summary` fetch.
Measured at 500,000 rows in one key's week: a model with a hundred rows reads in 0.03ms; a model
carrying a fifth of the key's traffic still reads 38ms (`sumSince 1w`) and 59ms (`sumBuckets` hour)
on SQLite. A covering index cut the heavy case to 9ms and was rejected — nearly three times the
width on every completed request, and it moved the key-wide edge read onto a skip-scan.

Both `sqlite/` and `postgres/` implement it; the sqlite swap forwarder forwards the new argument
(TypeScript permits the lower arity, so `swap.test.ts` must cover it); contract tests run against
both.

`UsageDebit` becomes `(keyId, requestedModel, usage) => void`. `finishLog` already knows the
requested model; the limiter debits the key-wide subject and, when the model has an override, the
model subject. The limiter's `limits` map, which tells `debit` whether a long window is configured,
records per subject.

### Decisions, headers, and Retry-After

New pure `combine(key: Decision, model: Decision): Decision` in `@omni/ratelimit`:

- `violation` is `lastToClear` over both scopes' violations — the one that clears last, so
  `Retry-After` never sends a client back while the other scope still refuses it. A `Decision`
  carries every violation it found (`violations`), not only the one reported, so `combine` joins
  the lists;
- per dimension, `headroom` is the entry nearer exhaustion by `used / limit`, the same rule
  `evaluate` uses across windows.

Headers keep each vendor's dialect and report the scope that will deny first. On the refusal path
the limiter corrects **every** violated long window first — `oldestSince` per violated window, asked
of that subject's own rows, passing the model for an override — and only then chooses last-to-clear
over the corrected resets. The corrected instant moves into that subject's headroom before the
scopes are combined, and the refused dimension's header is then the violated entry itself — not
whichever entry headroom-by-proportion picked — so the headers name the same instant as the
`Retry-After`.
`RateLimitExceeded` is unchanged.

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

- `--model-limit <model>:<dimension>:<window>=<n>` or `<model>:concurrency=<n>`, on both
  `omni keys create` and `omni keys limits`;
- `--unset-model-limit <model>:<dimension>:<window>` or `<model>:concurrency`, on `omni keys limits`
  only — on create there is nothing to unset; removing an override's last slot removes the override.

Parsed **anchored on the right** — the value after the last `=`, the window (or the bare gauge)
after the last `:`, the dimension before it — so `llama3:8b`, `openai/gpt-4o`,
`claude-opus-4@20250514` and `tier=gold` all parse as model names. `__proto__` refused as for
`--limit`, and `--limit` refuses `models`.

### Console

`EditLimitsDialog` gains a "Per-model overrides" section: one row per override, the model typed into
a text input offered the configured models through a `<datalist>` (free text allowed —
`ModelPicker` is a multi-select checkbox list and can pick neither one model nor an unlisted one),
slots edited with the existing `LimitFields`, add and remove controls. Model names are never
trimmed: a name typed with surrounding spaces is refused, a stored one goes back unchanged. A row whose model the key's allowlist excludes shows a hint, not an error.
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

## History

Implemented on `feat/per-model-key-limits`. Where the code departs from the first draft of this
spec, and what review found after it:

- **No `usage_rollup.requested_model`.** The draft assumed the rollup carried the model; it does
  not, and adding it changes the rollup's primary key. Narrowed reads come from `request_logs`.
  Review measured the first implementation, which filtered the model per row off
  `idx_request_logs_key_at`, at 58ms (`sumSince 1w`) and 108ms (`sumBuckets` hour) at 500,000 rows,
  repeated per override and window on every key listing. Fixed with an index only,
  `idx_request_logs_key_model_at`; the remaining linear-in-model-traffic cost is stated above. A
  store comment that called the narrowed read "off the request path" was wrong — the seed is on it,
  and the readings use it at `1m` too.
- **`Retry-After` across scopes.** The first implementation corrected only the violation `combine`
  had chosen on overstated long-window resets. Review's probe: key-wide `requests 1m: 1` filled by
  another model, `opus` override `5h: 1` whose oldest row aged out in 5s — the client was told 4s
  while the key-wide minute refused for 59s more. Decisions now carry every violation, each is
  corrected first, and last-to-clear is chosen over the corrected figures. The same fix covers two
  long windows of one scope.
- **Provisional claims** were described as "as safe as claiming one"; review's probe showed the
  cross-model over-refusal recorded under *Counter subjects*. Documented, not changed.
- **Console** cannot import `modelOverride` (rule 12) and uses a text input with a datalist rather
  than `ModelPicker`; it stopped trimming model names after review found the trim renamed overrides
  silently. Its copies of the 64-override and 256-character bounds are pinned by
  `apps/gateway/test/routes/modelOverrideBoundsMirror.test.ts`.
- **CLI** `--unset-model-limit` is on `keys limits` only. Review's surviving mutants — a `=` in a
  model name, and a plain object where the overrides map must be null-prototype (`constructor`) —
  are now pinned.
- **Fail-closed rollback pin** first parsed against the current base schema, which proves nothing
  about an older build; it now parses against a frozen copy of the schema `main` shipped.
- **Other pins review asked for**: `count_tokens` consuming after the allowlist, an override whose
  ceiling sits in a later dimension than an all-null one, and the `model` field on both limiter
  store-fault warnings.

Re-review of the fixes above found three more:

- **Headers could still disagree with `Retry-After`.** Headroom is chosen per dimension by
  proportion, the violation by latest reset; two full entries tie. Probe: key-wide `requests 1m: 1`
  filled by another model, `opus` override `requests 5h: 2` with its oldest row 2h old —
  `Retry-After` 10,799s, but the `requests` header named the key-wide minute (59s). Reachable inside
  one scope on the original path too (a full minute ties a full week). On refusal the refused
  dimension now reports the violated entry.
- **Plan tests EXPLAINed copies of the SQL**, so `+requested_model = ?` (SQLite) and
  `(requested_model || '') = $4` (Postgres) kept results, lost the seek, and passed. The narrowed
  statements are exported as `NARROWED_SQL` and the plan tests EXPLAIN those strings.
- **One reset read per subject and window** on a refusal was unpinned; now pinned.
