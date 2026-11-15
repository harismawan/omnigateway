# Connection reuse fix — completed
- Commit: `21ccf9be` on `fix/upstream-conn-reuse`; no push/merge.
- Failing-first: `connection_reuse::{anthropic_stream_reuses,anthropic_buffered_reuses}` each observed 20 sockets / 20 requests, expected exactly 1; custom controls each observed 1/20. `/tmp/opencode/diag/fix1-http-before.log` (4 pass, 2 fail, 1 ignored).
- After: all four modes observed 1/20; `/tmp/opencode/diag/fix1-http-after.log` (6 pass, 1 ignored). Exactly one is expected because requests are sequential to one origin with fully delivered Content-Length framing.
- Tests use real HTTP client requests through gateway server/dispatch, adapter and pooled client; origin-only wrapper and persistent upstream follow existing dispatch_depth/server fixtures. Plain TCP: those fixtures have no TLS helper; TLS reuse was not independently measured here.
- Generic invariant lives in `crates/omni-providers/src/adapter.rs:306–343`: detecting newly pushed End invokes existing stop()/finish_if_ready before delivering events. This covers decoders independently of their Flow return; no pool/TLS/timeout/still_idle changes.
- Already-parsed messages in the current chunk are still decoded. An initial immediate-return implementation failed the custom Responses repeated-terminal conformance vector; preserving these buffered messages makes the existing suite pass.

## Decoder audit (paths relative to crates/omni-providers/src)
| Decoder | Terminal emission and return |
|---|---|
| Anthropic | anthropic/decode.rs:306 End at message_stop; :344 Continue. |
| Custom chat | custom/decode/chat.rs:318 End at [DONE]; :323 Stop. Fast payload processing returns Continue (:296); termination uses the same outer decoder. |
| Custom Responses | custom/decode/responses.rs:265 End at response completion/incomplete success; :299 Continue. :118 Stop is malformed input, not successful completion. |
- No other provider decoder implementations found; custom/decode/fast.rs is the chat payload fast path.

## Negative cases and compatibility
- Truncated Content-Length before terminal: 2 sockets / 2 requests for each provider and each ingress mode.
- Actual downstream TCP disconnect after a streamed delta: 2/2 for each provider; no downstream [DONE] before disconnect.
- Frozen Anthropic decode.ts:355–406 yields End then keeps decoding later records (including errors). Dispatch already stops on End, so later events are unobservable to gateway clients (inference from dispatch). Same-chunk decoder output is retained; later network chunks are no longer decoded after End.
- Existing provider conformance/decoder tests pass. No client-visible content change observed; tests check successful content and streaming completion, not a new full wire-byte differential.

## Delayed terminator (proposal only)
- Ignored `delayed_chunked_terminator_reuses`: body chunk then 20 ms delay before zero chunk; manually run, observed 20 sockets / 20 requests, expected 1, failed as intended. `/tmp/opencode/diag/fix1-delayed.log`.
- Ignore reason names finish_if_ready's no-network-wait limitation. No drain implementation added.
- Frozen gateway: not observed for this fixture; available delayed2 files were result logs/count, not a directly reusable executable fixture. Avoided rebuilding the separate namespace benchmark setup.
- Proposal 1: transfer body/connection ownership after successful End to a pool-owned drain worker, independent of request lifetime; never check in before framing completion.
- Proposal 2: bound each drain to 64 KiB and 100 ms, with 32 concurrent drains per client; close immediately when capacity is unavailable (proposed starting values, unmeasured).
- Proposal 3: cancellation before End closes immediately; after ownership transfer, downstream cancellation must not cancel the bounded drain.
- Proposal 4: upstream error, timeout, byte limit, malformed framing or extra buffered bytes after terminator closes the connection; clean exact framing alone permits check-in.
- Proposal 5: tests count sockets for delayed success and all rejection paths, prove bounds/concurrency caps, no unread-byte contamination, and cancellation both before/after handoff.

## Gates and remaining limits
- `cargo test --offline -p omni-providers -p omni-gateway`: exit 0; 312 passed, 0 failed, 6 ignored across 60 emitted summaries (includes subprocess summaries). `/tmp/opencode/diag/fix1-gates-test.log`.
- Clippy all targets with -D warnings: exit 0; `/tmp/opencode/diag/fix1-clippy.log`. fmt --all -- --check: exit 0; `/tmp/opencode/diag/fix1-fmt.log`.
- No known timing-sensitive test failed. Initial clippy rejected test unwraps; replaced with expect. Initial conformance failure described above was resolved before final gates.
- Not established: frozen delayed-terminator count, live-provider/TLS behavior, concurrent reuse counts, or complete downstream wire-byte identity. Responses shares the generic fix but has conformance coverage rather than its own socket-count control here.
