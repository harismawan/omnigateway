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

In scope: sample persistence, rate and exhaustion estimates, an authenticated history API, the
estimate on the Overview rack, a history disclosure on the Accounts page, and two CLI surfaces.

The estimate and the history are separable and are deliberately separated. The estimate derives from
a single snapshot reading and goes everywhere quota is already shown. The history needs the new table
and appears in one place, behind a disclosure, because a chart per account is not what an
at-a-glance surface is for.

Out of scope, deliberately:

- Alerts, webhooks, and notification thresholds. The existing `Meter` tones (green below 70%, amber
  70–90%, red at or above 90% — `apps/dashboard/src/ui/Meter.tsx:30-34`) remain the only escalation.
- Retained history as a routing input. The router still scores from the snapshot alone via
  `quotaHeadroom` (`packages/router/src/quota.ts:71`) and reads no samples, no trend, and no burn
  rate. `quota_samples` stays read-only telemetry. The one routing change this design does make is
  the window *length* the snapshot is measured against — see "The router measures the same window
  the estimate does" below — which is a correction to an existing calculation, not a new input.
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

A sample is skipped when `used`, `limit_value` and `window_ms` equal the newest existing row for that
`(credential_id, window_type)` and `resets_at` names the same window. An idle account therefore
writes approximately nothing, which is what makes the table affordable at the 300s default poll
interval.

Including `resets_at` in the comparison is load-bearing. A window that rolls over resets `used`, but
a rollover that happens to land on the same `used` value would otherwise be silently dropped and the
chart would show one continuous window where there were two. `resets_at` moves on every rollover, so
comparing it catches the case.

`limit_value` is load-bearing for the mirror reason: a plan change can lift the ceiling while `used`
sits still, and without it in the comparison every percentage drawn afterwards stays on the old
denominator until traffic happens to move `used`.

**`resets_at` also moves when nothing happened, and it must not be compared exactly.** Not every
provider states an instant. Codex states a whole-second countdown, so `resetAtOf`
(`packages/control/src/oauth/usage.ts:100-105`) derives the absolute reset as `now + seconds * 1000`
from a clock that advanced a poll interval since the last probe. The result lands a few hundred
milliseconds off its predecessor on every single poll while the window stands perfectly still.
Compared exactly, dedup never fires for OpenAI — a row per poll per window per credential, roughly
288 a day for an account doing nothing — and the chart splits a segment per sample, which
`stepAfter` with `dot={false}` renders as a blank panel with the "not yet observed" fallback
suppressed.

The comparison is therefore `sameWindow(a, b)` in `@omni/store/types`, true when both are null or
within `SAME_WINDOW_TOLERANCE_MS` (60s) of each other. The threshold is unambiguous rather than
tuned: jitter is bounded by the provider's own truncation plus clock latency, seconds at the very
worst, while a genuine rollover moves the reset by a whole window and the shortest window named here
is five hours. Anything from a few seconds to a few hours would serve.

The tolerance is applied when comparing, never when parsing. Quantizing `resets_at` at the parse
site would corrupt a stored fact — it is displayed to operators as a countdown and is what
`windowStartsAt` is inferred back from — to fix a comparison, and bucketing would still split
whenever real jitter straddles a bucket edge, turning a constant bug into an intermittent one.

`sameWindow` has exactly one definition because `saveQuota` and the console's `quotaSegments`
(`apps/dashboard/src/lib/vitals.ts`) are asking the same question. Two answers would mean storage and
chart disagreed about what a window *is*, which is worse than either being wrong alone. Both sites
have a test pinned to the constant's own boundary, so a local copy at either fails.

Where `resets_at` is null — a provider reporting usage with no stated reset — a repeated identical
reading is genuinely indistinguishable from no change, and is correctly skipped. Null is not near
anything: a provider that started or stopped naming a reset said something new.

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

### The router measures the same window the estimate does

`paceAdjusted` (`packages/router/src/quota.ts:44-59`) divides headroom by the fraction of the window
still to run, and that fraction needs a window length. It used the nominal constant, so once
`durationFor` existed the burn estimate and the router were measuring the same reading against two
different windows. One of them had to be wrong, and it was the router.

**This is a deliberate behaviour change**, recorded here rather than left as a silent divergence.
Its direction is toward caution:

```text
remaining = (resetsAt - now) / duration
score     = headroom / remaining
```

`duration` is a divisor inside a divisor, so a *shorter* real window gives a *larger* `remaining` and
therefore a *lower* score. A three-hour Codex window filed under `fiveHour`, read at 80% used with
90 minutes to go, scored `0.2 / (1.5/5) = 0.667` against the bucket and scores `0.2 / (1.5/3) = 0.400`
against the length the provider actually stated. The old number was not merely a different opinion:
it described a window with 3.5 hours left that does not exist. The correction runs both ways — a
window longer than its bucket scores higher — but for Codex, whose reported windows are the ones that
land shorter, the practical effect is that accounts rotate away sooner.

Blast radius is exactly the providers that state a duration. `durationFor` falls back to the nominal
constant when `windowMs` is null, so Anthropic and Kimi score bit-for-bit as they did before, and so
does every row written before `window_ms` existed. No existing router test changes its expected
value; the change is only reachable through a field that was null everywhere until this branch.

The router imports `durationFor` from the `@omni/store/types` leaf, never the package root. The root
re-exports `openDb` and `encryption.ts`, and importing a *value* from it would put `bun:sqlite` and
`node:crypto` in the router's module graph in violation of boundary 3. The existing test at
`packages/router/test/quota.test.ts` pins that as a source-level rule.

## Rate and exhaustion

New pure module `packages/control/src/quota/burn.ts`. Given a snapshot window and its samples:

```text
elapsedMs   = observedAt - windowStartsAt
ratePerHour = used / (elapsedMs / 3_600_000)
exhaustsAt  = observedAt + ((limit - used) / ratePerHour) * 3_600_000
survives    = exhaustsAt === null || resetsAt === null || exhaustsAt >= resetsAt
```

The `resetsAt === null` arm is not decoration: with no reported reset there is nothing to compare
against, and a window that cannot be said to end cannot be said to be outlived.

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
Note what is *not* a guard: having no samples. A whole-window average is computed from one reading,
so the estimate is available from the first successful probe and does not wait for history to
accumulate. `quota_samples` exists to draw the chart, not to derive the rate. This is what lets the
estimate ride the existing health endpoint and appear on a freshly upgraded install immediately.

`gatewayRatePerHour` is not part of `BurnEstimate` and is not served by the health endpoint; it is
computed for the history endpoint alone, for the reasons in the API section. All four token classes
summed —
`input + output + cacheRead + cacheWrite` — from completed `request_logs` for that `credential_id`
between `windowStartsAt` and `observedAt`, divided by the same elapsed hours the provider rate uses.
The two rates are only comparable if they cover the same span, so the gateway rate is anchored to the
reading as well, even though the gateway knows its own logs in real time. All four are counted because a
provider's quota counter is charged for cached reads and writes too, so excluding them would
understate what the gateway accounts for and manufacture a divergence that is not there. Pending
rows are excluded, matching `aggregate` (`packages/store/src/sqlite/usage.ts:309`). It is null when
the window start is unknown.

### The gateway rate is not on the health endpoint

The estimate above costs one derivation over a row the caller already loaded. The gateway rate does
not: it is a `request_logs` aggregate over the window's whole span, which for a weekly window is a
seven-day scan.

Putting it beside the estimate priced it as if it were free. Spans are keyed off `observedAt`, which
the poller stamps per credential, so no two credentials ever share one and no query can be shared
either — six accounts across two windows is twelve week-scale aggregates, on the synchronous
`bun:sqlite` connection that also serves `/v1/messages`, every ten seconds while a console tab is
open. Measured at 290ms per call against 200k request rows.

So it moves to the history endpoint, where it is scoped to one credential — one to three aggregates,
asked for once when a row is expanded, on a query with no refetch interval. What it is is
corroboration shown in one disclosure; where it lives now matches that.

`credentialHealth` consequently reads no request logs at all, and that is the property a test pins
directly by making `usage.aggregate` throw.

## API

Two surfaces, because the estimate and the history have different costs and different consumers.

### The estimate rides the health endpoint

`GET /api/credentials/health` returns `{ health, quota }` today. It gains a third member, `burn`:
one entry per `(credentialId, windowType)` carrying `windowStartsAt`, `ratePerHour`, `exhaustsAt`,
and `survives`.

Every one of those is derived from the snapshot rows the route already loads. The route must read
`request_logs` **not at all** — that is a cost property, not an implementation detail, and it is
asserted by making `usage.aggregate` throw and confirming the route still succeeds. A value
assertion would not prove the call was never made.

An earlier draft of this spec put `gatewayRatePerHour` here too, priced as if it were free. It is
not; see "The gateway rate is not on the health endpoint" above for the measurement and the move.

Since the burn block is invariant under `now`, the values this returns are stable between probes.
The dashboard refetches this endpoint every 10s (`apps/dashboard/src/api/queries.ts:89`), so the
numbers it renders change only when a probe lands, and the call itself stays cheap enough to poll.

`HealthSnapshot` in `apps/dashboard/src/api/types.ts` gains the matching member. This is an additive
JSON change.

### History is its own endpoint

`GET /api/credentials/quota/history?since=&until=&credentialId=`

Admin session required, matching every other `/api/*` route outside the documented setup and login
flows. `credentialId` is optional; omitting it returns every credential. `since` and `until` are
epoch milliseconds and are clamped to the retention window.

The response carries the samples and the gateway rate. The estimate itself is on the health endpoint
and is not repeated here:

```json
{
  "samples": [
    { "credentialId": "…", "windowType": "fiveHour", "observedAt": 0,
      "used": 62, "limit": 100, "resetsAt": 0, "windowMs": null }
  ],
  "gatewayRates": [
    { "credentialId": "…", "windowType": "fiveHour", "gatewayRatePerHour": 41000 }
  ]
}
```

The gateway rate lives here rather than on health because this is where it is *shown* — only in the
Accounts disclosure, only while a row is expanded, with no refetch interval, and scoped to one
credential. That makes it one to three aggregates on demand instead of twelve every ten seconds.

It stays anchored to `observedAt` over the same span the provider rate uses. Moving it to a cheaper
endpoint must not be allowed to quietly re-anchor it to `now`; the two rates are comparable only if
they cover the same hours.

Derivation is server-side on purpose. The dashboard cannot import `@omni/control` — it is limited to
`@omni/store/types`, `@omni/ir`, and the catalog subpath — so shipping raw samples would force the
estimator to be reimplemented in `lib/vitals.ts` and again in the CLI, and the two would eventually
disagree. One implementation, in `@omni/control`, feeds both.

Backed by a new `quotaHistory(deps, input)` in `@omni/control`, exported beside the existing quota
functions and taking the same shape of dependency object. Input validation reuses the instant
parsing already used by `queryUsage`.

## Dashboard

### The shared legend carries the estimate

Both boards render the same thing under each `Meter`: `quotaLegend(window, now, pollIntervalMs,
formatRelative)` from `apps/dashboard/src/lib/vitals.ts:290-303`, which today produces `resets in
3h05m`, `stale, read 12m ago`, or `never observed`.

`quotaLegend` takes the window's burn entry as an additional argument and gains one case: when
`survives` is false, it names the estimate before the reset — `empty ~2h10m · resets 3h05m`. When
`survives` is true the existing reset phrasing is unchanged, because "you will not run out" is
already what `resets in 3h05m` communicates and adding a distant ETA beside it would invite
arithmetic nobody needs to do. The stale and never-observed cases are untouched and take precedence:
a suppressed estimate must not be printed.

Changing this one function is what puts the estimate on both boards. It is the reason the Overview
rack costs almost nothing to serve.

### Overview rack

`AccountRack.tsx` is one line per account — lamp, identity, quota meters, TTFT, traffic — sorted
worst-first, with a "Manage accounts" link to the full board. It stays that way. No chart, no
disclosure, no new column.

What it gains is the estimate, through the shared legend above, plus the `burn` member threaded from
`OverviewBoard.tsx` (which already passes `quota` and `quotaPollIntervalMs` down at
`features/overview/OverviewBoard.tsx:82-84`). An operator scanning the rack sees which accounts will
not survive their window; clicking through to Accounts is where the history and the gateway-rate
corroboration live.

#### The rack sorts by exhaustion (follow-up, since taken)

This design originally left the rack's sort alone — lamp state, then tier — and recorded burn rate as
a tempting third key deferred to a separate decision, on the grounds that an account at 40% draining
fast is worse than one at 80% sitting idle but that folding it in would smuggle a behaviour change
into a telemetry feature. That follow-up has since been taken, and this section records what landed
rather than leaving the note contradicting the code.

The rack now ranks by lamp state, then by exhaustion, then by tier. Within one lamp state, a
credential whose tightest window will not survive sorts above one that will; among two that will
not, the sooner `exhaustsAt` sorts first; everything else falls through to today's tier order.

Three properties hold the change to what was asked for:

- **Burn sits below lamp state, not above it.** A `down` account still outranks every healthy one no
  matter how fast the healthy one is draining. An open breaker is a fault now; exhaustion is a
  forecast, and a forecast must not push a live fault down the list.
- **A suppressed estimate never reorders anything.** The key is guarded on `stale`, exactly as
  `quotaLegend` guards what it prints, rather than on whether a figure happens to be present. A
  reading that went stale or never arrived means the account stopped being measurable; promoting it
  would make losing visibility look like an emergency, which is the opposite failure.
- **"Tightest window" is the router's sense of the word.** Every reported window is a candidate, the
  ones nobody believes are dropped, and the worst of what is left decides — the same shape as
  `quotaHeadroom`'s `Math.min` over usable windows. It is not `quotaUsage`'s duration order, which is
  a reading order for the meters: a weekly window about to run dry outranks a five-hour one that is
  fine.

`AccountsBoard` keeps its existing order. The rack is a triage surface where worst-first is the whole
point; the accounts page is a management surface where a stable, predictable order matters more.

### Accounts board

`AccountsBoard.tsx` renders a nine-column table with one `<Tr>` per credential. Each row gains a
disclosure control in the existing trailing 48px column. The collapsed state is today's row plus the
estimate in the legend, exactly as the rack shows it — same `Meter` stack, same `quotaLegend`.
Everything below is what expanding reveals.

Expanding inserts a second `<Tr>` immediately below, with a single `<Td colSpan={9}>` holding, per
reported window:

- A recharts line of `used` as a percentage of `limit` over the selected span. The line uses
  `type="stepAfter"`. Dedup means a flat stretch in the data is a flat stretch in reality;
  interpolating between two stored points would draw a slope that never happened.
- A break at each rollover rather than a line falling to zero. A rollover is detected by
  `resetsAt` changing between adjacent samples, and the segments are drawn as separate series so no
  line connects the end of one window to the start of the next.
- The burn rate, labelled as a window average.
- The exhaustion estimate, phrased against the reset: an ETA when the window runs out first, and a
  plain statement that it lasts the window when it does not. It is phrased from `quotaVerdict`
  (`@omni/store/types`), never from `survives` directly — `survives` is true by construction whenever
  `exhaustsAt` is null, which includes `limit === null` and `resetsAt === null`, so a reader that
  branched on it first would print "lasts the window" beside a panel simultaneously reporting that
  nothing is known.
- The gateway rate beneath, labelled as what this gateway accounts for.
- Two pace overlays on the same axes, both from `budgetPace`/`projectedPace` in `lib/vitals.ts` so
  the arithmetic is testable without rendering:
  - **Budget**, one per window drawn including the preceding one: a straight line from
    `(windowStart, 0%)` to `(resetsAt, 100%)`, the pace that spends the allowance exactly as the
    window resets. Each run counts back from its own `resetsAt` by
    `durationFor(windowType, windowMs)` — the same duration `@omni/control` infers a window start
    from, never a second constant — and a historical run uses its own reset, never the current
    window's, which would slope its pace across a span it never occupied.
  - **Projection**, one per panel, for the window still being spent: from `(observedAt,
    usedPercent)` to `(resetsAt, usedPercent + ratePerHour/limit × 100 × hours)`. Note the
    conversion: the rate is provider units per hour and the axis is a percentage of the same
    ceiling. Anchored to `observedAt` and never to `now`, for the reason `burnFor` is: `used` is the
    provider's count as of that instant and the rate is averaged to it, and the console refetches
    far more often than the provider is probed. Because both are drawn from that anchor and that
    rate, this line crosses 100% exactly at `exhaustsAt` — the two are one claim, and a disagreement
    between them is a bug in one of them. That equality is the panel's own cross-check and is
    asserted in both the unit and the render test.
- A fourth fact, `Projected — N% of limit by reset`, and a y-axis of `[0, max(100, projected)]` with
  `allowDataOverflow` so an overshoot reads as one. The domain is stated rather than inferred:
  recharts silently stretches a numeric domain to whatever the data reached, which would leave the
  axis describing the samples instead of the window.

Colour is not available to separate the overlays — on this console it means provider identity or
state, and a pace is neither — so they are told apart by dash pattern in the existing ink tokens:
budget dotted, projection dashed. Dashed also carries the meaning, being inferred rather than
measured, and the caption names both.

Windows with no limit, no reset, or a stale snapshot render the corresponding unavailable state
rather than a blank space. A credential whose provider reports nothing keeps today's `unknown`
legend and offers no disclosure. Each overlay is suppressed on the same terms rather than drawn at
zero: no limit and no reset leave 100% and the endpoint undefined, so neither line is drawn and the
projected fact reads `unknown`; a rate that is null or zero suppresses the projection alone, because
zero is what one reading into a window reports and a flat line would promise the account never
spends again; a run whose provider named no reset gets no budget rather than the current window's.

Range selection is per-window rather than borrowing the Usage page's traffic-shaped
`1h/24h/7d/30d/90d/1y` set: a five-hour window charted over ninety days is noise. The span shown is
the current window plus the preceding one, which is the range in which the estimate means anything.

Expansion state is local to the board and not persisted.

## CLI

`omni status` — `quotaCell` (`apps/cli/src/commands/status.ts:42-57`) already renders
`5h 62% · 7d 18% (3m ago)`. It gains the estimate: `5h 62% ~2h10m` when the window will not survive,
`5h 62% ok` when it will, and the existing age note and red-at-90% colouring are untouched.

`omni quota [--json]` — a new command under the Reports section of `apps/cli/src/help.ts`. It lists
each window's used and limit, rate, estimate, and reset, one row per `(account, window)` with the
account as a column. A per-credential block with an indented list would be the prettier shape, but
the repo's `table()` helper pads per table, so grouping would repeat the header for every account.

`--json` emits the raw samples and the derived block for scripting. `omni status --json` is left
alone; this is the scripting surface for burn data. Like every CLI command it goes through
`@omni/control`, never `/api/*`.

Two presentation points the table has to get right:

- **The rate's unit is not always a percentage.** `12.4%/h` reads correctly only because Anthropic
  and OpenAI are normalized to `limit: 100`. Kimi reports raw counters, so the rate is a percentage
  of that window's own limit, and falls back to raw provider units per hour (`250.0/h`) where there
  is no ceiling at all.
- **`unknown` and `stale` are different sentences.** Control folds "too old to believe" and "never
  observed" into a single `stale: true`, but `observedAt <= 0` is still visible, so the two are
  separated: a never-observed window reads `unknown`, an aged one reads `stale`. Neither prints an
  estimate. `omni status` keeps them both silent, as specified.

That judgement is `quotaVerdict` in `@omni/store/types`, shared with the console rather than written
once per surface. It lives in that leaf because the CLI reaches its inputs through `@omni/control`
and the console through `/api/*`, and neither can reach the other — the same reason
`WINDOW_DURATION_MS` lives there. Written twice, the two drifted, and the console printed "lasts the
window" for an account whose provider reported no ceiling at all. Each surface adds only its own
phrasing and its own `now`.

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
  zero used, stale snapshot. Empty history is *not* among them — the estimate never reads samples.
  Assert that by making `listQuotaSamples` throw and confirming the estimate still computes; only a
  throw proves the call was never made, where checking a value would not.
- `survives` is true when the estimate falls past `resetsAt` and false when it falls short
- the whole burn block is invariant under `now`: holding one sample fixed and advancing `now` across
  several poll intervals leaves `windowStartsAt`, `ratePerHour`, and `exhaustsAt` byte-identical, and
  only the staleness verdict flips. This is the anti-sawtooth anchor and is the first thing to
  mutation-test — swapping `observedAt` for `now` in the denominator must fail it.
- `windowMs` overrides the nominal duration, and its absence falls back
- OpenAI's parser populates `windowMs` from `limit_window_seconds`; Anthropic and Kimi leave it null
- `credentialHealth` calls `usage.aggregate` zero times. Assert it by making `usage.aggregate`
  throw, for the same reason the sample lookup is asserted that way
- `gatewayRatePerHour`, on the history endpoint, counts only the credential's own logs within the
  window span, and naming a credential scopes the rates to its own windows
- an empty query param is absent rather than zero: `?until=` must not clamp the span to the epoch

Router:

- a window whose stated `windowMs` is shorter than its bucket scores *lower* than the same reading
  measured nominally, and a longer one scores higher. The comparison is the assertion, not just the
  value: a test that only pinned `0.4` would still pass if the two denominators were swapped
- a window with `windowMs` null scores exactly what it scored before `durationFor` existed, which is
  what keeps Anthropic and Kimi from drifting
- mutation-test both halves: reverting `paceAdjusted` to `WINDOW_DURATION_MS`, and making
  `durationFor` ignore `windowMs`, must each fail a named test

Gateway: the history route requires an admin session, clamps its range, and filters by credential.
`/api/credentials/health` returns `burn` alongside `health` and `quota`.

Dashboard, under happy-dom with the existing helpers:

- `quotaLegend` renders the ETA when `survives` is false, keeps today's reset phrasing when true, and
  prints neither when the reading is stale or never observed — the suppression cases take precedence
- the Overview rack shows the estimate and gains no chart, no disclosure, and no extra column
- the rack sorts a window that will not survive above a healthier account in the same lamp state, and
  the sooner exhaustion first between two that will not; a `down` account still outranks a
  fast-burning healthy one; a suppressed estimate reorders nothing; accounts with no burn data keep
  tier order; and ties are stable. Mutation-test all four load-bearing halves: removing the key,
  hoisting it above lamp state, letting a stale estimate participate, and reversing the `exhaustsAt`
  comparison must each fail a named test
- the Accounts row expands and collapses by accessible name
- the charted span is the current window plus the preceding one, and each panel filters the shared
  response down to its own span
- the chart is step-held
- a rollover renders as separate segments rather than one line falling to zero
- a provider reporting nothing offers no disclosure and keeps its `unknown` legend
- a fresh install with a snapshot but no samples still shows the estimate on both boards, and shows
  the chart as not yet observed

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

Routing scores change for providers that state a window duration, which today means OpenAI and Codex
only. They move down, because a window read as longer than it is looks emptier than it is. An
operator who had tuned a pool around the old numbers will see Codex accounts rotate out earlier than
before; that is the correction landing, not a regression. Anthropic and Kimi are unaffected because
they state no duration.
