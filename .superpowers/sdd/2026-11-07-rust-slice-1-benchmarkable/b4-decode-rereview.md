# B4 decoder re-review — REQUEST CHANGES

Reviewed detached `8bf97821615ea2e01cd6ae99af1149ef6a54c0b2` in rust-redis. No product edits retained, commits, subagents, provider traffic, or work in the other checkouts. Evidence paths below are relative to `/tmp/opencode/b4-decode-rereview/`.

## Earlier findings

| Finding | Status | Evidence |
|---|---|---|
| D1 bounded depth differs from frozen | **Closed under the controller's explicit exception** | `depth.log`: ten actual oracle rows, exact Rust prefix and Throw asserted; independent depth reproductions below |
| D2 transport cannot carry surrogate expected text | **Closed** | `x1.log`: 31 executions reach RED event comparison; no oracle transport failure. `green-proof.log`: injected expected output makes all three tests green |
| D2 every X1 consequence pinned | **Not closed** | new finishReason, blockReason and overflowing candidate length inputs differ and have no committed counterpart |
| u32 panic/wrap | **Closed under ruled bound** | checked arithmetic permits MAX itself; counter unit passes; defined terminal error on next allocation |
| inaccurate red subject | **Closed** | decoder audit now explicitly corrects 2/929 to 0/931 |
| six frozen fixtures absent | **Closed** | six new billing rows match frozen payloads; explicit prompt recovery assertion |

## Important — X1 coverage still omits decoder-specific consequences

Frozen `packages/providers/src/antigravity/decode.ts:180–189,203–217,280–307`; Rust `crates/omni-providers/src/antigravity/decode.rs:118–123` rejects the entire JSON frame before the corresponding branches. These are **parked X1**, not requests to repair the shared carrier. The outstanding requirement is named ignored retained-red coverage for each consequence.

Three independently executed minimal SSE inputs (each ends with two LF bytes):

1. `data: {"response":{"candidates":[{"finishReason":"\ud800"}]}}`
   Frozen: blank start, then nonretryable UPSTREAM `unrecognized Antigravity finish reason "<lone D800>"`; no throw. Rust: only retryable UPSTREAM `upstream stream ended before the response finished`; no throw.
2. `data: {"response":{"promptFeedback":{"blockReason":"\ud800"}}}`
   Frozen: blank start then contentFilter end with zero usage; no throw. Rust: same truncation error as above. This changes representable output although the offending string is not emitted.
3. `data: {"response":{"candidates":{"length":1e309}}}`
   Frozen: blank start then nonretryable UPSTREAM `Antigravity returned Infinity candidates, which cannot be represented`; no throw. Rust: same retryable truncation.

These are emitted events, not thrown exceptions; adapters therefore preserve these different event sequences and retryability. Actual paired outputs are in `new-differences.json`. Add ignored named rows through the repaired transport. Also absent: surrogate-bearing cloak map key/value consequences; those were inspected conceptually but not executed in this review. JSON bytes can carry escaped surrogates, whereas literal SSE event-line text passes through TextEncoder/UTF-8 replacement; the executed event-line surrogate control is equal and does not need a retained-red test.

## Minor — independent counter-flag behavior lacks pinning

`decode.rs:62–79,242–245` is correct by inspection: index exhaustion always blocks a new block; tool exhaustion blocks only tool allocation. MAX is returned before setting exhaustion; tool fc_MAX is emitted before setting tools_exhausted. Existing open same-kind text can continue without allocation. On exhaustion close precedes terminal nonretryable UPSTREAM, subsequent messages return Stop and finish does nothing.

The unit seeds **both** counters at MAX-1. Thus index exhaustion masks the tool-specific flag. Mutations deleting tools_exhausted, applying it to text, or changing allocate_index's tool boolean survive. In naturally reachable state tool_calls never exceeds allocated blocks, so tools_exhausted alone is not naturally reachable before index exhaustion; these survivors are not demonstrated production errors. A separately seeded unit would make the intended helper contract explicit. No off-by-one finding remains.

## D1 boundaries and client consequences

Independent arrays and objects in ignored position: total depth **40,000 accepted**, **40,001 refused**. Outer response objects count; a text string containing 50,000 `[` characters is accepted and byte-equal. `depth_of`, unlike `depth_bound`, ignores brackets inside JSON strings; decoder uses depth_of. Evidence: `new-{input,oracle,rust}.jsonl`.

Committed bounded-depth test enforces exactly ten rows and checks computed depth 40,001 (eight rows) or 40,009 (args themselves 40,001, two rows). It invokes the real frozen decoder; handwritten expected patterns additionally validate its actual output, not replace it. Every row must have an exact Throw diagnostic and preserved prior prefix; removing throwing cannot pass. It cannot pass vacuously with zero rows. Arbitrary duplicated/renamed oracle rows are not separately protected by a unique-name set, but current generator explicitly produces all ten combinations.

For each first-frame row, Rust emits nothing then Throw; after-text rows retain start/text blockStart/text delta only, **no blockEnd**, then Throw. Adapter wraps as retryable `UPSTREAM: antigravity codec decode threw`, preserving prefix. Frozen after-text closes block before the following result:

| Position | Frozen first/after-text result after applicable prefix/close |
|---|---|
| ignored | start if needed, endTurn, zero usage |
| usageMetadata | same |
| error | UPSTREAM upstream error, retryable true; no new start |
| args at total 40,001 | tool blockStart, exact 39,993-deep JSON delta, blockEnd, toolUse end |
| args nesting 40,001 | tool blockStart then stringify RangeError; adapter yields same guarded error, but with this extra prefix |

Retryable classification means a deterministic over-depth first response may be retried/fail over according to dispatch policy, although retrying identical content cannot fix the bound. Midstream prefix changes the commitment point. This is a consequence of the ruled exception, not a new ruling. Adapter conclusions are source-derived, not e2e executions.

## X1 transport and turns-green proof

Oracle JSON.stringify(event) text is ASCII escaped and placed inside an outer JSON string. Rust applies the same UTF-16-unit escaping to to_json output. Escaped lone surrogate sequences already in JSON text remain literal backslash sequences; supplementary Unicode becomes two unit escapes on both sides. No double-escaping discrepancy found.

All 30 named positions plus dedicated ignored repeat execute and print actual truncation versus frozen events (`x1.log`, 31 RED lines). Three ignored tests fail by final comparison assertion, not harness parsing. Temporary reviewer injection replaced actual comparison values with the oracle's expected event strings for every X1 row; all three tests passed (exit 0). This proves the comparison can turn green and the outer carrier works. It does not simulate a future surrogate-capable StreamEvent representation. The injection was removed and source restored.

For both surrogate/overflow classes the committed positions are text, thought, name, id, args, argskey, responseId, modelVersion, message, status, promptTokenCount, candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount, ignored. `overflow/argskey` intentionally duplicates surrogate-key input and is documented. Frozen exact events and Rust events for every position are retained in `extra-differences.json` from rerun comparison; original oracle rows were copied unchanged from earlier evidence, main/second-seed and new cases invoke frozen again. No non-X1 ignored decoder tests found.

## Fuzz and pins

Copied prior harnesses rather than modifying earlier evidence. Main seed 918237 was rerun; second seed 732941 rerun. Numeric comparison uses binary64 semantics (no surrogate/overflow normalization).

| Seed/set | Streams | Equal | Depth differences | X1 differences |
|---|---:|---:|---:|---:|
| 918237 complete prior set | 22,061 | 22,025 | 6 | 30 |
| 732941 new main + same fixed extras | 22,061 | 22,025 | 6 | 30 |
| new boundaries/X1 controls | 9 | 4 | 2 | 3 |

Second-seed randomized execution itself is 22,012 rows; fixed 49 extras are reused, not claimed independently regenerated. All 30 prior X1 rows have committed counterparts. All six prior depth rows have position-class counterparts; ignored/error/usage examples originally had slightly greater total nesting than committed boundary rows, but the ruled class and each position are pinned. New object-nesting boundary has no exact object-form committed row (same ruled bound). Three new X1 differences lack committed pins. No discrepancy outside ruled depth/X1 found. Cloak duplicate wire mappings/unknowns remain in randomized harness; `original()` still directly uses from_wire, unaffected by name_index. Decoder takes cloak by value and ignores headers as frozen; provided try_build_request does not change decoder construction.

## Fixtures and audit

All six payloads match frozen tests: measured cache 61244/57309 gives 3935 uncached, 12 output, zero writes; recovery equals 61244. Blocked gives input12. hel/lo fixture carries r1 and exact model then final 100/20/15/30 giving 70 input,35 output. Thought→text yields two block indices; Read args path=/a then later STOP gives toolUse; no-cloak Read retains name and ends truncated. Equality oracle plus explicit recovery pins these.

Audit has depth exception, counter literal/range, candidate numeric/string coercions, SSE resource behavior, all table mappings and erratum. Remaining omission is new X1 consequences above. Historic prose saying five-event args sequence is inaccurate (start + three tool events + end = five, actually correct); no finding there. Line numbers labeled “line at audit” are historical, not current. No further literal/table omissions identified.

## Gates and limitations

Full requested gate **does not pass in this checkout**: unrelated OpenAI wire oracle cannot resolve package `zod` from apps/gateway/src/ingress/anthropic.ts. Reproduced with explicit `bun --no-env-file` in provider directory, `openai-oracle.log`. No dependency installation or out-of-scope product change attempted. Gate stops at provider library, so 62/247/20 claim is not independently reproduced. Both initial and restored full runs fail identically: 15 summaries,119 passed,1 failed,1 ignored before stop.

Clippy all-targets and fmt pass; final decoder tests and counter pass. Requested command exits quoted below from .exit files. Some existing test-owned Bun subprocesses omit --no-env-file; all reviewer-issued Bun invocations include it and checkout has no .env.

Mutation execution had two invalid preliminary runs: first accidentally filtered out frozen_corpus; second was blocked before integration tests by unrelated OpenAI failure. Those logs are retained but **not counted**. Correct run executes antigravity_decode integration tests then isolated counter unit when integration passes: 45 mutations,39 detected,6 survived. Original 30:29 detected,1 equivalent survivor. New15:10 detected,5 tool-flag survivors. Timeout interrupted preliminary mutator; restored exact HEAD source before resuming. Valid table below uses only valid-mutation logs.

No exhaustive arbitrary-stream proof; no newly executed surrogate cloak-carrier test; no resource rerun beyond prior 100000-call and 10MiB fixed rows. No gateway build. No forced alias request round trip beyond committed test and ordinary cloak suite reading. Disk stayed above 14GiB free.

Restoration: restored-status.txt empty, restored-head.txt = 8bf97821615ea2e01cd6ae99af1149ef6a54c0b2; git diff --exit-code =0. All temporary harness sources removed, copied evidence preserved. Final decoder and counter runs executed after restoration.

## Exact gate exits

```
cargo test --offline -p omni-providers -p omni-ir -p omni-crypto exit=101
cargo test --offline -p omni-providers -p omni-ir -p omni-crypto exit=101
cargo clippy --offline -p omni-providers -p omni-ir -p omni-crypto --all-targets -- -D warnings exit=0
cargo fmt --all -- --check exit=0
cargo test --offline -p omni-providers --test antigravity_decode -- --ignored --nocapture exit=101
cargo test --offline -p omni-providers --test antigravity_decode bounded_depth_expected_divergence -- --nocapture exit=0
cargo test --offline -p omni-providers --test antigravity_decode -- --ignored --nocapture [expected injection] exit=0
cargo test --offline -p omni-providers --test antigravity_decode exit=0
cargo test --offline -p omni-providers --test antigravity_decode --lib counter_exhaustion_is_terminal exit=0
```

## Valid mutation table

| # | Mutation | Result |
|---|---|---|
| 1 | drop close | detected-by-test |
| 2 | default status | detected-by-test |
| 3 | rate code | detected-by-test |
| 4 | auth code | detected-by-test |
| 5 | timeout code | detected-by-test |
| 6 | error default | detected-by-test |
| 7 | candidate threshold | detected-by-test |
| 8 | blocked threshold | detected-by-test |
| 9 | start default | detected-by-test |
| 10 | model default | detected-by-test |
| 11 | mint prefix | detected-by-test |
| 12 | tool numbering | detected-by-test |
| 13 | indices | detected-by-test |
| 14 | thought strict | detected-by-test |
| 15 | stop map | detected-by-test |
| 16 | max map | detected-by-test |
| 17 | safety map | detected-by-test |
| 18 | tool override | detected-by-test |
| 19 | args default | detected-by-test |
| 20 | uncloak | detected-by-test |
| 21 | text kind | detected-by-test |
| 22 | usage prompt | detected-by-test |
| 23 | usage thoughts | detected-by-test |
| 24 | usage write | detected-by-test |
| 25 | eof message | detected-by-test |
| 26 | error null guard | detected-by-test |
| 27 | call null guard | detected-by-test |
| 28 | response null guard | detected-by-test |
| 29 | part null guard | detected-by-test |
| 30 | done equality | SURVIVED |
| 31 | bound guard | detected-by-test |
| 32 | ignore tool flag | SURVIVED |
| 33 | tool flag affects text | SURVIVED |
| 34 | bound retry | detected-by-test |
| 35 | bound code | detected-by-test |
| 36 | bound literal | detected-by-test |
| 37 | index exhaustion flag | detected-by-test |
| 38 | tool exhaustion flag | SURVIVED |
| 39 | allocate tool as text | SURVIVED |
| 40 | allocate text as tool | SURVIVED |
| 41 | return zero index | detected-by-test |
| 42 | same kind filter | detected-by-test |
| 43 | terminal flag | detected-by-test |
| 44 | tool advance | detected-by-test |
| 45 | index advance | detected-by-test |

## Log scan (matching lines)

| Log | FAILED/panicked/^error | stack overflow/SIGSEGV/SIGABRT |
|---|---:|---:|
| build.log | 0 | 0 |
| clippy.log | 0 | 0 |
| depth.log | 0 | 0 |
| final-counter.log | 0 | 0 |
| final-decoder.log | 0 | 0 |
| fmt.log | 0 | 0 |
| full-mutations.log | 0 | 0 |
| gate.log | 4 | 0 |
| green-proof.log | 0 | 0 |
| mutations.log | 0 | 0 |
| openai-oracle.log | 1 | 0 |
| restored-gate.log | 4 | 0 |
| valid-mutation-01.log | 5 | 0 |
| valid-mutation-02.log | 4 | 0 |
| valid-mutation-03.log | 4 | 0 |
| valid-mutation-04.log | 4 | 0 |
| valid-mutation-05.log | 4 | 0 |
| valid-mutation-06.log | 5 | 0 |
| valid-mutation-07.log | 4 | 0 |
| valid-mutation-08.log | 4 | 0 |
| valid-mutation-09.log | 10 | 0 |
| valid-mutation-10.log | 10 | 0 |
| valid-mutation-11.log | 7 | 0 |
| valid-mutation-12.log | 4 | 0 |
| valid-mutation-13.log | 4 | 0 |
| valid-mutation-14.log | 4 | 0 |
| valid-mutation-15.log | 4 | 0 |
| valid-mutation-16.log | 4 | 0 |
| valid-mutation-17.log | 4 | 0 |
| valid-mutation-18.log | 7 | 0 |
| valid-mutation-19.log | 4 | 0 |
| valid-mutation-20.log | 6 | 0 |
| valid-mutation-21.log | 4 | 0 |
| valid-mutation-22.log | 4 | 0 |
| valid-mutation-23.log | 4 | 0 |
| valid-mutation-24.log | 7 | 0 |
| valid-mutation-25.log | 4 | 0 |
| valid-mutation-26.log | 4 | 0 |
| valid-mutation-27.log | 4 | 0 |
| valid-mutation-28.log | 4 | 0 |
| valid-mutation-29.log | 4 | 0 |
| valid-mutation-30.log | 0 | 0 |
| valid-mutation-31.log | 4 | 0 |
| valid-mutation-32.log | 0 | 0 |
| valid-mutation-33.log | 0 | 0 |
| valid-mutation-34.log | 4 | 0 |
| valid-mutation-35.log | 4 | 0 |
| valid-mutation-36.log | 4 | 0 |
| valid-mutation-37.log | 4 | 0 |
| valid-mutation-38.log | 0 | 0 |
| valid-mutation-39.log | 0 | 0 |
| valid-mutation-40.log | 0 | 0 |
| valid-mutation-41.log | 4 | 0 |
| valid-mutation-42.log | 4 | 0 |
| valid-mutation-43.log | 4 | 0 |
| valid-mutation-44.log | 7 | 0 |
| valid-mutation-45.log | 4 | 0 |
| valid-mutations.log | 0 | 0 |
| x1.log | 8 | 0 |

## X1 row comparison index

All rows below have Rust output `[error UPSTREAM, truncation, retryable=true]`, no throw. Frozen complete events are recorded losslessly in extra-oracle.jsonl; shorthand here avoids replacing lone units.

| Row | Frozen event types | Frozen throw |
|---|---|---|
| X1/surrogate/text | start, blockStart, blockDelta, blockEnd, end | None |
| X1/surrogate/thought | start, blockStart, blockDelta, blockEnd, end | None |
| X1/surrogate/name | start, blockStart, blockDelta, blockEnd, end | None |
| X1/surrogate/id | start, blockStart, blockDelta, blockEnd, end | None |
| X1/surrogate/args | start, blockStart, blockDelta, blockEnd, end | None |
| X1/surrogate/argskey | start, blockStart, blockDelta, blockEnd, end | None |
| X1/surrogate/responseId | start, end | None |
| X1/surrogate/modelVersion | start, end | None |
| X1/surrogate/message | error | None |
| X1/surrogate/status | error | None |
| X1/surrogate/promptTokenCount | start, end | None |
| X1/surrogate/candidatesTokenCount | start, end | None |
| X1/surrogate/thoughtsTokenCount | start, end | None |
| X1/surrogate/cachedContentTokenCount | start, end | None |
| X1/surrogate/ignored | start, end | None |
| X1/overflow/text | start, end | None |
| X1/overflow/thought | start, end | None |
| X1/overflow/name | start, end | None |
| X1/overflow/id | start, blockStart, blockDelta, blockEnd, end | None |
| X1/overflow/args | start, blockStart, blockDelta, blockEnd, end | None |
| X1/overflow/argskey | start, blockStart, blockDelta, blockEnd, end | None |
| X1/overflow/responseId | start, end | None |
| X1/overflow/modelVersion | start, end | None |
| X1/overflow/message | error | None |
| X1/overflow/status | error | None |
| X1/overflow/promptTokenCount | start, end | None |
| X1/overflow/candidatesTokenCount | start, end | None |
| X1/overflow/thoughtsTokenCount | start, end | None |
| X1/overflow/cachedContentTokenCount | start, end | None |
| X1/overflow/ignored | start, end | None |
