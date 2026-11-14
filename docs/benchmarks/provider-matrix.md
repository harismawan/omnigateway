# Provider matrix

## Current review corrections

Within each comparison side, effective environments must match after replacing
only that round's recorded `OMNI_ROOT` scratch prefix in values by `<scratch>`.
Remaining differences name the variable and refuse comparison. Between sides,
differences are printed under **environment differences between sides**. Use
`--require-same-env` on `bench-compare.ts` to refuse them instead. Gateway-visible
fixture certificate paths are copied under the scratch root so their ephemeral
prefix follows this same rule; no allocator settings are normalized away.

`bench-rounds.sh` requires empty OUT, checks load before each invocation, and
writes per-side manifests containing expected/present round filenames. Directory
comparison requires complete matching manifests. Failed rounds leave partial
manifests, and cannot silently become a complete comparison.

Direct capacity probes now use 64 clients for single chunks, 16 for 2,000
chunks, and a separate one-client probe. Anthropic token calls are appended to
a shared fixture counter file; a change over a scenario fails integrity.
Responses emits created/in_progress/item/part/deltas/done/completed with
monotonic sequence numbers and usage only at completed. Sequence numbers require
distinct delta frames rather than replaying byte-identical Responses deltas.

### Limits that accompany any reported numbers

- The report-file boundary includes statistics/JSON encoding and polling delay.
  A discrepancy over 250 ms fails; the tolerance is **2.5% of 10 s** and **1.25%
  of 20 s** (12.5% of a 2 s functional run), not an exact completion timestamp.
- The verifying client adds gateway load at the same maximum target of four
  requests/s on both sides. Its actual rate is recorded. Its requests are
  excluded from oha throughput/latency but consume gateway CPU and memory.
- Per-request sizes come from oha's **post-run SQLite record**. Gateway load
  sampling ends at the explicit report file, before that recording completes.
- Environment differences, including Rust's production MIMALLOC_PURGE_DELAY=1,
  are visible and must accompany a comparison. Masked credential values disclose
  presence, not equality of secrets.

Intended real-measurement command (quiet host, fresh OUT, at least three rounds):

```sh
export OMNI_RUST_BINARY=/path/to/release/omnigateway
BASE_GATEWAY=/path/to/frozen-ts HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-real ROUNDS=5 MAX_LOAD=1 \
bash scripts/bench-rounds.sh --duration 20s --warmup 3s --boots 5 \
  --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7 --fresh-process
bun scripts/bench-compare.ts /tmp/opencode/bench-real/base /tmp/opencode/bench-real/head
# For same-gateway base/head, optionally append --require-same-env.
```

The chronological sections below describe earlier checkpoints; final verified
scope and outstanding limits are maintained in the SDD benchmark matrix report.

## Fix round 1: measured integrity

### Recording mechanism and window correction

The oha 1.16.0 source prints results before `db::store`. Local 100ms file
polling at 64 and one client confirmed no SQLite file during the load, and a
post-load write. Piped stdout JSON is buffered until exit, so its arrival is
**not** a safe boundary. With `--output report.json`, a complete report file is
observable before SQLite recording. `scripts/bench-recording-observe.ts OUT`
reproduces three alternating recording/no-recording pairs per concurrency.

Matrix mode now polls the explicit report file every 2ms and samples the
gateway/stops its verifier as soon as the complete report is observed, instead
of waiting for oha to exit. This includes oha's statistics/JSON serialization
and scheduler/poll latency, not the subsequent SQLite write. Observed interval
and oha-reported duration are retained; deviation above 250ms fails integrity.
This is a bounded approximation, not an exact per-request end timestamp.

At that boundary the same SQLite row-count/state wait starts for both gateways,
independently of oha process exit. `cpuMsPerRequest` ends at the load boundary;
`cpuMsPerRequestDrained` ends when all measured load-key rows are done. The wait
polls every 10ms with a 30s deadline; timeout fails the scenario. Both numbers
include concurrent verifier overhead. This drain count/state check is followed
by the existing semantic status/usage checks. Default mode retains the original
sampling, CLI and JSON path.

Matrix provenance captures effective OMNI_*/MIMALLOC_* values from the running
gateway's `/proc/PID/environ`; key/token/secret/password/credential-like names
are masked as `<set>`. Rust's production launcher defaults
`MIMALLOC_PURGE_DELAY=1`; this is not allocator-neutral. Both environments are
disclosed by the comparison, with within-side consistency and optional
cross-side strictness as described above.

By default one gateway serves scenarios in order; later RSS includes prior
workload history. `--fresh-process` restarts before every matrix scenario and
checks the effective environment remains unchanged. It retains the seeded DB
and upstream processes. Functional verification status is in the SDD report.

Recording-on/off reported durations were close to the requested four seconds
in the sanity runs. Request-count ranges overlapped, but c1 recorded counts
were somewhat lower in one set. On this busy host that does not prove zero
perturbation or establish recording cost. Headroom at one client is no longer
used as an acceptance criterion. Raw evidence retains count/duration and file
timeline; no gateway performance finding is inferred.

Comparison safeguard update: ratios require matching duration, warmup, CPU sets,
rate, harness commit, scenario concurrency and request
body SHA256, both within and between sides. Missing metadata is rejected with
the field named. Missing scenario observations are flagged and suppress ratios.
Fewer than three successful observations per side yields `insufficient rounds`
with a descriptive ratio, excluded from better/worse/inside-spread counts.
Range overlap is descriptive, not a significance test. Environment rules are
the within-side normalization and cross-side disclosure rules at the top of this
document; historical results without required metadata are refused.

Matrix smoke and a separate verifying client require the complete aggregate
`lorem ipsum ` text (one repetition per chunk), 64 input tokens and two output
tokens per chunk, valid termination and no error frames. The verifier has its
own key and runs on load CPUs with a 4 requests/s maximum target; observed rate
is recorded. Its requests are excluded from oha throughput/latency and from
the measured load-key log query. Matrix chat streams request usage explicitly.

Measured load-key rows must all be done/HTTP 200 with expected usage, and match
oha's HTTP-200 count. Every oha response size is checked through oha's SQLite
output against the validated smoke length ±max(128 bytes, 2%). Min/max/count
and the band are retained. Persistence occurs after the measured interval;
its placement and limitations are described above. Default
scenarios do not enable this instrumentation.

Permanent after-first faults: `empty-after-first`, `error-frame-after-first`,
`500-after-first` through `OMNI_BENCH_FAULT`. Each stub process answers its first
request normally. `TS_BINARY=... OMNI_RUST_BINARY=... bash
scripts/bench-fault-check.sh` checks all three × both gateways × json/stream.
Keep failure evidence separate from performance measurements.

`bun scripts/bench-gateway.ts --matrix --gateway <argv> --cli <argv>` generates
eight cases per provider: chat/messages/responses × json/stream (64 clients,
one upstream chunk), overhead-c1 (one client), and chunks-2000 (16 clients).
The last two stream through the provider's nearest ingress. `--only` accepts
comma-separated exact names or `*` globs, e.g. `'custom-*'` or `'*.responses.*'`.
An empty selection is an error. Without `--matrix`, existing scenarios and
the legacy JSON schema are preserved, including exact-only `--only` selection.

Available: `custom-chat`, `custom-responses`, `anthropic-key`, `anthropic-oauth`.
The custom variants use CLI-created
custom credentials on distinct endpoint IDs, upstream model
`mock-c<chunks>-d0`, and a two-process upstream on port 18100. Both codecs always
request upstream SSE, independently of ingress response mode.

Each scenario is smoked before measurement: HTTP status, content type and
ingress-specific text location are checked. Capability/request rejection
(400/404/405/422/501) is `unsupported` with the response error recorded; other
errors or invalid 200 bodies are `failed`. Supported smoke proceeds through
the existing load, status, request-log and writer-barrier checks. A failed
matrix makes the process exit nonzero. Unsupported cases retain their name
and reason and have no metrics. Metrics for measured cases are nested in
`metrics`; provider, ingress, mode and classification are explicit.

The provider table lives in `scripts/bench-matrix.ts`. Entries specify id,
provider, credential protocol, nearest ingress, origin and script. Credentials
are CLI-created; OAuth uses the conformance encrypted-SQLite seed format with
expiry in 2100. Anthropic targets pin credential IDs so variants cannot cross-route.
The Anthropic stub serves Messages SSE, usage and token endpoints; arbitrary
mock model names pass through unchanged. Matrix cluster setup is rejected.

Run the complete matrix through `bash scripts/bench-matrix.sh`: it creates a
private network/mount namespace, hosts override and TLS certificate trusted only
through `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`. Two pinned stub processes share
each origin. New providers need a table entry and scripted upstream plus a seed
helper only if their credential is unavailable through `credentials add-key`.

## Functional checks

From this worktree (gateway processes run in scratch directories):

```sh
bash scripts/bench-matrix.sh \
  --gateway /tmp/opencode/merge-anthropic/ts \
  --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 \
  --out /tmp/opencode/bench-matrix/ts-custom.json
OMNI_RUST_BINARY=/tmp/opencode/merge-anthropic/rust \
  bash scripts/bench-matrix.sh --gateway "sh $PWD/scripts/run-rust-gateway.sh" \
  --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 \
  --out /tmp/opencode/bench-matrix/rust-custom.json
```

For measurement on a quiet host:

```sh
export OMNI_RUST_BINARY=/path/to/release/omnigateway
BASE_GATEWAY=/path/to/frozen-ts HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-matrix/real ROUNDS=5 MAX_LOAD=1 \
bash scripts/bench-rounds.sh --duration 20s --warmup 3s --boots 5 \
  --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7
DURATION=20s bash scripts/bench-upstream-check.sh
bun scripts/bench-capacity.ts /tmp/opencode/bench-matrix/upstreams /tmp/opencode/bench-matrix/real/base/*.json /tmp/opencode/bench-matrix/real/head/*.json
bun scripts/bench-compare.ts /tmp/opencode/bench-matrix/real/base /tmp/opencode/bench-matrix/real/head
```

The runner alternates AB/BA round order, retains results, records uptime/load
and refuses high starting load (`ALLOW_BUSY=1` overrides). `commands.sh` records
shell-escaped exact per-round commands, including the Rust binary override.

Use at least three interleaved rounds (five above is preferred). Direct recording
sanity can be reproduced:

```sh
OUT=/tmp/opencode/bench-recording-new DURATION=2s \
UPSTREAM_CPUS=4-5 LOAD_CPUS=6-7 bash scripts/bench-load-recording.sh
bun scripts/bench-load-recording-summary.ts /tmp/opencode/bench-recording-new
```

This alternates recording off/on across three rounds at concurrency 64 and 1,
driving two chat stub processes directly. The first shared-host check did not
establish safe single-client recording headroom against the release gateway:
direct recorded rates ranged both below and above the gateway observation.
Latency ranges overlapped between recording modes; no isolated overhead or
performance conclusion is justified. Keep the raw JSON and inspect rates and
latency together. That rate-headroom criterion was superseded by the verified
post-run write mechanism and report-file boundary described above.
Duration and selection pass through unchanged, e.g. `--duration 2s --warmup 1s
--only 'custom-chat.*'` selects all eight custom-chat cases in every round.

Comparison prints binary SHA256 headers, a better/worse/inside-spread summary
per metric, and one table per provider. Each scenario has rows for req/s,
p50/p99 latency, CPU ms/request and peak resident memory (MiB). Each side shows
successful/total rounds and median [min–max]; head/base ratios use the medians.
Overlapping ranges (including touching endpoints) are marked `inside spread`.
Higher throughput is better; lower latency/CPU/RSS is better. Any failed or
unsupported observation on either side suppresses that scenario's ratios and
shows its status, while preserving successful-round statistics. Such cases are
excluded from the summary counts. Missing scenarios/metrics produce n/a when
no valid comparison is available; unequal round counts are displayed explicitly.

Every matrix JSON retains existing `config.gateway` argv, duration/warmup,
gateway/upstream/load CPU sets and replica CPU sets. Added `provenance` records
resolved binary path, its SHA256, harness git commit, and 1-minute load averages
before/after the run. For `run-rust-gateway.sh`, the hash is of `OMNI_RUST_BINARY`
(or the launcher's default executable), not the shell script. Other wrappers
are not resolved: use a direct executable or this Rust launcher. Use a clean
harness checkout and stable binaries for measurements. Comparison refuses
missing hashes and mixed binary hashes within either side; older results need
remeasurement rather than guessed provenance. Default non-matrix JSON remains
unchanged. Hashing occurs before calibration/measurement.

For a short functional two-round selection check (not a performance claim):

```sh
OMNI_RUST_BINARY=/tmp/opencode/bench-gate/bin/main-327f240f \
BASE_GATEWAY=/tmp/opencode/bench-gate/bin/ts-frozen-f9cc6678 \
HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-matrix/check-rounds \
ROUNDS=2 ALLOW_BUSY=1 bash scripts/bench-rounds.sh \
  --only 'custom-chat.*' --duration 2s --warmup 1s --boots 1
```

Short functional runs on the shared host are not performance evidence.
Fault injection: `OMNI_BENCH_FAULT=500` or `missing-credential` with one selected
scenario checks that fast failures cannot become supported measurements.
