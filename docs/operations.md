# Operating the gateway

Day-two material for a running installation: how gateway keys are bounded and
what the counts mean, where the gateway's own output goes, recording request
bodies for an incident, and the database — snapshots, restore, compaction,
clearing bodies. First-run setup is in the [README](../README.md).

## Key limits

Bound what a key can do with `--limit <dimension>:<window>=<value>`, repeated
once per pair. An unset pair is unlimited:

```bash
omni keys create --label ci --limit requests:1m=60
```

Every window is *sliding*, so a key cannot spend two windows' allowance either
side of a clock edge. `requests` and `tokens` take `1m`, `5h`, and `1w`; `spend`
takes `5h` and `1w`; `concurrency` is not a window at all but a ceiling on
requests in flight at once.

`tokens` and `spend` are debited once a response completes, because an exact
count exists only then — a key at its ceiling is refused on its *next* request.
The `5h` and `1w` counts derive from `request_logs`, so a `1w` limit on an
installation that prunes logs after three days really enforces three days. They
are cached for thirty seconds and so can read slightly high, never low: refused
early rather than let past a ceiling you set. If the database cannot answer they
stop enforcing and the gateway logs it, while `1m` and `concurrency` are held in
memory and go on enforcing exactly.

Limits are editable after the key exists, unlike `--no-bodies`. `omni keys
list` prints a compact summary; the full matrix and what has gone against it
need one key's id:

```bash
omni keys limits <id>
omni keys limits <id> --set tokens:1w=50000000
omni keys limits <id> --unset spend:5h
```

`--unset` names a pair that is actually set, so a typo fails rather than
reporting a change it did not make. The usage shown counts completed requests
only, so it reads at or below what the gateway is enforcing, and `concurrency`
shows no figure — that gauge lives in the process, not the database. The
console's Keys screen shows and edits the same matrix.

The headers a client sees for these limits are in
[client-api.md](client-api.md#rate-limit-headers).

## Metrics and traces

Both observability surfaces are off until configured. Set `OMNI_METRICS_TOKEN` to register
`GET /metrics`, then scrape it with the same bearer token:

```bash
curl -H "Authorization: Bearer $OMNI_METRICS_TOKEN" http://127.0.0.1:9000/metrics
```

The endpoint is process-local and reads only in-memory state: it never queries the database or
coordinator. Prometheus combines replicas. For example, request rate by provider:

```promql
sum by (provider) (rate(omni_requests_total[5m]))
```

`api_key_id` attribution is bounded by `OMNI_METRICS_MAX_SERIES` (5000 by default). Once the cap
is reached, new key series accumulate under `api_key_id="other"` rather than disappearing;
`omni_metrics_series_folded_total` counts that loss of attribution.

Set `OMNI_OTLP_ENDPOINT` to collect request spans and POST OTLP/HTTP JSON to its `/v1/traces`
path. `OMNI_OTLP_HEADERS` supplies comma-separated `k=v` collector headers and
`OMNI_TRACE_SAMPLE` controls head sampling. Well-formed inbound `traceparent` is joined; no trace
header is ever added to a provider request. Export is bounded and fire-and-forget, with dropped
spans reported by `omni_otlp_spans_dropped_total`.

## Logs

Gateway events are written to stdout as one greppable line each: process lifecycle, OAuth
refreshes, quota probes, failover, and errors.

`OMNI_LOG_FILE` *names* where output was captured; it does not redirect it. Setting it alone
leaves the log empty, because the gateway still writes to stdout. Redirect the output and name
the same path:

```bash
bun apps/gateway/src/index.ts >> /var/log/omni.log 2>&1
```

`omni start` does both for the gateway it supervises, and under systemd the journal needs no
setup. Capture in a fleet is per process; see
[deploying.md](deploying.md#log-capture-in-a-fleet).

## Recording bodies

By default the gateway records no prompts and no responses. For incident
forensics, capture is opt-in and needs **two independent keys, both required**:
`OMNI_BODY_LOGGING_ALLOWED=1` read at boot, plus the **Capture request and
response bodies** setting (console Settings, or `omni settings set
bodyLoggingEnabled true`). An admin session alone cannot start recording your
users' prompts; with the variable unset the console says the switch does
nothing rather than letting you flip it. Capture can be toggled mid-incident;
turning it off stops new capture and does not delete what was written.

A gateway key created with `--no-bodies` is never captured whatever the setting
says — made at issue time, not reversible afterwards; reissue instead. Raw SSE
frames are captured separately, under `bodyLoggingCaptureStreamChunks`, and are
far the larger store.

What is captured: what arrived at `/v1/*` and what was returned, plus every
provider attempt in dispatch order — the client side pre-RTK, attempts post-RTK,
labelled as such in console and CLI. Headers are never captured, at any layer.
Read them from the console's Logs screen or:

```bash
omni bodies req_550e8400-…          # the frame: state, size, one line per attempt
omni bodies req_550e8400-… --full   # the payloads themselves
omni bodies req_550e8400-… --json   # the artifact, for a script
```

The bare command prints only the frame, never conversations — asking costs one
flag. A missing artifact answers rather than errors: `not captured`, `captured,
then lost` (retention or the row cap), or `captured, but unreadable` (usually a
changed `OMNI_ENCRYPTION_KEY`). There is no command to delete a captured body;
a second path that erases forensic evidence on request loses incident records.

Artifacts live at `request_bodies/YYYY/MM/DD/<requestId>.json.enc` beside the
database, AES-256-GCM under `OMNI_ENCRYPTION_KEY`; changing that key invalidates
every artifact. Bounds: log-retention expiry plus a hard **100,000-row cap**, so
capture is forensics, not an archive — size a volume against roughly 100 GB
worst case, though most artifacts are kilobytes.

Masking is best-effort — bearer tokens, vendor-prefixed keys, long opaque
tokens are elided before write — a reduction in exposure, not a guarantee, and
it costs fidelity. Treat the tree as you would the prompts themselves: encrypted
at rest, on a volume you control, never pasted into a ticket.
[ARCHITECTURE.md](../ARCHITECTURE.md#body-capture-forensics) documents the storage
format, structural bounds, and masking rules.

## Snapshots and restore

The console's Database screen reports what this installation occupies — the
database file, its write-ahead log, the captured-body tree, the free pages a
compaction would give back, and every table by size — and takes snapshots.
`omni db stats` prints the same figures. On Postgres both show the server's own
size, the `request_bodies` table and the per-table listing instead; there is no
file, so nothing here compacts, snapshots or restores it — `pg_dump` is the
backup.

**What a snapshot is.** One self-contained SQLite file, written into a
`snapshots/` directory beside the database. The write-ahead log is folded in, so
there is nothing else to copy alongside it, and taking one is safe while the
gateway is running: it reads through SQLite rather than copying bytes off disk.

**What it is not.** The sibling `request_bodies/` tree is excluded, always. A
snapshot is never a prompt corpus, and its size tracks your configuration and
usage history rather than your traffic. The cost is that a restore leaves the
captured-body tree out of step with the table: files the restored database has no
row for are collected by the hourly sweep, and a row whose file is gone reads back
as `captured, then lost`.

**A snapshot does carry secrets** — encrypted provider credentials and gateway
key hashes — inert only because `OMNI_ENCRYPTION_KEY` is not in the file.
Anyone holding both the file and the key holds your provider accounts; treat a
downloaded snapshot as the database itself.

**Retention** bounds the directory: at most `keepLatest` snapshots are kept, and
nothing older than `maxAgeDays` — 5 and 30 by default. Both bounds have to pass,
so an old snapshot goes even while the count is under the limit, and the newest is
always kept whatever the numbers say. Pruning runs when a snapshot is taken rather
than on a timer, so a quiet installation keeps what it already has. **Edit the
policy on the Database screen**, not on Settings: it is deliberately not part of
the settings form, so a settings save from a client that has never heard of
retention leaves your policy alone instead of resetting it.

The copy taken automatically on the way into a restore is exempt from retention.
It is the undo.

**Restoring from the console** happens inside the running gateway. Client traffic
on `/v1/*` is refused with a retryable 503 while the file is replaced; `/api/*`
and `/health` keep answering. The screen also uploads a database file from
elsewhere, up to 2 GiB — bring `OMNI_ENCRYPTION_KEY` with it, or the credentials
in it are unreadable. The file is integrity-checked before anything is touched,
and a copy of what was there is taken first. A restore ends by rebuilding the
usage rollup, which briefly blocks even `/api/*`: roughly 0.4 s per 500k
request-log rows, 1.6 s at 2M, 6.5 s at 8M. A failure is logged rather than
raised — the database is live either way, and `omni doctor` reports a rollup
that disagrees with its rows.

Before it asks, `restore` prints one row per table with what the snapshot holds
against what is live, so the confirmation is informed rather than a judgement on
an id and an mtime. `--dry-run` prints the same table and exits without asking.
The counts cover the tables the integrity check reads, so they are a floor on
what a restore replaces rather than the whole of it.

**`omni db restore <id>` refuses while a gateway is running** against that
installation, and there is no override flag. A second process can open its own
handle but cannot quiesce the gateway's, and moving the file out from under a live
SQLite connection corrupts the database you were trying to rescue. Run `omni stop`
first, or restore from the console, which swaps the file behind its own quiesce
latch.

**Compaction.** `omni db vacuum`, or the console's equivalent, rewrites the
database and reclaims the pages deletion left free. It holds SQLite's write lock
for the rewrite, so a busy gateway stalls on its writes until it finishes — but
nothing is lost by running it live, and it reports what it actually gave back to
the filesystem.

**Clearing bodies.** `omni db clear-bodies`, or the Database screen's *Clear
bodies*, deletes every captured prompt and completion on either engine — the
files beside a SQLite database, the `request_bodies` rows on Postgres. The
requests stay in the log with their bodies marked pruned. There is no undo:
bodies are never in a snapshot.
