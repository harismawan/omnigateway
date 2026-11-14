# Benchmark matrix report

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

## Not covered / concerns

No stubs for openai/codex, antigravity, grok, kimi, kilo, muse, qoder (absent from Rust). No matrix cluster mode, OAuth refresh/rejection, real provider/network behavior, tools/images/reasoning semantics, or production performance claims. Existing non-matrix stress/cancellation cases remain separate. Comparison currently reports throughput ratios only, with successful/total rounds and median/min–max; latency/CPU/RSS remain in per-round JSON/provider markdown. Short measurements on this contended host cannot establish production speed or robust ceiling margins. A real measurement needs a quiet host, release Rust and rerun of direct fixture checks. Only HTTP rejection statuses classify unsupported; an unsupported capability represented as generic 503 will conservatively fail.
