# Integration stabilization report

Completed the two scoped corrections from base `03be32ed`. Implementation model: GPT-6 Astra. Independent review remains controller-owned; performance acceptance and slice readiness are not established here.

## Commit map

- `7222eec6` — Responses computes JS-coerced `partial` once, scans it, then emits the same string. Mandatory real-Bun decoder/collector oracle, public decoder regression, actual TCP adapter streamed/buffered regressions.
- `feb31809` — server-owned deadline worker JoinSet, abort-and-join before writer closure, bounded historical handle reaping and atomic registration/closure. Deterministic gated destruction/DB regression, historical-worker and spawn/shutdown race coverage. Test-only unwrap lint annotations for provider fixtures.

## Reproduction and implementation

Read both cited final-fix review reports before editing. Confirmed starting HEAD and unrelated existing bun.lock/spec changes; those were not staged.

Responses RED used the original decoder: coerced array depth40001 escaped (`coerced overflow must fail before emission`). Separately restored only the original scan expression and ran valid-string-first: it failed with `Upstream: tool arguments exceed JSON depth 40000`. The mandatory Bun oracle succeeds on both sequences, confirming TS emits the coerced text and collects the valid string and deep array. Rust intentionally rejects the over-ceiling array before any offending ToolJson fragment escapes. GREEN covers actual decoder and TCP adapter streamed/buffered consumption, plus existing depth40000 collection/render/drop coverage.

Lifecycle RED temporarily omitted only the new worker join from actual Running shutdown. The test starts a real gateway/writer, persists Begin, installs a live deadline body with a real Finisher, then gates synchronous source destruction on a dedicated runtime worker. Shutdown closes the writer before the gate is released in RED: the test deterministically observes the persisted pending row and `dropped Finish=1`, then fails with `writer closed before worker destruction: pending row, dropped Finish=1`. No sleeps or schedule timing decide this regression. Test-only lifecycle observations distinguish joining from writer closure. GREEN requires Running::wait to remain outstanding while destruction is gated, then asserts done/499, no failed/dropped writer events, source release acknowledgement, and closed worker registry.

This controlled regression injects the source into the running server's actual worker registry rather than driving that particular gate through HTTP. Existing real-HTTP forced-drain, disconnect, and nonreading-client/backpressure deadline regressions also pass.

Worker ownership: response holds an AbortHandle; server holds JoinHandles in a mutex-protected optional JoinSet. Each registration reaps completed tasks, retaining at most peak concurrent workers rather than one per historical request. Taking the set closes registration under the same lock; late spawn futures are dropped synchronously. Shutdown first joins connection tasks, then cancels and joins worker futures, then closes writer. Tests cover 1000 completed registrations and 100 barrier-started registration/shutdown races. The race test permits either lock winner; the lock establishes the exclusion structurally.

## Exact commands and results

All cargo test/clippy commands below used prefix `CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`. Release benchmark artifacts were not rebuilt or removed.

| Command | Result / log under `/tmp/opencode/` |
|---|---|
| `cargo test -p omni-providers --test coerced_arguments` (original scanner, overflow-first) | expected RED, 0 passed / 1 failed; `stabilization-provider-red.log` |
| same command (original scanner restored, string-first) | expected RED, 0 passed / 1 failed; `stabilization-provider-string-red.log` |
| `cargo test -p omni-gateway --lib shutdown_joins_gated -- --nocapture` (join omitted) | expected RED, 0 passed / 1 failed, pending row and dropped Finish=1; `stabilization-lifecycle-red.log` |
| `cargo test -p omni-providers --test coerced_arguments --test upstream_depth --test adapter_e2e` | GREEN: 6 adapter + 1 coercion/oracle + 5 depth tests; `stabilization-provider-green.log` |
| `cargo test -p omni-gateway --lib --test server` | GREEN: 30 unit + 32 HTTP server tests; `stabilization-gateway-green.log` |
| `cargo test -p omni-gateway --lib deadline_ownership` (after additional race test) | GREEN: all 4; `stabilization-lifecycle-green.log` |
| `cargo clippy -p omni-providers -p omni-gateway --all-targets -- -D warnings` | GREEN; `stabilization-clippy.log` |
| `cargo fmt --all -- --check` | GREEN |

Intermediate compile feedback: CollectedResponse is not Serialize; adapter regression switched to the existing Anthropic renderer. Strict clippy initially rejected unwraps; production locks recover poisoning consistently, test-only fixtures explicitly allow unwrap. Final commands above passed after these adjustments.

No benchmarks/performance refactoring or new readiness claim. Next action: controller-owned independent review of these commits, then separately scoped performance acceptance work.
