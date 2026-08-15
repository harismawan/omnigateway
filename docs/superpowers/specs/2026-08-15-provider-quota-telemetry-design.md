# Provider Quota Telemetry Design

## Goal

Let an operator see how a provider account's quota has moved over time, how fast it is being
consumed, and whether it will run out before the window resets.

Today the gateway keeps only the newest reading. `quota_windows` is keyed
`(credential_id, window_type)` and `saveQuota` overwrites in place, so every prior observation is
lost the moment the next probe lands. The console can draw a bar and the router can price against
it, but neither can answer "is this draining faster than usual" or "will this last until reset".

This design adds a retained sample series, a burn-rate estimate derived from it, and the surfaces
that render both.

## Scope

In scope: sample persistence, rate and exhaustion estimates, an authenticated history API, an
Accounts-page disclosure, and two CLI surfaces.

Out of scope, deliberately:

- Alerts, webhooks, and notification thresholds. The existing `Meter` tones (green below 70%, amber
  70–90%, red at or above 90% — `apps/dashboard/src/ui/Meter.tsx:30-34`) remain the only escalation.
- Router behaviour. The router keeps scoring from the snapshot via `quotaHeadroom`
  (`packages/router/src/quota.ts:71`). History is read-only telemetry; nothing here changes a
  routing decision.
- Converting gateway token counts into provider quota units. No honest conversion factor exists.
- Backfill. There is no history to recover.
- Providers with no usage surface. `grok` has no `usage` method and its accounts continue to read as
  unknown rather than unlimited.

## Where the numbers come from

Two independent rates, shown together, never combined.

**Provider rate** is the headline. It is derived from the provider's own reported `used` counter and
therefore accounts for every request made against that account, including traffic that never touched
this gateway.

**Gateway rate** is corroboration. It is tokens per hour from `request_logs` for the same credential
over the same span. When the provider rate materially exceeds what the gateway can account for,
something else is spending the account, and that divergence is the point of showing it.

The two use different units — Anthropic and OpenAI report percentages, normalized to
`used: N, limit: 100` by `windowFrom` (`packages/control/src/oauth/usage.ts:146-179`), while Kimi
reports raw string counters. They are presented as two rates, not as one number and a share of it.

## Storage

New migration `007_quota_samples.sql`:

```sql
CREATE TABLE quota_samples (
  credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  window_type   TEXT NOT NULL,
  observed_at   INTEGER NOT NULL,
  used          INTEGER NOT NULL,
  limit_value   INTEGER,
  resets_at     INTEGER,
  window_ms     INTEGER,
  PRIMARY KEY (credential_id, window_type, observed_at)
) WITHOUT ROWID;

CREATE INDEX quota_samples_observed ON quota_samples (observed_at);
```

`WITHOUT ROWID` matches `usage_daily` (`002_usage_daily.sql:14`): the primary key is the whole row's
identity and a separate rowid buys nothing. The index on `observed_at` alone serves pruning, which
sweeps across all credentials at once.

The same migration adds `window_ms INTEGER` to `quota_windows`. See "Window duration" below.

Rows die three ways: credential deletion cascades, retention pruning, and nothing else. There is no
window-set replacement as there is for `quota_windows` — a window the provider stopped reporting
still happened, and its history stays readable until it ages out.

### Sampling policy

Append happens inside `saveQuota` (`packages/store/src/sqlite/credentials.ts:366`), in the
transaction that already writes the snapshot. `saveQuota` is the sole write path for quota data, so
history cannot drift from the snapshot it describes.

A sample is skipped when `(used, limit_value, resets_at, window_ms)` all equal the newest existing
row for that `(credential_id, window_type)`. An idle account therefore writes approximately nothing,
which is what makes the table affordable at the 300s default poll interval.

Including `resets_at` in the comparison is load-bearing. A window that rolls over resets `used`, but
a rollover that happens to land on the same `used` value would otherwise be silently dropped and the
chart would show one continuous window where there were two. `resets_at` moves on every rollover, so
comparing it catches the case.

Where `resets_at` is null — a provider reporting usage with no stated reset — a repeated identical
reading is genuinely indistinguishable from no change, and is correctly skipped.

Dedup makes a gap in the series ambiguous: it means either "the probe did not run" or "nothing
changed". This is resolved by reading `quota_windows.observed_at`, which every probe updates
regardless of whether a sample was written. Liveness lives in the snapshot; shape lives in the
samples.

### Retention

Pruning joins the existing hourly sweep. `pruneLogs` (`apps/gateway/src/maintenance.ts:20-28`)
gains a third delete governed by `settings.logRetentionDays`, the same bound as raw request logs,
and returns `{ raw, daily, quotaSamples }`.

Its debug line gains a count field. `LogFields` (`packages/ir/src/logger.ts:22-51`) is a closed
allowlist and a redaction boundary, so this is a deliberate edit: add
`quotaSampleCount?: number | undefined` and place it in `FIELD_ORDER` next to `dailyCount`. It is a
row count, carries no operator or provider data, and no index signature is introduced.

## Window duration

Providers report when a window *ends*, never when it began. `resets_at` is the only anchor, so the
window start is inferred:

```text
windowStartsAt = resetsAt - durationFor(windowType, windowMs)
```

`durationFor` prefers a provider-reported `windowMs` and falls back to the nominal constant.

`WINDOW_DURATION_MS` currently lives in `packages/router/src/quota.ts:11-15`. It moves to
`@omni/store` alongside `WindowType`, which is a leaf importable by the router, `@omni/control`, and
the dashboard. The router imports it from there. No second copy is created — this repo already
carries the cost of duplicating `quotaStaleAfterMs` across `packages/router/src/quota.ts:33` and
`apps/dashboard/src/lib/vitals.ts:272`, and that duplication is not extended here.

### The OpenAI correction

`windowTypeOf` (`packages/control/src/oauth/openai.ts:160-175`) reads `limit_window_seconds` and
buckets it into one of three names — at or below 6h is `fiveHour`, at or below 36h is `daily`,
otherwise `weekly` — then discards the real duration. A 3-hour OpenAI window stored as `fiveHour`
would place the inferred window start about two hours too early and understate the burn rate by
roughly 40%.

`UsageWindowReport` (`packages/control/src/oauth/types.ts:58-63`) gains
`windowMs: number | null`. OpenAI populates it from the seconds it already parsed. Anthropic and
Kimi report no duration and leave it null, falling back to the nominal constant as before.

The bucketing itself is unchanged: three names are what the store, router, and console are built
around, and this design does not widen that.

## Rate and exhaustion

New pure module `packages/control/src/quota/burn.ts`. Given a snapshot window and its samples:

```text
elapsedMs   = observedAt - windowStartsAt
ratePerHour = used / (elapsedMs / 3_600_000)
exhaustsAt  = observedAt + ((limit - used) / ratePerHour) * 3_600_000
survives    = exhaustsAt === null || exhaustsAt >= resetsAt
```

The rate is a whole-window average rather than a recent slope. It is stable, needs no lookback
parameter, and never swings on a single burst. Its cost is that a burst early in a long window keeps
the estimate pessimistic after activity stops; the UI names the measure so this reads as the
average it is.

### Everything is anchored to `observedAt`, never to `now`

`used` is the provider's count as of `observedAt`. The elapsed span must be measured to the same
instant, and `exhaustsAt` must be projected from it.

Anchoring the denominator to `now` instead would freeze the numerator between probes while the
denominator kept growing, decaying the rate for reasons unrelated to traffic. The dashboard refetches
credential health every 10s (`apps/dashboard/src/api/queries.ts:89`) against a 300s default poll
interval, so roughly thirty of every thirty-one reads would show a number sagging, then snapping back
when the probe landed. A sawtooth that is entirely artifact.

With the reading as the anchor, `windowStartsAt`, `ratePerHour`, and `exhaustsAt` are pure functions
of one sample. They are recomputed on every read because that is simpler than caching them, but the
values change only when a probe writes a new reading. `now` is used for exactly two things: the
staleness check, and rendering — `exhaustsAt` is an absolute instant, so the surfaces display it as a
live countdown that ticks down on its own and is revised only by a new probe.

This also fixes what an operator is owed by an estimate: a prediction that moves should move because
the prediction changed.

`survives` exists because the honest answer is usually "this will not run out before it resets", and
that is what the surfaces should say rather than printing a far-future timestamp that invites
arithmetic.

Each guard below is a real state, reported as unavailable rather than as a number:

- `limit === null` — usage reported with no ceiling. No fraction, no ETA.
- `resetsAt === null` — no window start can be inferred, so no rate. Not zero; unknown.
- `elapsedMs` at or below zero, or `used === 0` — a window that just rolled over has almost no
  elapsed time to divide by. Rate is zero and the surface reads "not burning", never infinity.
- Snapshot older than `quotaStaleAfterMs(pollIntervalMs)` — the estimate is suppressed under the
  same rule the router and console already apply. A rate computed from a reading nobody believes is
  worse than no rate.
- No samples — a fresh install has no history. The bar still renders from the snapshot; the chart
  and rate read as not yet observed.

`gatewayRatePerHour` is computed separately: all four token classes summed —
`input + output + cacheRead + cacheWrite` — from completed `request_logs` for that `credential_id`
between `windowStartsAt` and `observedAt`, divided by the same elapsed hours the provider rate uses.
The two rates are only comparable if they cover the same span, so the gateway rate is anchored to the
reading as well, even though the gateway knows its own logs in real time. All four are counted because a
provider's quota counter is charged for cached reads and writes too, so excluding them would
understate what the gateway accounts for and manufacture a divergence that is not there. Pending
rows are excluded, matching `aggregate` (`packages/store/src/sqlite/usage.ts:309`). It is null when
the window start is unknown.

## API

`GET /api/credentials/quota/history?since=&until=&credentialId=`

Admin session required, matching every other `/api/*` route outside the documented setup and login
flows. `credentialId` is optional; omitting it returns every credential. `since` and `until` are
epoch milliseconds and are clamped to the retention window.

The response carries samples and the derived block per `(credentialId, windowType)`:

```json
{
  "samples": [
    { "credentialId": "…", "windowType": "fiveHour", "observedAt": 0,
      "used": 62, "limit": 100, "resetsAt": 0, "windowMs": null }
  ],
  "burn": [
    { "credentialId": "…", "windowType": "fiveHour",
      "windowStartsAt": 0, "ratePerHour": 12.4, "exhaustsAt": 0,
      "survives": false, "gatewayRatePerHour": 41000 }
  ]
}
```

Derivation is server-side on purpose. The dashboard cannot import `@omni/control` — it is limited to
`@omni/store/types`, `@omni/ir`, and the catalog subpath — so shipping raw samples would force the
estimator to be reimplemented in `lib/vitals.ts` and again in the CLI, and the two would eventually
disagree. One implementation, in `@omni/control`, feeds both.

Backed by a new `quotaHistory(deps, input)` in `@omni/control`, exported beside the existing quota
functions and taking the same shape of dependency object. Input validation reuses the instant
parsing already used by `queryUsage`.

## Dashboard

`AccountsBoard.tsx` renders a nine-column table with one `<Tr>` per credential. Each row gains a
disclosure control in the existing trailing 48px column. The collapsed state is exactly today's row,
unchanged — the `Meter` stack and `quotaLegend` in the Quota cell stay as they are.

Expanding inserts a second `<Tr>` immediately below, with a single `<Td colSpan={9}>` holding, per
reported window:

- A recharts line of `used` as a percentage of `limit` over the selected span. The line uses
  `type="stepAfter"`. Dedup means a flat stretch in the data is a flat stretch in reality;
  interpolating between two stored points would draw a slope that never happened.
- A break at each rollover rather than a line falling to zero. A rollover is detected by
  `resetsAt` changing between adjacent samples, and the segments are drawn as separate series so no
  line connects the end of one window to the start of the next.
- The burn rate, labelled as a window average.
- The exhaustion estimate, phrased against the reset: an ETA when `survives` is false, and a plain
  statement that it lasts the window when true.
- The gateway rate beneath, labelled as what this gateway accounts for.

Windows with no limit, no reset, or a stale snapshot render the corresponding unavailable state
rather than a blank space. A credential whose provider reports nothing keeps today's `unknown`
legend and offers no disclosure.

Range selection is per-window rather than borrowing the Usage page's traffic-shaped
`1h/24h/7d/30d/90d/1y` set: a five-hour window charted over ninety days is noise. The span shown is
the current window plus the preceding one, which is the range in which the estimate means anything.

Expansion state is local to the board and not persisted.

## CLI

`omni status` — `quotaCell` (`apps/cli/src/commands/status.ts:42-57`) already renders
`5h 62% · 7d 18% (3m ago)`. It gains the estimate: `5h 62% ~2h10m` when the window will not survive,
`5h 62% ok` when it will, and the existing age note and red-at-90% colouring are untouched.

`omni quota [--json]` — a new command under the Reports section of `apps/cli/src/help.ts`. Per
credential it lists each window's used and limit, rate, estimate, and reset. `--json` emits the raw
samples and the derived block for scripting. Like every CLI command it goes through `@omni/control`,
never `/api/*`.

## Testing

Store:

- an identical reading writes no sample
- a changed `used` writes one
- an unchanged `used` with a moved `resets_at` writes one — the rollover case
- `window_ms` round-trips, including null
- credential deletion cascades samples away
- pruning deletes past `logRetentionDays` and leaves newer rows
- `saveQuota` remains atomic: a failure writes neither snapshot nor sample

Control:

- rate math against fixed clocks and known samples
- each guard returns unavailable rather than a number: null limit, null `resetsAt`, zero elapsed,
  zero used, stale snapshot, empty history
- `survives` is true when the estimate falls past `resetsAt` and false when it falls short
- the whole burn block is invariant under `now`: holding one sample fixed and advancing `now` across
  several poll intervals leaves `windowStartsAt`, `ratePerHour`, and `exhaustsAt` byte-identical, and
  only the staleness verdict flips. This is the anti-sawtooth anchor and is the first thing to
  mutation-test — swapping `observedAt` for `now` in the denominator must fail it.
- `windowMs` overrides the nominal duration, and its absence falls back
- OpenAI's parser populates `windowMs` from `limit_window_seconds`; Anthropic and Kimi leave it null
- `gatewayRatePerHour` counts only the credential's own logs within the window span

Gateway: the history route requires an admin session, clamps its range, and filters by credential.

Dashboard, under happy-dom with the existing helpers: the row expands and collapses by accessible
name; the chart is step-held; a rollover renders as separate segments; "lasts the window" and an ETA
render in the right conditions; a provider reporting nothing offers no disclosure.

CLI: `omni status` renders both estimate forms; `omni quota` renders and `--json` round-trips.

Per repository guidance, the load-bearing assertions are mutation-tested rather than assumed. At
minimum: break the window-start inference, the dedup comparison, the rollover detection, and the
stale suppression, and confirm a named test fails for each. A green suite is not evidence of
coverage.

## Consequences

`quota_samples` becomes the first table whose row count is driven by provider behaviour rather than
by gateway traffic, but dedup bounds it to actual quota movement: an account that is not being used
writes nothing regardless of how often it is polled.

`LogFields` grows by one numeric member, which is a deliberate crossing of a redaction boundary and
should be reviewed as such.

`WINDOW_DURATION_MS` moving into `@omni/store` means the router imports a constant it used to own.
This is the intended direction — three consumers now need it — and it removes the risk of a second
copy drifting.
