# B4 decode independent review

**Verdict: REQUEST CHANGES.** Reviewed detached `0868346647d3bd21b01b83e6108cb07e49887421`, against frozen `1780bb39`. No product edits or commits retained; no subagents used. All commands ran in the review checkout. No provider/network calls. Evidence directory: `/tmp/opencode/b4-decode-review/`.

## Findings

### Important — depth refusal changes successful frozen streams, including ignored fields

Frozen `packages/providers/src/antigravity/decode.ts:99–105,175–318`; Rust `crates/omni-providers/src/antigravity/decode.rs:98–103,301–303`.

Minimal boundary reproduction (notation expands to actual SSE bytes; full bytes retained in `targeted-input.jsonl`):

```
data: {"response":{"candidates":[{"finishReason":"STOP"}],"ignored":<39999 opening [ characters>0<39999 closing ] characters>}}

```

Total JSON depth is 40,001. Frozen yields `start("", "")`, then `end(endTurn, usage={inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0})`, no throw. Rust yields no events, then `Throw("upstream JSON exceeds depth 40000")`. Adapter exposes retryable `UPSTREAM: antigravity codec decode threw`, provider antigravity, gatewayAuthored true. Replacing `ignored` with `usageMetadata` gives the same difference. At 39,990 nested arrays both succeed and match.

Other minimized classes: `data: {"error":<40000 nested arrays around 0>}\n\n` has no serialization or deep walk in frozen: it emits `error(UPSTREAM,"upstream error",true)`; Rust throws before events. For args at 40,001 nesting, frozen emits start and tool blockStart before its stringify RangeError; Rust throws before either event (see `differences.json`). Therefore checking only threw/not **without the prefix** would miss a client commit-point change.

This is the same *shared bounded parser* limitation already used by OpenAI (`openai/decode.rs:124`); Anthropic uses a classified GatewayError at `anthropic/decode.rs:129–134`, rather than Throw. It is not a newly invented parser bound. However, the Antigravity decoder audit documents only successful in-bound depths and no observed stringify divergence; the ruling allowing Rust to succeed when frozen stringify fails **inside** the bound does not cover this opposite outcome on ignored fields. Document/obtain the explicit exception and pin all these cases, or preserve the frozen result. Sibling precedent alone does not establish byte-stream parity.

### Important — retained X1 text test fails in the oracle transport, not the decoder; coverage is incomplete

Frozen `decode.ts:258–277`; Rust `decode.rs:98–103,225–250`; test `tests/antigravity_decode.rs:79`.

SSE: `data: {"response":{"candidates":[{"content":{"parts":[{"text":"\ud800"}]},"finishReason":"STOP"}]}}\n\n`.

Frozen: start, text blockStart, lone-surrogate text delta, blockEnd, endTurn. Rust actual decoder: only retryable `UPSTREAM` truncation event, no throw (serde rejects the frame). But running the committed ignored text test fails earlier at `serde_json::from_slice(&run.stdout).expect("rows")`: `unexpected end of hex escape`. This test would remain red even if the decoder defect were repaired. Keep the X1 exception, but transport expected strings losslessly (e.g. UTF-16 units) so the retained-red test exercises and diagnoses the intended boundary.

`x1.log` confirms all three ignored tests fail, but only args and numeric overflow reach comparison. Extra independent probes found the same frame rejection for thinking text, tool name/id, args keys, responseId/modelVersion, error message/status, each usage field, and ignored fields. Those positions are not individually pinned by retained tests. In particular `data: {"response":{"candidates":[{"finishReason":"STOP"}],"ignored":"\ud800"}}\n\n` has entirely representable frozen output (start/end) yet becomes truncation in Rust. Likewise overflow in usage is counted as zero by frozen, not discarded along with the entire frame. These are broader consequences of parse-time X1 rejection, not additional arbitrary exemptions. Add named retained-red coverage and state the scope explicitly. No non-X1 ignored decode tests were found.

### Minor — u32 stream counters eventually panic or wrap

Frozen `decode.ts:138–139,226,255,268`; Rust `decode.rs:19–20,200,221,232`.

Symbolic minimal stream: repeat `data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x"}}]}}]}}\n\n` 2^32 times, then finish STOP. Frozen nextIndex/toolCalls remain exactly representable at this size. Rust debug overflows next_index on the 2^32-th call, before yielding that block; release wraps and reuses indices (tool_calls also wraps). It is not reachable in one bounded SSE frame but is reachable across an unbounded stream, since state counters persist. This is a static finding, not a 4-billion-frame experiment. Widen/check under an explicit resource policy; do not claim exact arbitrary-stream parity with u32 counters.

### Minor — first red commit subject and decoder audit overstate evidence

`8aef0f19` says “2 green 929 red”. Executing its exact test and reference source (temporary renamed targets, current unchanged Anthropic baseline dependency) gives **0 green / 931 red**, exit 101: `baseline.log`. The report's 0/931 is supported, the subject is not.

Audit `conformance/antigravity-migration.md`, decoder coercion table: `values[18]` is `{toString:null}`, correctly a throwing case. The table does not enumerate candidate-length numeric coercion or the later diagnostic String coercion as pinning rows; these are mentioned only in prose. It omits the hard depth-refusal literal, its error timing/client classification, u32 bounds, UTF-8/BOM/SSE resource exceptions, and the broader parse-time X1 positions above. No missing STOP_REASON or ERROR_CODE table entries were found. A thrown-text discrepancy alone is not a client discrepancy (see below).

## Line-by-line semantic assessment

* `??`: top error falls back on null or absent; nested response.error null is deliberately retained and throws after close. False/0/empty-string errors are retained and mapped as primitive payloads. Rust implements this. A null response throws; primitive responses yield empty start and eventually truncation. Arrays are valid parsed frames.
* `!== undefined`: blockReason null counts as present; functionCall null throws; failure null from nested response throws. `finishReason` separately excludes both absent and null. All checked against code and corpus.
* Candidates: nullish → []; array/string length versus object own `length`; blocked branch uses strict numeric zero, multiple-candidate branch numeric coercion. Missing length behaves as NaN in frozen versus null→0 in Rust, but both fail `>1` and strict-zero blocked check, with no observable difference here. Object `"0"` access works. String `[0]` differs internally (UTF-16 unit versus missing in Rust), but that unit has no content/finishReason, so no emitted difference. Numbers have neither length nor candidate.
* Parts: non-nullish non-iterable primitives/objects throw; arrays iterate; null array elements throw; strings iterate Unicode code points in JS, **not UTF-16 units for for…of**. Every iterated string has undefined functionCall/text, including surrogate units; skipping all string parts is observably equivalent on representable input. String length/indexing elsewhere is UTF-16-based.
* typeof name/text/string id guards match. Empty string names allowed; empty id falls back. Strict thought === true matches. FunctionCall takes precedence over text. Null args → `{}`, stringify order and JS number formatting go through shared jsjson.
* String coercions on arrays, nested arrays, booleans, numbers (-0/1e21/1e-7), ordinary objects and own non-callable toString checked. Object.hasOwn status/finish tables avoid prototype-name lookup errors. No discrepancy found in representable inputs. Errors close before status/message coercion; finishes close before finish String. Start sets started before id/model coercion but yields only after both succeed.
* Block indexing, kind transitions, immediate tool block closure, fc numbering including supplied ids, toolCalls override on all mapped reasons match the ordinary corpus/mutations. Blocked-before-start emits blank start; not setting started there is harmless because terminal stops the stream.
* Usage `as_f64().filter(is_finite)` matches typeof-number plus Number.isFinite; negative and fractional counts are retained, input alone clamped. Values above 2^53 are rounded to binary64 on both sides. Fourth `0.0` is cacheWriteTokens, exactly TS's default. Explicit probes: 9007199254740993, u64 max, -0, -1, .125, 1e21, 1e-7, max finite double including sum overflow. All semantically equal. Python arbitrary-precision JSON comparison initially flagged u64 max's decimal spelling; comparing binary64 numbers removes that false positive. No X1 normalization was performed.
* Duplicate keys last-win; serde preserve_order retains original position, matching JSON.parse. Upstream `__proto__` is an own data property under JSON.parse, **not** Object.assign's prototype setter. Tested duplicate error/response/candidates/functionCall and args with duplicate keys, numeric keys and __proto__. Equal.
* `self.open.expect` is protected by the immediately preceding None-or-kind branch; no input panic found. Immutable `response["usageMetadata"]` returns Null for missing/nonobject, not a panic. Deep length clones are wrapped in Owned; parsed frames use iterative drop.

## Throw handling and actual adapter boundary

Rust driver is `crates/omni-providers/src/adapter.rs:274–345`, not the gateway entry file. It drains pending events before failure, then sets finished and drops body. It does **not** call finish after Throw. Frozen `codecAdapter.ts:211–220` rethrows GatewayError and wraps other exceptions. Both produce retryable `UPSTREAM`, message `antigravity codec decode threw`, provider antigravity, gatewayAuthored true; raw TypeError text is hidden. Concrete pairs:

1. `data: {"response":null}\n\n`: no events; frozen TypeError vs Rust `Throw("null response")`; same adapter error, no truncation event.
2. `data: {"response":{"candidates":[{"content":{"parts":[null]}}]}}\n\n`: start blank; frozen TypeError vs Rust `Throw("null part")`; same adapter error after start, no blockEnd/truncation.
3. `data: {"response":{"responseId":{"toString":null}}}\n\n`: no events; frozen TypeError vs Rust coercion Throw; same adapter error.

These paired decoder results were independently executed (`direct/*` rows); adapter conclusions are source-derived, not an Antigravity gateway e2e run. For a prior open text block then failure.status={toString:null}, both retain blockEnd before the same guarded error. Terminal events stop feeding subsequent frames; post-throw behavior cannot append finish's truncation through the real driver. Therefore the committed comparison's full event prefix + threw/not is sufficient for these unclassified throws, though it must distinguish GatewayError and parser failures and cannot validate panic paths.

## Wiring, SSE and cloak

Trait decoder takes state.cloak by value, ignores headers exactly as frozen codec.ts:154–155 does, and constructs AntigravityDecoder. Inherent build_request is an explicit fully-qualified trait forward; no recursion or alternative path. Request-side scope ruling is outside this review. The header comment claiming a decoder is awaited is stale.

SSE parser and driver read-through verified: flush final unterminated record, CRLF, BOM once, no-space data, multiline fields, non-UTF-8 replacement, incomplete UTF-8 trailing bytes dropped (frozen never flushes TextDecoder), random splits inside é/emoji. Whitespace-surrounded DONE fails JSON.parse and is ignored anyway, hence mutation trimming DONE is equivalent. Decoder closes on terminal before later parser failure in same chunk is surfaced. State contains only cloak, flags/counters/open block: no cumulative text buffer. Output queue and per-frame JSON scale with one frame; parser caps records at 10 Mi UTF-16 units.

Unknown wire names pass unchanged. Independent random streams use duplicate wire-map entries (last wins), two aliases mapping to the same original, known/unknown names. Existing request-cloak round trip and full cloak tests passed. A specifically forced alias-collision request→decoder round trip was not independently constructed; cloak builder tests cover collisions, while decode is a direct HashMap lookup.

## Independent corpus and retained cases

`b4_review.ts` is a new deterministic generator (seed 918237), not derived from the committed case generator: 22,000 structured/random multiframe streams, changing frame/response/error/metadata/candidate/content/parts/call/id/name/args/text/thought/finish/coercion fields across JSON kinds; random byte chunking, terminal placement, malformed shape interleavings, BOM/CRLF and invalid trailing bytes; plus 8 depth and 4 direct rows. It uses frozen parseSse and decode; Rust harness follows incremental push/finish and stop/throw boundaries on a 2 MiB thread. Sources copied here before removing temporary files.

* Main: **22,012 / 22,008 equal / 4 different**, all >40,000-depth classes.
* Extra resources/X1: **34 / 4 equal / 30 different**; all differences are parse-time X1 consequences. `overflow/argskey` accidentally repeats the surrogate-key probe, not numeric overflow in a key (JSON keys cannot be numeric). Thus this is 30 rows, 29 distinct intended input classes.
* Targeted duplicate/usage/minimal-depth: **15 / 13 equal / 2 different**, two minimized depth reproductions.
* Combined: **22,061 streams / 22,025 equal / 36 different** = 6 depth rows + 30 X1 rows. No non-depth/non-X1 random discrepancy found.

Evidence: `oracle.jsonl`, `rust.jsonl`, `differences.json`, `extra-{input,oracle,rust-input,rust}.jsonl`, `extra-differences.json`, `targeted-{input,oracle,rust}.jsonl`. Extra oracle output cannot be fed whole to serde when expected events contain surrogates; stripping expected fields preserves raw byte chunks and fixes the review transport, without altering upstream inputs/results. The first failed reviewer run and its panic remain in `resource.log`; successful run is `resource-clean.log`. Initial generator syntax failure is also recorded; corrected run exited zero.

Frozen tests absent as *exact* committed fixtures: measured 61,244/57,309 cache hit and promptTokens recovery; blocked prompt carrying 12 usage tokens; explicit first id/model frame followed by hel/lo and final usage; cross-frame thought→text; function call followed by a later finish; no-cloak `Read` control. Their branch equivalents mostly exist (nonfinal-usage, alternation, cloak/unknown, count matrix). Independent fuzz supplies multiframe combinations, but the committed decoder corpus does not replace the measured billing fixtures verbatim.

## Depth/resource matrix

All reviewer decoder executions use a 2 MiB thread; parse, walk, serialize and frame drop execute inside it.

| Case | Frozen/Rust | Evidence |
|---|---|---|
| Args 100/1000/5000/10000/39990 | equal, original active test | gate.log, restored-test.log |
| Args/ignored/error/usageMetadata 39990 | all equal, no abort | main corpus depth rows |
| Same four positions 40001 | all differ; args TS stringify throws after prefix, other three TS succeeds | differences.json |
| 1000 calls in one frame | 3002 events equal; 0.05s, 11,516 KiB RSS | resource-calls-1000.log |
| 10000 calls | 30002 events equal; 0.51s, 91,208 KiB | resource-calls-10000.log |
| 100000 calls | 300002 events equal; 5.25s, 880,196 KiB | resource-calls-100000.log |
| 10 MiB text plus JSON/SSE overhead | both parser-refuse before events, identical cap/classification | extra rows, resource-text-10MiB.log |

Timing/RSS include the review's decimal-byte JSON transport, serde Value input, collecting events, serializing output; they are **not decoder-only memory measurements**. Scaling for calls is approximately linear; no quadratic behavior observed. High RSS is heavily inflated by transport and duplicate output representations. Direct decoder bypass of SSE cap with a 10 MiB part, many text-only parts, malformed deep parse-error disposal and isolated allocator profiling were not measured. Counter overflow is static analysis only. No production stack overflow observed.

## Verification, limitations, restoration

Before first build every crates/**/*.rs was touched; initial disk 19 GiB free, final 18 GiB. Builds offline, jobs=2, incremental=0, dev/test debug=0, package-scoped, one cargo command at a time. No branches switched. Frozen decode/SSE files had zero diff from 1780bb39.

* Build reviewer example: exit 0, `build.log`.
* Full scoped gate (`omni-providers`, `omni-ir`, `omni-crypto`): exit 0, **60 summaries / 240 passed / 0 failed / 12 ignored**, `gate.log`.
* 30 single-site mutations: 29 detected, 1 equivalent survivor, no compile-invalid mutants. Each ran only committed frozen_corpus. Details appended below; `mutate.py`, `mutations.json`, `mutation-*.log`.
* Retained ignored tests included: exit 101, **3 passed / 3 failed**, `x1.log`; expected retained-red failures, including broken text oracle transport.
* First red test reconstruction: exit 101, 0/931, `baseline.log`. Exact old test/reference on current Anthropic implementation, not a checkout/build of the entire historical tree.
* Post-restoration decoder test: exit 0, 3 passed / 3 ignored, `restored-test.log`.
* Clippy/fmt were not rerun; implementation claim not independently verified. No e2e/OAuth/registration work. No exhaustive proof for every byte stream is claimed. Generator broadness does not prove each possible path/type combination; its own invalid-shape assignments sometimes fall back to a different malformed frame.

Restoration proof: `restored-status.txt` is empty; `restored-head.txt` is `0868346647d3bd21b01b83e6108cb07e49887421`; `git diff --exit-code` returned 0. Temporary harness sources are preserved in evidence, removed from checkout. Mutator restored decode.rs in finally. No user evidence deleted.

## Mutation table

| # | Single-site mutation | Outcome | Exit |
|---|---|---|---|
| 1 | drop close | detected-by-test | 101 |
| 2 | default status | detected-by-test | 101 |
| 3 | rate code | detected-by-test | 101 |
| 4 | auth code | detected-by-test | 101 |
| 5 | timeout code | detected-by-test | 101 |
| 6 | error default | detected-by-test | 101 |
| 7 | candidate threshold | detected-by-test | 101 |
| 8 | blocked threshold | detected-by-test | 101 |
| 9 | start default | detected-by-test | 101 |
| 10 | model default | detected-by-test | 101 |
| 11 | mint prefix | detected-by-test | 101 |
| 12 | tool numbering | detected-by-test | 101 |
| 13 | indices | detected-by-test | 101 |
| 14 | thought strict | detected-by-test | 101 |
| 15 | stop map | detected-by-test | 101 |
| 16 | max map | detected-by-test | 101 |
| 17 | safety map | detected-by-test | 101 |
| 18 | tool override | detected-by-test | 101 |
| 19 | args default | detected-by-test | 101 |
| 20 | uncloak | detected-by-test | 101 |
| 21 | text kind | detected-by-test | 101 |
| 22 | usage prompt | detected-by-test | 101 |
| 23 | usage thoughts | detected-by-test | 101 |
| 24 | usage write | detected-by-test | 101 |
| 25 | eof message | detected-by-test | 101 |
| 26 | error null guard | detected-by-test | 101 |
| 27 | call null guard | detected-by-test | 101 |
| 28 | response null guard | detected-by-test | 101 |
| 29 | part null guard | detected-by-test | 101 |
| 30 | done equality | SURVIVED | 0 |

Mutation 30 changes exact DONE comparison to trim comparison; both spellings otherwise fail JSON.parse and are skipped, so this is an equivalent survivor, not evidence of missing behavior coverage.

## Log scan counts

Counts are matching lines, case-sensitive, for the requested regexes. Expected mutation/assertion failures and reviewer harness failures are retained, not product crashes.

| Log/group | `FAILED\|panicked\|^error` | `stack overflow\|SIGSEGV\|SIGABRT` |
|---|---:|---:|
| build.log | 0 | 0 |
| gate.log | 0 | 0 |
| oracle.log | 0 | 0 |
| rust.log | 0 | 0 |
| x1.log | 8 | 0 |
| baseline.log | 6 | 0 |
| restored-test.log | 0 | 0 |
| resource.log | 2 | 0 |
| resource-clean.log | 0 | 0 |
| mutation-*.log | 120 | 0 |
