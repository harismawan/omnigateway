# Benchmark matrix report

## Fix round 1

**Functional verification complete; next step: parent review.** Environment
rule committed `fa2bc0f7`; item 5 committed `dfc91bbf`. Both full matrices:
32 supported each. Default schema/legacy bytes, twelve faults, additional wire
faults and two-round comparison checked. Evidence `/tmp/opencode/bench-final/`.
Worktree: rust-bench, branch feat/bench-provider-matrix. No performance findings.

| Review finding | Commit | Failing check first | Evidence path |
|---|---|---|---|
| Smoke-only validation admitted broken measured traffic | `2a570d7c` | Empty-load reproduction reported supported with metrics | `/tmp/opencode/bench-matrix-fix1/before.json`; corrected 12 fault JSONs in same directory |
| Failed scenarios exposed performance | `7027a570` | Failed stream still printed numeric req/s | `bench-matrix-fix1/ts-empty-after-first-stream.log`; corrected `no-failed-metrics.json/.log` |
| Insufficient observations, missing rounds, workload mismatch | `4c545e77` | Comparison regression assertions failed | `/tmp/opencode/bench-matrix-fix-rest/compare-before.log`; owned tests |
| Recording headroom concern | `a2a9680e`, `aa8b9e55` | Direct single-client rates straddled gateway observation; inconclusive criterion | `bench-matrix-fix-rest/recording/`, superseded by write-mechanism evidence below |
| Recording occurs after load; exit-based sample extends window | `3d587a9c`, `e3aea571` | Local timelines show SQLite recording extends process lifetime; piped stdout buffered until exit | `/tmp/opencode/bench-window/{observed,file-observed}/`, `{summary,file-summary}.txt`, `oha-lib.rs` |
| Effective environment, common drain CPU, fresh process | `e3aea571` | Old output lacked fields and CPU ended at delayed exit | `bench-window/{ts,rust}-final.json`; selected fresh-process cases passed |
| Environment equality rule rejected intended TS/Rust experiment | `fa2bc0f7` | New normalization/disclosure/strict-option tests failed | `/tmp/opencode/bench-final/env-before.log`; comparator tests |
| Reused OUT, missing manifest/round guard | `dfc91bbf` | Nonempty OUT populated with new metadata before comparison failed | `bench-final/nonempty-before.log`, `nonempty-after.log`; manifest tests |
| Incomplete Responses lifecycle | `dfc91bbf` | Pre-change fixture lacks sequence/in_progress | `bench-final/lifecycle-before.log`; lifecycle test; full matrix reruns |
| Capacity concurrency and OAuth refresh assertion | `dfc91bbf` | Reviewed code used 64 for long streams and did not count token calls; no separate live failing injection before edit | `bench-final/capacity/`, `capacity-status.txt`, `token/check.log`; `refresh-injected.json` rejects an injected counter increment during load |

All evidence directories above abbreviate `/tmp/opencode/`. No performance
findings: this host is shared with builds. Supplied frozen TS is
`/tmp/opencode/bench-gate/bin/ts-frozen-f9cc6678`; release Rust is
`/tmp/opencode/bench-gate/bin/main-327f240f`, through the production launcher.

### Implemented measurement rules

- Generated four-provider × three-ingress × two-mode matrix, plus overhead-c1
  and chunks-2000 per provider (32). Models forward mock-cN-d0; both gateways
  receive identical credentials/targets/request bodies and CPU assignments.
- Smoke and pinned verifier require exact full text, termination, usage and
  no error. Measured load-key rows require success, expected usage and exact
  count; per-request size min/max comes from oha's post-run SQLite record.
  Failed metrics are null; diagnostics are separate. Unsupported remains
  explicit. Verifier has its own key, excluded from oha statistics.
- The verifier adds gateway work at a maximum target four requests/s on both
  sides; actual rate is recorded. CPU/RSS include that work.
- Load sample uses complete explicit oha report file, before SQLite recording.
  It includes statistics/JSON encoding and 2ms polling/scheduling delay.
  Observed-vs-reported interval difference >250ms fails: this is 2.5% of 10s,
  1.25% of 20s, and 12.5% of a 2s functional run. It is not an exact last-request
  timestamp. Both gateways use the same done-row polling for drained CPU.
- Effective OMNI_*/MIMALLOC_* environment comes from /proc, credential-like
  values masked. Within side only own scratch-root prefix is replaced. Fixture
  certificate copies live under that root. Remaining changes refuse and name
  variables. Between sides differences always print; --require-same-env refuses.
  Rust launcher defaults MIMALLOC_PURGE_DELAY=1, not allocator-neutral.
- By default one gateway serves all scenarios in order; later memory includes
  earlier history. --fresh-process restarts per scenario, keeping seeded DB.
- Comparison shows throughput, p50/p99, load/drained CPU and peak RSS, counts,
  median/min–max and ratios. Under three observations: insufficient rounds,
  descriptive ratio only. Range overlap is not a significance test. Failed,
  unsupported or missing observations suppress ratios. Workload/body/hash/
  harness/config incompatibility is refused. Directory inputs need manifests.
- Runner refuses nonempty OUT, checks load before every invocation, retains
  AB/BA order, shell-escaped commands, expected/present manifests and uptime.
- Direct fixture probes use 64 single-chunk, 16 long-stream and 1 overhead
  clients. Anthropic token calls append a shared count log; any measurement
  change fails. Responses emits sequenced lifecycle, usage only at completion.

### Rerun status

| Run | TS | Rust |
|---|---|---|
| Full 32 | 32 supported / 0 unsupported / 0 failed | 32 supported / 0 unsupported / 0 failed |
| Twelve fault regressions | 6 failed / null metrics | 6 failed / null metrics |
| Responses empty-after-first | failed / null metrics at load | failed / null metrics at load |
| Anthropic empty-after-first | failed / null metrics at smoke | failed / null metrics at load |
| Default all ten / JSON key diff | passed | not requested |
| Two interleaved rounds, custom-chat.* | 8 supported each round | 8 supported each round |

Legacy stub comparison against d8d8f869: identical response bytes after replacing
only generated UUIDs, for 1 instant chunk, 2,000 instant chunks and 3 delayed
chunks. Literal independent UUID bytes naturally differ. Evidence
`bench-final/legacy-bytes.txt`. Nine matched-concurrency direct fixture probes
completed without errors (capacity-status.txt); no rate margin conclusion.
Token fixture check counted two token calls. Two-round comparison completed,
contains insufficient rounds and environment differences; both manifests list
1.json/2.json expected and present. CLI --require-same-env rejected the actual
TS/Rust result pair. Default all ten names/top-level/scenario keys match
2026-11-08-rust-slice1.json runs[0] (`default-keys.txt`); --streams 16 used for
functional held-stream resource use. Owned tests currently 24 pass,
90 assertions; typecheck 683 files and changed-file lint pass.

### Still not covered / limits

No cluster matrix, real-provider networking, OAuth refresh semantics, tool/
image/reasoning fidelity, or stubs for providers absent from Rust (openai/codex,
antigravity, grok, kimi, kilo, muse, qoder). Sampled verifier is not exhaustive
body validation; size and semantic logs cover every measured request. Masking
discloses secret presence, not equality. Raw environment is retained; only
scratch-root prefix normalized. Timing boundary tolerance remains substantial
for short runs. Responses sequencing now requires distinct encoded delta
frames. Refresh guard was verified by injecting a counter increment during TS
load; token endpoint counting was separately verified with two direct calls.
This was not a real gateway token-refresh flow. Dynamic host-load changes
between rounds were not injected; repeated guard placement was inspected and
startup refusal had prior evidence. Failing-first coverage for those smaller
guards was inspection rather than a live failing run. Responses lifecycle
failure was reproduced against the prior fixture after implementing the change,
not as a test run before editing. No rate-margin or production-speed claim.

## Exact real-measurement commands

After verification completion, on quiet host, fresh OUT, at least three rounds
(five preferred), from this worktree:

```sh
export OMNI_RUST_BINARY=/path/to/release/omnigateway
BASE_GATEWAY=/path/to/frozen-ts HEAD_GATEWAY="sh $PWD/scripts/run-rust-gateway.sh" \
CLI='bun apps/cli/src/index.ts' OUT=/tmp/opencode/bench-real ROUNDS=5 MAX_LOAD=1 \
bash scripts/bench-rounds.sh --duration 20s --warmup 3s --boots 5 \
  --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7 --fresh-process
bun scripts/bench-compare.ts /tmp/opencode/bench-real/base /tmp/opencode/bench-real/head
# Same-gateway base/head can append --require-same-env.
OUT=/tmp/opencode/bench-real-capacity DURATION=20s bash scripts/bench-upstream-check.sh
```

Keep sequential-process results separately if omitting --fresh-process. Read
environment differences before interpreting results; report both CPU figures,
round spread and all limitations above. No push or merge performed.
