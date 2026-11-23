# Configuration

Configuration is environment variables, read from the installation's `.env`:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OMNI_ENCRYPTION_KEY` | Yes | — | Encrypts provider credentials at rest; 16 characters minimum |
| `OMNI_HOST` | No | `127.0.0.1` | Listener host |
| `OMNI_PORT` | No | `9000` | Listener port |
| `OMNI_DB_PATH` | No | `./omnigateway.db` | SQLite database path |
| `OMNI_BASE_URL` | No | derived from host and port | Public origin for OAuth callbacks; set this behind a reverse proxy |
| `OMNI_STATIC_DIR` | No | the console shipped with the server | Serve a different console build |
| `OMNI_LOG_LEVEL` | No | `info` | Stdout threshold: `debug`, `info`, `warn`, or `error` |
| `OMNI_LOG_FILE` | No | the systemd journal, when there is one | Where stdout was already redirected, so the Console screen can read it back. Names a file; does not create one |
| `OMNI_BODY_LOGGING_ALLOWED` | No | unset | Permits request/response body capture on this installation. Read at boot. Capture also needs the runtime setting; see [Recording bodies](operations.md#recording-bodies) |
| `OMNI_METRICS_TOKEN` | No | unset | Registers authenticated `GET /metrics`; unset means no route |
| `OMNI_METRICS_MAX_SERIES` | No | `5000` | Series cap before new `api_key_id` values fold to `other` |
| `OMNI_OTLP_ENDPOINT` | No | unset | Enables OTLP/HTTP span export to `<endpoint>/v1/traces` |
| `OMNI_OTLP_HEADERS` | No | unset | Comma-separated `k=v` headers sent to the collector |
| `OMNI_TRACE_SAMPLE` | No | `1.0` | Head sampling ratio from `0` to `1`; inbound sampled trace context is honoured |
| `OMNI_ROOT` | No | the installation in the current directory, else `~/.config/omnigateway` | Which installation the CLI acts on, when `--root` is not passed |
| `OMNI_CLUSTER_MODE` | No | unset | `true` selects [cluster mode](deploying.md#running-more-than-one-gateway) and requires the two URLs below; unset is one process on SQLite, and then the URLs must be unset too |
| `OMNI_DATABASE_URL` | In cluster mode | — | The shared Postgres store |
| `OMNI_REDIS_URL` | In cluster mode | — | The coordinator every process of a cluster shares: rate-limit counters, sessions, leases, push fan-out |
| `OMNI_DAY_OFFSET_MINUTES` | No | host's UTC offset at boot | Fixed minutes east of UTC for daily usage buckets; set explicitly and identically on every replica |

`OMNI_ROOT` is the one variable read from your shell and never from a root's `.env`, for the
reason it has to be: a variable that selects the installation cannot live inside the installation
it selects. A `--root` flag additionally suppresses an ambient `OMNI_DB_PATH`, and says so on
stderr, so pointing the CLI at one installation from inside an unrelated checkout cannot pick up
that checkout's database.

The provider client-identity overrides — `OMNI_UA_*`, `OMNI_ORDER_*`, and the per-provider CLI
version pins — are deliberately left out of this table and documented in
[`.env.example`](../.env.example). They change how the gateway identifies itself to a provider,
which is not configuration in the sense the rest of this table is.

Gateway events are written to stdout as one greppable line each. `OMNI_LOG_FILE` *names* where
that output was captured; it does not redirect it — see
[operations.md](operations.md#logs).

Everything else lives in the database rather than the environment, so it can be
changed without a restart: the six routing weights, `maxAttempts`,
`requestDeadlineMs`, the circuit breaker's `breakerThreshold` and
`breakerCooldownMs`, `logRetentionDays`, `bodyRetentionDays`, `quotaPollIntervalMs`, `rtkEnabled`,
and the two body-capture switches. Edit them with `omni settings set` or in the
console. `quotaPollIntervalMs` is the one exception: the poller reads it once at
boot, so a change to it takes a restart. `requestDeadlineMs` defaults to `0`,
which imposes no deadline at all; what that means for whatever sits in front of
the gateway is
[Behind a reverse proxy](deploying.md#behind-a-reverse-proxy). Snapshot retention —
`snapshotKeepLatest` and `snapshotMaxAgeDays` — is stored alongside them but
deliberately edited on the Database screen instead; see
[Snapshots and restore](operations.md#snapshots-and-restore) for why.