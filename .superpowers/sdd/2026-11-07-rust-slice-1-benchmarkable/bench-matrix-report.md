# Benchmark matrix report

## Fix round 1

**LATEST COMMITTED CHECKPOINT — HEAD e3aea571, worktree clean.** A committed
`3d587a9c`; B/item 4 implementation committed `e3aea571`. Final selected
fresh-process checks passed on both supplied binaries: chat.stream and
overhead-c1, each 2s/1s. Evidence `{ts,rust}-final.json` under
`/tmp/opencode/bench-window/`; all four supported, load/drained CPU present,
drained CPU >= load CPU, secrets masked, Rust MIMALLOC_PURGE_DELAY recorded as 1.
Observed minus oha-reported duration was under 30ms for these four runs; the
configured rejection tolerance is 250ms. Recorded post-report tails differed
by request volume but were excluded from the load CPU/window/RSS sampling.

**Precise next step:** resolve strict comparison environment compatibility
without hiding performance settings. Current raw environments deliberately
preserve all effective values; ephemeral roots/DB/cert paths differ across
rounds and Rust alone defaults MIMALLOC_PURGE_DELAY=1. The comparator currently
rejects these differences. Decide an explicit, disclosed experiment identity
for ephemeral paths and allocator policy before claiming the requested
two-round comparison works. Then implement item 5 (matching capacity clients,
per-round guard, manifest/fresh OUT, refresh counter, Responses lifecycle),
failing check first and one commit. Finally item 7: full 32 each, Responses and
Anthropic faults each, twelve faults again, default list/key diff, two-round
custom-chat comparison. NONE of those final reruns is claimed yet. The harness
is NOT cleared for reportable measurement.

Final checks at e3aea571: 20 owned tests pass / 0 fail / 80 assertions across
seven files; typecheck 680 files passes; changed-file Biome and whitespace
checks pass. Commit A contains the observer only; commit B contains report-file
boundary reader, common drain, environment masking, fresh process, comparison
CPU/drain disclosure and usage docs. Full scripts suite was not rerun here.

Real-measurement command remains the documented `ROUNDS=5` interleaved command
(minimum three), after the remaining blockers are resolved. Use
`--fresh-process` for per-scenario memory isolation; omit it only when reporting
the explicitly disclosed sequential-process workload. Do not override strict
environment errors to produce a result. A's recording observation is a sanity
check: c1 count ranges overlap but recorded counts trend lower in one set;
busy-host variation prevents concluding zero load perturbation. SQLite stores
retained request data after load; this does not establish zero shared data
collection work during load, only the observed recording-write placement.

CURRENT PRIORITY CHECKPOINT: A committed `3d587a9c` (post-run recording observer).
B/item 4 implemented, selected functional rechecks running as
`/tmp/opencode/bench-window/{ts,rust}-final.json`. Next: verify both scenarios
on each side pass the final duration cross-check/environment restart assertion,
commit B/item 4, then resolve cross-side environment compatibility explicitly
(ephemeral paths and production allocator policy must not be silently ignored).
After that item 5 and full item 7 including all twelve faults again. Do not
treat prior fault runs or full matrix as verification of new window logic.

| Window follow-up finding | Commit | Failing-first check | Evidence |
|---|---|---|---|
| A: recording overhead mechanism | `3d587a9c` | Earlier rate-headroom check was inconclusive; local polling/source establishes post-run write | `/tmp/opencode/bench-window/{observed,file-observed}/`, `{summary,file-summary}.txt`, `oha-lib.rs` |
| B: end-on-oha-exit stretches sample | pending commit | c64 SQLite adds ~0.86–0.90s after explicit report; c1 ~0.25–0.47s; stdout JSON arrives too late | same timelines; final selected gateway runs pending inspection |

No performance findings. A is a mechanism/sanity result, not a proof recording
cannot perturb timing. The explicit report file still follows oha statistics
and encoding, so boundary accuracy is limited by that time and 2ms polling;
250ms observed-vs-reported interval tolerance fails suspicious scenarios.
Common drain polling starts at report boundary and is independent of recording
completion. Foreign CPU accounting samples oha CPU at that boundary, not after
its database write. Final report exposes both load/drained CPU and the process
reuse/fresh-process policy. Strict comparator currently refuses differing raw
effective environments, including ephemeral paths; final comparison completion
is still pending rather than normalized or claimed successful.

LATEST WINDOW CHECKPOINT: A mechanism verified with oha 1.16.0 tagged source
(`bench-window/oha-lib.rs`: print_result line 894, db::store line 898) and local
100ms file polling at c64/c1. Source not found in local cargo registry; fetched
the versioned upstream source. stdout JSON is buffered until exit; an initial
stdout-boundary prototype was rejected by the observation. Explicit --output
JSON file is complete before SQLite storage. Evidence `/tmp/opencode/bench-window/`
`observed/`, `summary.txt`, `file-observed/`, `file-summary.txt`.
Failing old-window check: recorded c64 process exits ~0.86–0.90s after report,
c1 ~0.25–0.47s; without recording tails at most ~4ms. Thus old end-on-exit window
includes variable recording time. File-reported load duration ~4.001–4.003s in
both modes; c64 request-count ranges overlap; c1 recorded counts somewhat lower
but ranges overlap. This busy-host sanity does not prove no timing perturbation.
SQLite absent at every poll before report completion in the explicit-file runs.
No gateway performance findings. A closes as mechanism/sanity, not headroom.

B/item 4 WORKING TREE: matrix uses complete --output JSON file (2ms polling)
as boundary, samples CPU/RSS/stops verifier there, starts identical SQLite
row-count/done polling for both gateways before oha recording completes, records
second CPU through drain. Boundary is delayed by oha statistics/JSON encoding
and poll scheduling; deviation from reported duration >250ms fails integrity.
Fresh-process flag, masked effective /proc environment and two CPU fields added.
Next: inspect active `{ts,rust}-file.json` runs, rerun after final boundary
cross-check edit, commit B/item 4 only if verified. Strict environment comparison
still rejects ephemeral path/allocator differences; not resolved. Items 5/7
remain untouched. Final full/default/12 faults not rerun yet. Current work is
not a reportable benchmark; older checkpoint claims below are historical.

LATEST CHECKPOINT (continuation from 7027a570): item 3 committed `4c545e77`;
item 6 **not cleared**, diagnostic tooling/evidence committed `a2a9680e`.
Lint-only module-spacing correction: `aa8b9e55`. Worktree clean.
Precise next step: resolve single-client load-generator recording headroom.
`/tmp/opencode/bench-matrix-fix-rest/recording-summary.json` shows recorded
direct-stub rates straddling the prior release gateway observation at c1.
Inspect oha 1.16.0's recording implementation and seek an exact cheaper
per-request size source (its current JSON only exposes aggregate
sizePerRequest/totalData, not a size distribution). Do not substitute an average
for the existing min/max check. If changing size collection, rerun all twelve
fault cases. Then implement items 4,5,7, each failing-first and committed.
Harness is NOT ready for reportable measurement. No performance findings.

| Continuation finding | Commit | Failing check first | Evidence/status |
|---|---|---|---|
| 3: unsupported directional claims / missing observations / incompatible workloads | `4c545e77` | Four regression assertions failed against prior code | `bench-matrix-fix-rest/compare-before.log`; 7 comparison tests pass, including three-observation direction and every requested compatibility field within/between sides |
| 6: possible load-side recording bottleneck | `a2a9680e` | Direct recorded c1 minimum below prior release-gateway c1 observation; cannot demonstrate safe headroom | `bench-matrix-fix-rest/recording/`, `recording-summary.json`, `oha-size-fields.txt`; unresolved, no replacement chosen |
| 4: effective environment/common drain/fresh process | pending | not run | none |
| 5: capacity concurrency/round manifest/refresh/lifecycle | pending | not run | none |
| 7: final full/default/fault/interleaved reruns | pending | not run | none |

Item 3 records scenario concurrency and body SHA256. Comparison refuses
missing/incompatible configuration, harness commit and recorded environment;
therefore old JSON lacking environment is rejected until item 4 captures it.
Absent scenario observations are explicitly flagged and no ratio is shown.
One/two observations produce descriptive ratio + `insufficient rounds`, no
directional summary contribution. Range overlap header is explicitly not a
significance test. Exact environment equality between TS/Rust will require an
explicit decision in item 4: production allocator values differ, and ephemeral
root/database paths differ too. Do not silently normalize away performance
variables or claim comparison passes before resolving that incompatibility.

Recording sanity method: two pinned chat stub processes on CPUs 4–5; oha 1.16.0
on CPUs 6–7, one upstream chunk, concurrency 64 and 1; three 2-second paired
rounds alternating off/on order, `-w`, same body; only `--db-url` changes.
All 12 direct runs had HTTP 200 only and no client errors. On/off throughput
and p50/p99 ranges overlap in both shapes. Host contention was large; a causal
recording overhead cannot be isolated. Recorded c1 samples ranged below and
above the earlier Rust gateway observation, so safe headroom is unproven.
Raw rates/latencies retained in evidence, not published as gateway performance
findings. No instrumentation replacement or twelve-fault rerun yet.

Continuation checks: 18 owned tests pass / 0 fail / 77 assertions across five
files; core typecheck 675 files passes. Changed-file lint passes after a final
module-spacing correction. Shell syntax and diff whitespace checks pass.
Docs include direct recording sanity commands and require at least three
interleaved rounds (five recommended). All earlier final-run results below
predate these continuation changes; they are not item 7 evidence.

Continuation: item 3 committed `4c545e77`. Failing-first tests retained in
`/tmp/opencode/bench-matrix-fix-rest/compare-before.log` (insufficient observations,
missing observations, incompatible duration). Seven comparison tests now pass,
including all compatibility fields within/between sides. Matrix JSON records
concurrency and body SHA256. Missing environment metadata is deliberately
refused pending item 4 capture. Item 6 direct-stub recording comparison is
running via `scripts/bench-load-recording.sh`, evidence `bench-matrix-fix-rest/recording/`.
Next: inspect recording on/off rate and latency spread, choose whether to keep
recording, then item 4. Items 4,5,7 are not complete.

CHECKPOINT — items 1 and 2 implemented/verified. Precise next step: item 3, add failing comparison tests for fewer than three observations, missing scenario observations and incompatible workload/provenance before modifying `scripts/bench-compare.ts`. Record scenario concurrency/body in matrix JSON to support comparison compatibility. Then items 4 and 5, each with failing checks and its own commit. Worktree clean after the two item commits. Measurements remain NOT REPORTABLE until those items pass. No performance findings.

| Finding | Commit | Failing check first | Verification evidence |
|---|---|---|---|
| 1: smoke-only validation admitted broken measured traffic | `2a570d7c` | Review empty-load wrapper rerun reported supported with metrics (`before.json`) | All 12 `{ts,rust}-{empty-after-first,error-frame-after-first,500-after-first}-{json,stream}.json` failed with null metrics; normal runs below |
| 2: failed observations leaked performance | `7027a570` (JSON null/diagnostics prerequisite included in item 1) | `ts-empty-after-first-stream.log` still printed numeric req/s despite failed classification | `no-failed-metrics.json/.log`: null metrics and no numeric req/s line; focused report guard test |
| 3: comparison adequacy/compatibility | pending | not run | none |
| 4: environment/drain CPU/fresh process | pending | not run | none |
| 5: capacity concurrency/round guard/manifest/refresh/lifecycle | pending | not run | none |

All fix evidence paths are relative to `/tmp/opencode/bench-matrix-fix1/`.

| Fault | TS json | TS stream | Rust json | Rust stream |
|---|---|---|---|---|
| empty-after-first | FAILED/null | FAILED/null | FAILED/null | FAILED/null |
| error-frame-after-first | FAILED/null | FAILED/null | FAILED/null | FAILED/null |
| 500-after-first | FAILED/null | FAILED/null | FAILED/null | FAILED/null |

All fault runs passed initial smoke then failed load integrity; diagnostics retain verifier violations, measured log count/status/usage failures and per-request size-band failures. Matrix implementation adds oha per-request SQLite size checks, success/usage/count checks for measured load-key rows, and a separately pinned full-body verifying process with its own key (4 requests/s maximum target, actual rate recorded). Smoke and verifier validate exact aggregate text and 64 input / 2×chunks output usage. Three after-first fault modes added to both stubs. Failed performance is omitted; diagnostic status/count information remains separate.

Other-wire smoke+load sanity passed on both binaries for custom-responses.responses.stream and anthropic-oauth.messages.stream (`{ts,rust}-other-wires.json`). Not reverified: full 32 cases after integrity changes, fault cases through every upstream wire, default all-scenario run. Items 3–5 untouched. oha's per-request SQLite recording adds load-side overhead; verify load-generator capacity before any real measurement. Verifier is sampling, not exhaustive semantic body validation; size and semantic log checks cover every measured successful request. Size band is smoke bytes ±max(128,2%). Existing barrier/settle accounting remains until item 4's common drain wait. No claims about real measurement margins.

Failing check first: review fault wrapper rerun on frozen TS produced `supported` with non-null metrics for empty-after-first; evidence `/tmp/opencode/bench-matrix-fix1/before.json`. Normal custom-chat runs on TS and release Rust passed all eight scenarios (`ts-normal.json`, `rust-normal.json`). Equal warmup/duration regression passed (`equal-duration.json`): oha size DB is replaced between warmup and measurement. Permanent functional regression driver: `scripts/bench-fault-check.sh`. Final focused tests: 15 pass / 0 fail / 58 assertions across five owned test files; typecheck 674 files passes; changed-file Biome and shell syntax pass. Functional binaries: `/tmp/opencode/bench-gate/bin/ts-frozen-f9cc6678`, `/tmp/opencode/bench-gate/bin/main-327f240f` (Rust through launcher). Older sections below describe prior work, not completion of fix-round items 3–5.

Follow-up commits: `958b8b55` implementation, `c6db2950` documentation/verification. Worktree clean.

**Follow-up complete:** `958b8b55` adds all-metric spread comparison and matrix provenance. Two interleaved rounds per side with `--only 'custom-chat.*' --duration 2s --warmup 1s` passed in `/tmp/opencode/bench-matrix/followup/`: all eight scenarios supported in each of four JSON files. Duration, selection, both load samples, actual binary hashes and harness commit verified in every round. `commands.sh` and `comparison.md` produced successfully. No performance findings. Original matrix status follows.

**Status: complete; next step is parent review/integration.** Final all-32 runs on both TS and Rust passed: `/tmp/opencode/bench-matrix/{ts,rust}-final.json`. All six direct capacity gates passed against those final results. Final rerun verifies SSE terminator/error checks and matrix-only single-write chat frames. Worktree: `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-bench`, branch `feat/bench-provider-matrix`.

## Status / commits

1. Complete: `554986a7` generated custom provider matrix, selection, shape checks and classification; functional on both.
2. Complete: `aec1863e` Anthropic API-key/OAuth, TLS namespace wrapper and encrypted seed; functional on both.
3. Complete: `e012116c` direct fixture driver/capacity gate, fault injection, spread comparison, AB/BA interleaved rounds and load guard.
4. Complete: `5b4e1992` benchmark usage/verification documentation, plus this report. Worktree clean. No product code changes, no push or merge.

## Built

`scripts/bench-matrix.ts` generates 8 scenarios per provider. Six ingress/mode combinations use 64 clients/one chunk; overhead-c1 uses one client; chunks-2000 uses 16 clients. Extra cases stream through nearest ingress.

| id | credential | target | nearest ingress | upstream |
|---|---|---|---|---|
| custom-chat | CLI custom, chat-completions protocol | custom endpoint ID | chat | HTTP :18100 chat SSE |
| custom-responses | CLI custom, responses protocol | custom endpoint ID | responses | HTTP :18100 Responses SSE |
| anthropic-key | CLI Anthropic API key | pinned credential ID | messages | TLS api.anthropic.com Messages SSE |
| anthropic-oauth | CLI seed + encrypted SQLite OAuth fields | pinned credential ID | messages | same TLS stub |

OAuth expiry is 2100; no refresh is expected during measurement. Seed reproduces conformance AES-GCM/PBKDF2 format without importing gateway code. Stub implements token and usage endpoints. All three codecs always request upstream SSE. All providers forward `mock-c<chunks>-d0` unchanged. Stubs pre-encode delta frames, replay them, and write immediate bodies together (chat single-write applies only in matrix mode to preserve legacy behavior). Two copies share each port and are pinned separately from the gateway/load client.

New entry: supply stable ID, provider, credential protocol/auth type, nearest ingress, origin and script. Script must accept `--port` (plus `--cert/--key` for TLS), support reusePort, mock model behavior, valid SSE/usage and health; any provider-specific boot endpoints must be stubbed. CLI add-key is default seed; a new non-CLI auth mechanism needs a seed helper analogous to `bench-oauth.ts`. Fixed external origins need hosts/SAN entries in wrapper. Add direct-wire coverage to upstream checker. Product provider must already exist in both gateways.

`--matrix --only 'anthropic-*'` and `--only '*.responses.*'` work; exact names/comma-separated globs supported. Empty selection errors. Without matrix, original list/JSON schema unchanged. Unsupported smoke statuses 400/404/405/422/501 retain status/error reason and no metrics. Other errors/malformed 200s fail. Measurement retains status, log-row and writer-drop integrity checks; missing logs, empty measurements, crashes or unhealthy gateway fail. Successful streams need proper text shape, terminator and no error frame. JSON includes provider/ingress/mode/classification/reason and nullable nested metrics; markdown groups by provider. Failure exits nonzero.

## Functional result table

Evidence: `/tmp/opencode/bench-matrix/{ts,rust}-final.json` (32 cases each), plus earlier `{ts,rust}-{custom,anthropic}.json`; every supported row passed shape and load integrity, no missing/pending log rows or writer drops. TS does not expose writer barrier, so row accounting is used. No unsupported combinations were observed.

| Scenario | TS | Rust |
|---|---|---|
| custom-chat.chat.json | supported | supported |
| custom-chat.chat.stream | supported | supported |
| custom-chat.messages.json | supported | supported |
| custom-chat.messages.stream | supported | supported |
| custom-chat.responses.json | supported | supported |
| custom-chat.responses.stream | supported | supported |
| custom-chat.overhead-c1 | supported | supported |
| custom-chat.chunks-2000 | supported | supported |
| custom-responses.chat.json | supported | supported |
| custom-responses.chat.stream | supported | supported |
| custom-responses.messages.json | supported | supported |
| custom-responses.messages.stream | supported | supported |
| custom-responses.responses.json | supported | supported |
| custom-responses.responses.stream | supported | supported |
| custom-responses.overhead-c1 | supported | supported |
| custom-responses.chunks-2000 | supported | supported |
| anthropic-key.chat.json | supported | supported |
| anthropic-key.chat.stream | supported | supported |
| anthropic-key.messages.json | supported | supported |
| anthropic-key.messages.stream | supported | supported |
| anthropic-key.responses.json | supported | supported |
| anthropic-key.responses.stream | supported | supported |
| anthropic-key.overhead-c1 | supported | supported |
| anthropic-key.chunks-2000 | supported | supported |
| anthropic-oauth.chat.json | supported | supported |
| anthropic-oauth.chat.stream | supported | supported |
| anthropic-oauth.messages.json | supported | supported |
| anthropic-oauth.messages.stream | supported | supported |
| anthropic-oauth.responses.json | supported | supported |
| anthropic-oauth.responses.stream | supported | supported |
| anthropic-oauth.overhead-c1 | supported | supported |
| anthropic-oauth.chunks-2000 | supported | supported |
| custom-chat.chat.json, upstream 500 | failed, HTTP 503/server_error | failed, HTTP 503/server_error |
| custom-chat.chat.json, missing credential | failed, HTTP 503/service_unavailable | failed, HTTP 503/service_unavailable |

Fault results have null metrics, never fast successful measurements. Evidence `{ts,rust}-{500,missing-credential}.json` and `fault-summary.txt`. Unsupported classification also unit-tested with HTTP 404/model_not_found.

## Verification / evidence

- Frozen TS `/tmp/opencode/merge-anthropic/ts`; Rust `/tmp/opencode/merge-anthropic/rust` dev binary. Processes run outside checkout through scratch roots. Rust launcher is not executable in git; use `--gateway "sh $PWD/scripts/run-rust-gateway.sh"`.
- Namespace tests exercise taskset, /proc and oha as part of successful normal runs. TLS trust uses environment only, no insecure gateway switch. Direct oha TLS fixture driver uses --insecure solely for its direct IP probe.
- Default TS: all ten original names; top-level and scenario keys exactly match `docs/benchmarks/2026-11-08-rust-slice1.json` runs[0]. Existing `--streams 16` reduced held-stream functional resource use. Evidence `ts-default.json`, `default-schema.log`.
- Core typecheck passes (668 files). Benchmark tests 9/9 pass, including comparison exclusion of failed fast results and median/spread checks. Full scripts suite: 83 pass, three pre-existing failures (duplicated CI/release Bun-version lines and Docker no longer using Bun base). Fixed owned probe test's unknown JSON type assertion. Changed/new benchmark implementation lint passes. Shell syntax passes.
- Runner: `runner-check/` retained two supported rounds per side in AB/BA order; editing the running shell file caused its trailing comparison command to parse incorrectly, so comparison was run explicitly. The final unchanged runner then completed end-to-end in `runner-final/` (one supported round each), including comparison output. Load guard refusal verified in `load-refusal.log`. Fresh output paths prevent overwriting rounds.
- Initial copied node_modules needed `bun install --frozen-lockfile` to restore workspace links. bun.lock unchanged. Initial Rust launch failed because runner was non-executable; interrupted a retry before measurement to avoid a default-run port collision, then used private namespaces.
- Direct fixture results: `upstreams/{chat,responses,messages}-c{1,2000}.json`; all HTTP 200 and no errors. `capacity.md` verifies all six wire/chunk shapes exceed 3× corresponding best observed gateway rate. Direct driver waits for ongoing requests at deadline (initial driver exposed oha deadline-aborts; corrected before evidence). These are only harness capacity sanity checks, **not performance findings**; repeat on quiet host with release binaries before claiming a ceiling margin.

## Exact measurement commands

Follow-up output: `comparison.md` now groups by provider with req/s, p50/p99,
CPU ms/request and peak RSS; every metric has successful/total rounds,
median/min–max, head/base median ratio, and inclusive-overlap `inside spread`.
Top summary counts better/worse/inside-spread per metric. Any failed or
unsupported round suppresses that scenario's ratios. Header prints both binary
hashes; mixed or absent hashes within a side are refused.

Existing JSON `config` already recorded gateway argv, duration/warmup and all
CPU sets. New matrix `provenance` adds resolved executable path/SHA256, harness
git commit, and 1-minute load before/after. Rust hashes OMNI_RUST_BINARY rather
than its launcher. Default JSON is unchanged. `commands.sh` retains shell-escaped
per-round argv and Rust override; `--duration` and `--only` pass through.

From this worktree, on a quiet 8-CPU host, with fresh OUT:

```sh
export OMNI_RUST_BINARY=/path/to/release/omnigateway
BASE_GATEWAY=/path/to/frozen-ts HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-matrix/real ROUNDS=5 MAX_LOAD=1 \
bash scripts/bench-rounds.sh --duration 20s --warmup 3s --boots 5 \
  --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7
DURATION=20s UPSTREAM_CPUS=4-5 LOAD_CPUS=6-7 bash scripts/bench-upstream-check.sh
bun scripts/bench-capacity.ts /tmp/opencode/bench-matrix/upstreams /tmp/opencode/bench-matrix/real/base/*.json /tmp/opencode/bench-matrix/real/head/*.json
bun scripts/bench-compare.ts /tmp/opencode/bench-matrix/real/base /tmp/opencode/bench-matrix/real/head
```

Functional single run: `OMNI_RUST_BINARY=/tmp/opencode/merge-anthropic/rust bash scripts/bench-matrix.sh --gateway "sh $PWD/scripts/run-rust-gateway.sh" --cli 'bun apps/cli/src/index.ts' --duration 2s --warmup 1s --boots 1 --out /tmp/opencode/bench-matrix/check.json` (replace gateway argv with `/tmp/opencode/merge-anthropic/ts` for TS).

Follow-up functional runner command (fresh output directory):

```sh
OMNI_RUST_BINARY=/tmp/opencode/merge-anthropic/rust \
BASE_GATEWAY=/tmp/opencode/merge-anthropic/ts \
HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-matrix/followup \
ROUNDS=2 ALLOW_BUSY=1 bash scripts/bench-rounds.sh \
  --only 'custom-chat.*' --duration 2s --warmup 1s --boots 1
```

Follow-up tests: 12 focused pass; full scripts 86 pass/3 unchanged failures;
core typecheck (668 files) and changed-file lint pass. Actual executable hashes
were independently checked against round provenance; mixed-binary rejection
also verified using copied round data. Synthetic two-round formatting example
is retained at `/tmp/opencode/bench-matrix/followup-synthetic-example.md` so no
shared-host timing is presented as a finding.

## Not covered / concerns

No stubs for openai/codex, antigravity, grok, kimi, kilo, muse, qoder (absent from Rust). No matrix cluster mode, OAuth refresh/rejection, real provider/network behavior, tools/images/reasoning semantics, or production performance claims. Existing non-matrix stress/cancellation cases remain separate. Comparison covers throughput, p50/p99 latency, CPU/request and peak RSS with spread; overlapping ranges are descriptive, not a significance test. Short measurements on this contended host cannot establish production speed or robust ceiling margins. A real measurement needs a quiet host, release Rust and rerun of direct fixture checks. Only HTTP rejection statuses classify unsupported; an unsupported capability represented as generic 503 will conservatively fail. Provenance supports direct binaries and the known Rust launcher, not arbitrary wrapper resolution. Clean harness checkout and stable executables are required; historical files without binary hashes cannot be compared.
