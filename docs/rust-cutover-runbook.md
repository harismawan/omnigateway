# TypeScript → Rust cutover runbook

**Status: preparation, not authorization to deploy.** Migration baseline: `0b89f34b`.
This is the operator procedure for the approved first Rust release, not evidence
that its release gates have passed. Do not execute a production cutover until
the release owner signs off the gates below against the exact release artifact.
Commands here are instructions for that later maintenance window; none were
executed to prepare this document.

## 1. Release-owner stop point

Record the candidate tag/commit, archive checksum or image digest, platform,
previous TS version/artifact, installation root, database identity, Redis database,
service scope and backup location in the change record. Keep secrets out of it.

| Established source contract | Still required before cutover |
| --- | --- |
| Release archive layout and Linux CLI/service boundary exist. | Actual tagged assets/checksums and target-platform validation; native Darwin supervision is not established by Linux results. |
| D4 (`7c2d7adc`) integrated Postgres and Redis in the gateway and verified live PG17/Valkey8, TLS, fleet fanout, shared health and writer/seed/drain. | Confirm the release artifact and the installation's transport, topology and recovery plan. Do not downgrade TLS. |
| Migration design requires in-place upgrade with no Rust-only migrations in the first release. | SQLite **and** Postgres TS→Rust and Rust→TS cross-reads on the candidate, including credentials, passwords and bodies; production-copy rehearsals in both shapes. |
| X1 (`35409ef6`) and X2 (`aeccaf84`) closed the parked stream/usage and credential-expiry carrier gaps. A9 was accepted with Linux-only evidence. | Record full F3 conformance against the frozen oracles, plus the controller's admin-route differential. Native macOS console behavior and polling latency remain unvalidated. |
| P1 measured single-node and two-replica release performance against unchanged targets. | Record the accepted boot and memory limitations below; P1 is not an all-target pass. |

The release owner must attach the completed gate evidence or an explicit,
documented scope decision; this runbook does not waive a gate. In particular,
loopback service capability, cached images, sparse/debug limiter timings and
single-node results are not live-PG, TLS, dense-window/concurrent-refresh or
cluster performance certification. Retain the migration design's targets; report
a measured miss rather than silently reducing them. **Stop here while any
required gate is unresolved.** Full F3 review remains separate.

D4's release evidence must satisfy **all seven D3 integration conditions**:
(1) snapshot query first, sums and ranges in one read-only REPEATABLE READ
transaction; (2) identical completed-row/key/model selection with exact
`at >= since_ms` boundaries; (3) canonical top-level `pg_current_xact_id()::text`
from the completing transaction, delivered once per row only after commit;
(4) each row's own stored `at`, tokens and cost remain associated with that ID,
including mixed-age commits; (5) primary seed reads or a proven visibility
barrier; (6) one xid8 lineage and the pretraffic counts/companions sweep below;
(7) actual writer/pool concurrency and ignored-before-seed cases, producer→writer
completion→limiter→coordinator drain ordering, consistent `fleet_max_keys`, and
dense-window/concurrent-refresh performance evidence. These are release-owner
checks, not manual Redis repairs an operator should improvise.

## 2. Confirm scope and limitations

- Executable providers in scope: **Anthropic, OpenAI/Codex, Antigravity and
  custom endpoints**. Grok, Kimi, Kilo, Muse and Qoder are deferred. Their stored
  credentials are retained, not served. At this baseline dispatch to an adapter
  that does not exist returns `INTERNAL`; connect refuses deferred providers.
  Do not mistake catalog visibility for adapter availability. Reassign affected
  models/classifier targets with operator approval, or postpone migration.
- Plugins are unsupported: they are not loaded, `/api/plugins*` returns 501,
  and `omni plugin *` exits 1. Installed plugin metadata/tables remain; retaining
  them does not make plugin providers, routes or UI operational. Postpone if the
  installation depends on them. Doctor reports non-loadable plugins rather than
  proving their compatibility.
- Ponytail was dropped from the migration scope. RTK remains in scope. Resolve
  an installation's dependency on the dropped feature before the window.
- The CLI administers local SQLite only. Use authenticated admin HTTP and the
  database's own tooling for a Postgres fleet.
- Rust ships as release binaries, the container image, and npm
  `omnigateway@1.x` (a native binary per platform; Node only installs it). The
  TS `0.15.5` npm release stays published for rollback and Windows, which is
  not a Rust release target; Linux and macOS targets are listed below.

### Measured performance and overload behavior

Source: P1 FINAL, retained at `/tmp/opencode/p1/report.md` (`12275c33`, merged
as `0b89f34b`). The full Linux run used 20 s of load, 3 s of warmup where
applicable and 1,000 held streams. No crashes were observed. Cluster throughput
is the **sum across two replicas**, not per replica. Cluster idle, held-stream
and boot budgets apply per replica; the early-cancel recovery budget applies to
the fleet. Targets did not change.

| Check (unchanged target) | SQLite single | Postgres/Valkey ×2 |
| --- | ---: | ---: |
| Chat throughput (≥10,000 / ≥8,000 req/s fleet) | 51,315 req/s | 29,866 req/s fleet |
| Chat p99 (≤10 / ≤15 ms) | 3.665 ms | 4.675 ms (request-weighted blend) |
| Overhead-c1 p50/p99 (≤0.30/1 ms) | 0.087/0.239 ms | — |
| Many-chunks CPU (≤1.50 ms/req) | 1.347 ms/req | — |
| Backing CPU (≤0.10 ms/req), Anthropic JSON p99 (≤20 ms) | — | 0.02808 ms/req; 4.650 ms |
| `omni keys list` p50 (≤15 ms) | 1.685 ms | — |
| Idle RSS (≤20 MiB per process) | 15.77 MiB | 14.09/13.11 MiB |
| Client-cancel RSS by 10 s (≤+20 MiB) | −13.60 MiB | −0.97 MiB fleet |
| Boot-to-health p50 (≤30 ms) | **31.5 ms, accepted miss** | **42.5 ms, accepted miss** (one externally timed replica; both missed) |
| Held-stream peak (≤80 MiB per process) | **92.95 MiB, miss** | **133.90/132.71 MiB, miss** |
| Early-cancel RSS by 10 s (≤+20 MiB) | +10.71 MiB at 5 s; exact harness verdict inconclusive (10 s sample 0.142 ms early) | **+53.05 MiB fleet, miss** (+29.29/+23.76 MiB estimated per PID) |

- **Boot (P1, Nov 20 ruling):** the 210,000-round KDF is a storage contract
  (~21.5 ms on single-node); it was not weakened to meet the target.
- **Memory — accepted release limitation (Nov 21 ruling):** the held-stream and
  cluster early-cancel targets are unchanged; the P1 values above are still
  misses. Held RSS peaked at 92.95 MiB single-node and 133.90/132.71 MiB per
  cluster replica. Cluster early-cancel RSS was +29.29/+23.76 MiB estimated per
  PID and +53.05 MiB fleet-wide at about 10 s. P2's control on the same release
  reproduced the misses: 126.34/133.03 MiB held and +46.88/+43.28 MiB per
  replica after early cancel (`/tmp/opencode/p2/report.md`).
  - **Held streams:** the P2 cluster census measured about 32 MiB in live
    connection and request allocations per 500 streams on each replica, on
    top of an elevated post-load baseline that included about 20 MiB of live
    Postgres driver buffers per replica. The single-node run has no PG pool;
    P2 did not break down its elevated baseline.
  - **Early cancel:** in the P2 census, the transient writer backlog cleared
    and tracked live allocations were back at baseline by +5 s, but anonymous
    RSS remained elevated, consistent with allocator retention. No crashes
    were observed, and the measurements did not show an unbounded leak.
  - PG pool LIFO lowered held RSS but did not meet the target and worsened
    rate-limited p99. `MIMALLOC_PURGE_EXTEND_DELAY=0` lowered late early-cancel
    RSS but still missed the target and reduced throughput on other workloads.
    Neither change was adopted.
  - **Sizing:** budget RSS per replica for its expected concurrent held streams,
    with headroom above the measured post-load baseline.
- **Postgres drain overload (P1, Nov 20 ruling):** Rust may shed optional
  Begin/Route events rather than wait as TS does. Interim pending/route visibility
  and the corresponding live invalidations may be absent; Finish accounting,
  completed usage rows, rollups and limiter debits are not shed by this policy.
  Alert on authenticated `/metrics` `omni_request_log_writer_optional_dropped_total`
  alongside `omni_request_log_writer_queued` and `omni_request_log_writer_credits_in_use`.
  P1 counted 2,546,918 optional drops, zero terminal drops or stranded pending
  rows, and reconciled 3,825,762 completed cluster rows and 519,578 Valkey debits.
- **Bounded PG reservation (D4/P1):** inference can return HTTP 503 before
  admission if the wait queue is full, the wait expires (up to 4 seconds), or
  the writer is closed. A primary revalidation read can also fail after waiting. Monitor
  `omni_request_log_writer_reservation_refused_total` by `cap`, `deadline`,
  `closed` and `revalidation`; investigate the cause rather than counting them
  as optional events. P1 observed 11,456 HTTP 503s, all in the early-cancel
  workload; the harness did not identify the cause of each 503.

### Compatibility limits from the migration ledger

| Source | Limit and operator implication |
| --- | --- |
| A9 (`67f4872d`, Nov 20 ruling) | Linux console only was verified. Native macOS `/api/stream`/console behavior and polling latency are unvalidated; do not infer them from Linux, or infer native Darwin supervision from E4. |
| A8 (`a8-report.md`) | Client login has no built-in attempt limiter, as in frozen TS. Apply an appropriate external login rate limit if exposing it. |
| A15 / D4 (`7c2d7adc`), Nov 21 ruling | Pending OAuth flows expire after 600 seconds. In single mode they are process-local and lost on restart; in cluster mode they are shared in Redis, so an unused flow can survive a replica restart until it expires. Both modes consume the flow under the coordinator lock before exchange. At-most-once redemption in a mixed poll/finish race is an accepted divergence from frozen TS; A15's inherited double-redemption caveat does not apply to Rust. PKCE poll still attempts exchange with an empty code and can consume the flow; use finish with the authorization code rather than polling as if it were a device-code flow. |
| B4 (`b4-integration-rereview.md`) | Antigravity can connect with an empty project but refuses inference until reconnected with a valid project. |
| A3 (`a3-review2.md`) | SQLite body artifacts are written directly before the database row. Failed SQL or replacement on a different day can leave orphan files until sweeping; back up both artifact tree and database. |
| A14 (`a14-review3.md`) and A9 framing ruling | Idle timeout classes match, not exact timer ticks (10 s initial headers, 255 s ordinary idle). Transport counts raw framing bytes while the body reader counts decoded bytes near the 4,177,920-byte rearm threshold. Empty/close response framing and HEAD export headers can differ without changing the payload. |
| A12 (`a12-review4.md`) backlog | When reading stored scoring settings, a literal `±1e400` can cause Rust to use defaults for the entire settings object where TS defaults only the field. Extreme finite target prices (e.g. `1e308`/`-1e308`) can produce NaN cost and fail Rust usage persistence; frozen behavior was not established for that case. Avoid these values and investigate persistence errors. |

## 3. Stage the release and preserve the old installation

Download/verify only the release approved in step 1. Use its `SHA256SUMS`, check
the archive entry for the selected target, and retain a versioned release
directory rather than overwriting the rollback artifact. The archive name is
`omnigateway-<tag>-<target>.tar.gz`, where targets are:

- `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`;
- `x86_64-apple-darwin`, `aarch64-apple-darwin`.

Keep these siblings together:

```text
<release>/omnigateway       canonical executable (server and CLI dispatcher)
<release>/omni -> omnigateway
<release>/public/           built dashboard
<release>/LICENSE
```

For a release archive, invoke the **absolute new** `<release>/omni` path during
cutover, not an old globally linked npm `omni` (npm installs: see below). Service installation resolves the symlink and writes
the canonical `<release>/omnigateway` into `ExecStart`. A standalone CLI requires
an adjacent `omnigateway` companion; it does not build or launch Bun. Keep the
release directory in place for the lifetime of that unit. The dashboard defaults
to the executable's sibling `public/`; retain an intentional `OMNI_STATIC_DIR`
override and verify that it names the right console build.

### Root and environment

Use the existing installation root, not the release directory. CLI root order
is `--root` → `OMNI_ROOT` → detected installation in cwd →
`~/.config/omnigateway`. Root `.env` overrides ambient variables. An explicit
`--root` suppresses ambient `OMNI_DB_PATH` unless overridden by `--db` or the
root's own `.env`. `--db` only changes the CLI's database selection, **not the
launched server's environment**. Put the intended server database path in that
root's `.env`; do not rely on a CLI-only override.

The bare `omnigateway` server does **not** autoload `.env`. `omni start` parses
and passes the selected root's environment; generated systemd units use a
required `<root>/.env` with `WorkingDirectory=<root>`. Containers need explicit
environment/Secret injection. Preserve `OMNI_ENCRYPTION_KEY` **byte for byte**,
the public reverse-proxy `OMNI_BASE_URL`, day offset and relevant `OMNI_*`
settings. CLI dotenv parsing does not expand `$` or shell escapes. Do not source
it as shell code to approximate that parser.

### Backup before any candidate database open

Doctor can open/migrate a database. Run candidate diagnostics first on the
rehearsal copy, not the only production copy. Preserve:

1. The old executable/image, TS/Bun runtime dependencies if used, original unit
   and drop-ins/manifests, root `.env` and secret references. Store the encryption
   key securely apart from public evidence; a DB backup cannot replace it.
2. **SQLite:** a self-contained database snapshot (`omni db backup` from the
   existing installation is supported), plus the sibling `request_bodies/` tree.
   After stopping writers below, take the final consistent backup/artifact copy.
   Do not copy a live main DB file alone and omit its WAL. Preserve permissions.
   Built-in snapshots exclude body files; after restore the orphan sweep can
   remove unmatched files, and missing artifacts cannot be recovered from the DB.
3. **Postgres:** a DBA-approved consistent backup/restore point, normally
   `pg_dump`, including `request_bodies` BYTEA rows. Gateway/CLI SQLite snapshot,
   restore and vacuum commands are not Postgres administration. Preserve the
   existing PG/Redis environment and ACL/transport configuration; do not convert
   the deployment to SQLite or another Redis database during this cutover.

Rehearse restoration and both cross-read directions on copies before approving
the window. Retain backups off the live retention/pruning path. A snapshot holds
encrypted accounts and key hashes; treat it and body archives as sensitive.

## 4. Single-node SQLite maintenance window

1. Stop incoming inference at the proxy; allow current streams to finish.
   Stop TS with its existing supervisor and wait for process exit. Disable any
   competing auto-start source (npm/Bun process manager, old container or unit).
   Confirm no TS process still owns this root/database/listener. Take the final
   backup from step 3. Do not run both builds against the same data.
2. For an existing **Linux user systemd** installation, use absolute paths:

   ```sh
   /absolute/rust-release/omni service install --root /absolute/install --force
   /absolute/rust-release/omni doctor --root /absolute/install
   /absolute/rust-release/omni start --root /absolute/install
   ```

   Check the installed unit's `ExecStart`, root, required environment file,
   drop-ins and reported daemon reload result. Installation rewrites the unit;
   it does not itself start it. Preserve the prior enable-at-boot policy; use
   `--enable` only if intended. Units pointing at the Bun entrypoint are not
   automatically compatible.
3. For a **system** unit, use installation privileges and `--system` on service
   install and doctor; start/stop the known system unit with `systemctl`.
   `omni start` accepts `--system`, but `omni stop`/`restart` do **not**; do not
   accidentally operate the user unit instead. Retain the existing service user
   and permissions in the reviewed deployment configuration.
4. Without systemd, `omni start --root ... --foreground` passes the resolved
   environment and inherits output; it emits no CLI success document, even with
   `--json`. Detached `omni start` captures logs under the shared state location
   (`XDG_STATE_HOME` or `~/.local/state`, then `omnigateway/`). Use the existing
   supported supervisor plan on macOS only after native validation; these
   systemd steps are not a launchd installation recipe.
5. Perform step 6 with external traffic still paused. A successful start or
   `/health` alone does not accept the cutover. If diagnostics report the wrong
   root/binary, unreadable accounts or an unexpected migration, **stop**.

### npm installations (`omnigateway` 0.x → 1.x)

`npm update -g omnigateway` performs steps 1–2 above for a **single-node**
service the TS CLI wrote, through `omni service migrate` (design:
[npm distribution](superpowers/specs/2026-11-21-rust-npm-distribution-design.md)).
It runs from `postinstall` when npm allows the package's scripts
(`--allow-scripts=omnigateway`; npm 12 blocks them by default), otherwise from
the `gateway.js` bridge on the old unit's next start.

Before stopping anything it refuses: a unit systemd did not load from that file
(`FragmentPath`, `WorkingDirectory`, pending reload, drop-ins, missing facts);
a transitional state (`activating`, `deactivating`, `reloading`); any
`Environment=`, or any `OMNI_*` in the user or system manager's environment;
environment files other than `<root>/.env`, or one outside plain
`[export ]NAME=VALUE` lines (single-line quotes allowed; no `\`, `$`, backtick,
continuation or multi-line quote); an `OMNI_HOST` that is a host name rather
than an IP or `localhost`; directives
beyond the TS template (output wiring excepted, but not into the replaced
package); cluster settings; a visible foreign database holder; an unwritable or
full snapshot directory; an unreadable or newer ledger; a non-running binary;
both scopes; and a system unit without root or with a non-root-owned binary
path. It prints and records directive **names**, never their values.

After the stop it confirms systemd reports the unit stopped, checks nothing
still answers on the gateway's port, and takes an SQLite exclusive lock. That
lock fails while another connection holds a shared lock (any connection that
has read and not finished) and keeps new readers out while held; it does not
see a process that opened the file and never read it. The lock is held across
the backup and the `ExecStart=` rewrite and released just before the start. A
start is accepted only when `/health` answers, the listening socket serving the
probed address belongs to systemd's `MainPID` (or the bridge's child), that
process runs this binary and has the backed-up database open, and no other
process visible in `/proc` has it open.

**Accepted limitation (owner ruling):** this is not an exclusive handoff.
Between releasing the lock and Rust opening the database there is a short
window, and the TS gateway takes no lock that Rust could wait on. A second TS
gateway on the same SQLite file (another installation, another supervisor)
starting in that window would write alongside Rust; the post-start check catches
it only if it is visible in `/proc` (same user, same path) and then stops the
service after both have run. Automatic migration assumes no other gateway uses
this database; if one might, stop it first or migrate by hand. Any failure after the stop leaves the
service stopped if systemd confirms it, or says it could not be confirmed and
gives the stop command first, with rollback steps for that branch. A recorded
failure, with its backup and saved unit, is kept as `pendingFailure` across
every later attempt — refused, current, or another failure, which never replaces
the first — until the service is seen serving (answering `/health` on the
probed address from this binary, holding the database). The outcome is recorded in `<state>/npm-migration.json`
(`~/.local/state/omnigateway` by default); `omni doctor` and `omni status` print
its reason until resolved. This replaces the maintenance window for that one
shape only. It does not take step 6, so run it after the update.

The bridge serves the migrating start as its own child (signals relayed), so
that one run's process tree is `bun gateway.js` →
`omnigateway omni service migrate --bridge` → `omnigateway`; the next restart is
the binary alone. With scripts blocked, later Rust updates are not restarted
automatically: run `omni service migrate` after `npm update`.

## 5. Postgres + Redis fleet maintenance window

1. Arrange the first Rust image promotion **manually**. In that same reviewed
   promotion PR set deployment strategy to **Recreate**, not RollingUpdate or a
   surge. Pause automatic promotion as necessary; do not let GitOps reintroduce
   the TS image. Recreate staging exists separately from this baseline; inspect
   the actual promotion diff. No deployment change is made by this document.
2. Pause traffic; drain and stop **every TS replica/writer**. Confirm all old
   pods/processes are gone and prevent reconciliation from restarting them.
   Keep Rust replicas stopped too. Take the final PG backup. Use the same primary
   database and intended Redis database: `OMNI_CLUSTER_MODE=true`,
   `OMNI_DATABASE_URL`, `OMNI_REDIS_URL`. Confirm the approved artifact supports
   the deployment's transport; never downgrade TLS to get past this stop point.
3. **Invalidate long-window counts and companions before Rust boot/preseed.**
   D3 snapshots and writer commit IDs belong to one PG xid8 lineage. With all
   producers stopped, use the deployment's authenticated Redis client/connection
   to perform this bounded procedure:

   ```text
   cursor = 0
   repeat:
       SCAN cursor MATCH omni:b:* COUNT 200
       save the returned next cursor and actual key names
       UNLINK each nonempty returned page's explicit key arguments
       cursor = returned next cursor
   until cursor = 0
   perform a complete verification scan; repeat sweep if any matches remain
   ```

   `SCAN` can return empty pages before cursor zero, and duplicate names; continue
   to zero and tolerate already-unlinked names. `omni:b:*` is a **SCAN pattern**,
   never a literal key supplied to UNLINK. Unlink only returned names, safely
   encoded by the client, in bounded batches. Both bucket hashes and their
   `:meta` companions match the pattern and must be removed. Record completion
   and counts, not connection secrets. Do not use FLUSHDB/FLUSHALL or delete
   session/lease/lock namespaces as a substitute. This sweep is mandatory at
   TS→Rust cutover and on DB restore/replacement/xid-domain change or incompatible
   Rust companion changes, **before** traffic or preseeding. If it fails, stop.
4. Start only the approved Rust replicas under Recreate. Require boot/key-change
   preseeding evidence from the integrated D4 release. Seeds read the primary;
   a lagging replica is not an accepted replacement for that visibility contract.
   Keep the same `fleet_max_keys` across replicas. Do not hand-edit companions
   or fabricate snapshots/transaction IDs to make counters look seeded.
5. Perform step 6 on each node and through the proxy before admitting traffic.
   The D3 accepted incomplete-seed behavior is **admitted-unjudged** with
   request-driven retry, not a guaranteed five-second repair. Redis fallback is
   not proof of shared limits; do not accept a fallback fleet as healthy shared
   coordination. D4 evidence must already cover the actual writer/seed lifecycle.

Keep Recreate for any rollback to TS. Only the following Rust-to-Rust release
may restore RollingUpdate after review of that release's compatibility; do not
infer rolling compatibility across companion/lineage changes.

## 6. Operator smoke and acceptance stop point

Use ordinary supported accounts, models and a designated smoke key. Keep token,
cookie, prompt/body and secret values out of change records and shared logs.

- Check `/health` directly per process and via the proxy. Expected release
  contract: `ok: true`, actual `mode` (`single` or `cluster`), the node ID and
  `coord: "ok"`; a cluster `fallback` needs investigation, not acceptance. These
  are liveness fields, not cross-read/conformance/performance certification.
- On SQLite, inspect `omni doctor --root ...` and `omni status --root ...` for
  binary/root/database/unit alignment, rollup mismatches, unavailable providers,
  pins and guardrail/smart-routing dependencies. Doctor audits rollups, not
  repairs. CLI data management is local SQLite; use authenticated admin HTTP for
  cluster, not CLI commands against an imagined PG backend.
- Sign in with the existing admin account; verify console/static assets, models,
  accounts, keys, settings, recent logs and usage. Do not rerun setup on an
  existing database. Inspect an existing captured body when capture is enabled
  and authorized. A missing body tree is not a successful cross-read.
- Send a designated supported model one nonstreaming request and one streaming
  request through the deployment's normal client surface. Confirm stream
  completion, one completed request record per request and corresponding usage;
  check quota display where configured. Exercise configured guardrail/smart
  routing only with approved smoke input and supported classifier models.
- For cluster, use both nodes: an admin session issued on one works on the
  other, `/api/nodes` lists live nodes with correct self identity, a controlled
  config change propagates, and logs/usage/console socket updates reach the
  other node. Verify ordinary key/model shared limits and true stream-end
  concurrency release using the designated key. This is a smoke check of the
  previously certified D4 contract, not a substitute for its integration tests.
- Inspect captured stdout/journal and configured metrics for startup/decryption,
  database, coordinator, seed, dropped-writer/debit and health-queue problems.
  `OMNI_LOG_FILE` names a capture; setting it alone does not redirect stdout.

**Accept only after these checks and the step 1 gates are recorded.** Restore
traffic gradually, watch existing error/latency/usage signals, and retain the
rollback artifacts for at least the first Rust production release cycle. On a
failed check, keep traffic paused and choose repair or rollback explicitly.

## 7. Rollback: compatible executable plus compatible data

Rollback is another maintenance window, never a mixed fleet. Pause traffic,
drain and stop Rust completely, including writer/completion/health producers.
The integrated shutdown must drain committed completions before limiter shutdown
and close the coordinator last. Do not replace a DB beneath an open process.

Prefer the exact retained TS artifact/runtime and service configuration proven
by the release's **Rust→TS cross-read**. The design requires no first-release
Rust-only migrations, but that intention is not proof any arbitrary old TS build
can read new data. **Never roll back body readers below v0.13.5**: older readers
cannot read binary OGBA artifacts and may mark them corrupt. That is a minimum
body-format constraint, not a guarantee that v0.13.5 supports current schemas,
policies or other data. Use the nominated compatible rollback version.

- **Binary-only rollback, data unchanged:** restore the old unit/entrypoint or
  image with the same root, environment and encryption key. For fleet rollback
  retain Recreate and sweep actual `omni:b:*` keys as in step 5 before TS starts
  and reseeds. Start only TS, rerun the ordinary smoke and then reopen traffic.
- **Backup restore needed:** retain a copy of the failed state for diagnosis;
  agree to loss of writes since the chosen restore point. SQLite CLI
  `omni db restore <id>` refuses while a gateway is running, with no override.
  Restore the matching body artifact tree as well as the DB before allowing
  orphan cleanup. Postgres restore is a DBA operation using the approved backup,
  not `omni db restore`. Repeat the bucket/companion lineage sweep after PG
  replacement and before boot/preseed, even if the Redis server did not change.
  Restore the matching key/environment and compatible executable together.

Budget downtime for stop/drain, backup or restore, rollup rebuilding, counter
reseed, startup and smoke checks; do not promise a seconds-only recovery.
Restoring data can restore old password hashes/sessions and invalidate newer
changes. Confirm access with the restored account state, then reopen traffic
only after acceptance. Keep the failed release and evidence; do not clean them
up during incident recovery.

## Source authority

- [Migration design](superpowers/specs/2026-11-07-rust-gateway-migration-design.md):
  Cutover, packaging, targets and conformance/cross-read gates. The roadmap's
  later deferred-provider and dropped-Ponytail decisions narrow its original scope.
- [Rust CLI/service boundary](rust-cli-service.md), backed by
  `crates/omni-cli/src/{context,service,doctor}.rs`.
- `.github/workflows/release.yml` (archive/public/symlink/checksums),
  `crates/omni-gateway/src/lib.rs` (static directory and boot),
  `crates/omni-control/src/config.rs` (cluster environment).
- [Operations](operations.md#snapshots-and-restore) and its body-format rollback
  constraint; `crates/omni-cluster-limit/src/scripts.rs` (bucket companions).
- Release owner must also reconcile the roadmap D4/F3 status and D3 final review's
  seven-point integration contract with the candidate. Local preparation reports
  are planning inputs, not deployment evidence.
