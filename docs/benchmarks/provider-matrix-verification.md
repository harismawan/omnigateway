# Provider matrix functional verification

> Historical record (pre-1.0): the compared binaries no longer exist. Kept as
> evidence of the harness's functional coverage; commands and results below are
> not reproducible today.

Evidence root: `/tmp/opencode/bench-matrix/`. Gateways: frozen external binary
`/tmp/opencode/merge-anthropic/ts` and dev Rust binary
`/tmp/opencode/merge-anthropic/rust`, launched through `sh scripts/run-rust-gateway.sh`.
Durations: 2s measured, 1s warmup. This shared host is unsuitable for performance
findings; no observed rates or speedup claims are published here.

## Scenario results

Each cell applies to **both TS and Rust**, with response-shape and load-integrity
checks passing. Provider × row identifies the exact scenario name (dot-separated).

| suffix | custom-chat | custom-responses | anthropic-key | anthropic-oauth |
|---|---|---|---|---|
| chat.json | supported | supported | supported | supported |
| chat.stream | supported | supported | supported | supported |
| messages.json | supported | supported | supported | supported |
| messages.stream | supported | supported | supported | supported |
| responses.json | supported | supported | supported | supported |
| responses.stream | supported | supported | supported | supported |
| overhead-c1 | supported | supported | supported | supported |
| chunks-2000 | supported | supported | supported | supported |

Final full-run evidence: `{ts,rust}-final.json` (32 supported each), plus earlier
split-run evidence `{ts,rust}-{custom,anthropic}.json`. All completed logs were
accounted for, with no pending/missing rows or Rust writer drops. TS lacks the
writer-barrier endpoint and is checked by rows.

## Failure detection and capacity

For `custom-chat.chat.json` on both gateways:

- Upstream 500 → failed, HTTP 503, code `server_error`.
- Missing credential → failed, HTTP 503, code `service_unavailable`.
- Both have null metrics; neither becomes a fast successful benchmark.

Evidence: `{ts,rust}-{500,missing-credential}.json`. Unsupported capability
classification and malformed/truncated/error-bearing successful responses are
also covered by unit tests.

Direct stub checks cover chat, Responses and TLS Messages at one and 2,000
chunks. All six returned only HTTP 200 and passed the capacity sanity gate
(direct fixture >3× best corresponding gateway observation). Evidence:
`upstreams/*.json`, `capacity.md`. Repeat this gate on a quiet host alongside
real measurements; these short sanity checks do not establish production rates.

## Other checks

- Legacy TS run retained all ten scenario names. Top-level and per-scenario
  JSON keys matched `2026-11-08-rust-slice1.json` runs[0]. Held-stream count was
  reduced with the existing `--streams 16` flag for functional verification.
- Namespace runs exercised CPU pinning, /proc sampling and oha. Both gateways
  trusted TLS via environment alone.
- Core typecheck passed. Nine benchmark tests passed. Full `bun test scripts/`:
  83 passed, three unrelated existing Bun-version tests failed (duplicated
  workflow pins and changed Docker base). Changed benchmark code passed Biome.
- Interleaved runner retained two supported rounds per side in AB/BA order.
  Editing its script while it ran interrupted its final comparison command;
  comparison was executed separately. An unchanged final runner subsequently
  passed end-to-end with one round per side. Evidence: `runner-check/`,
  `runner-final/`. Starting-load refusal was tested (`load-refusal.log`).

## Scope

No cluster matrix, real upstream behavior, OAuth refresh/error paths, tool/image/
reasoning semantics, or stubs for openai/codex, antigravity, grok, kimi, kilo,
muse, qoder. Those providers are absent from Rust. Comparison currently reports
throughput, p50/p99 latency, CPU/request and peak RSS ratios with
rounds/median/min–max and overlap labels (added in the provenance follow-up).
Measurement commands and provider extension contract are in
[provider-matrix.md](provider-matrix.md).

## Comparison/provenance follow-up

Implementation commit `958b8b55`. Functional evidence:
`/tmp/opencode/bench-matrix/followup/` (two interleaved rounds per side,
`--only 'custom-chat.*' --duration 2s --warmup 1s --boots 1`). Round config,
provenance, command transcript and comparison are retained. The binary hashes
and both load samples were verified for every round; all eight selected cases
were supported in each of four JSON files with duration 2s and warmup 1s.
The binary hashes
are checked against the external executable files, including the Rust binary
behind the launcher. No observed comparison is a performance finding.

Twelve focused benchmark tests passed; full scripts suite: 86 passed and the
same three existing workflow/Docker version failures. Core typecheck and changed
file Biome checks passed. Tests cover inclusive overlap, unequal successful
round counts, failed/unsupported ratio suppression, and binary-mix refusal.
Old results without SHA256 provenance now fail comparison explicitly.
