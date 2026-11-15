# B4 decoder round 3 — APPROVE

Reviewed detached **38c7b5dea409a2372384f5b2caab3aad3bb4714e**, frozen oracle **1780bb39**. Overall decoder verdict across all three rounds: **APPROVE under the controller's rulings**. No Critical or Important finding. One nonblocking Minor test-coverage finding below. Evidence paths are relative to `/tmp/opencode/b4-decode-review3/`.

Read both prior reports first. No product changes, commits, subagents, provider traffic, other worktree execution, dependency installation, environment/config access or evidence deletion. All builds ran offline in rust-postgres with its own target, jobs=2, incremental=0, dev/test debug=0, one cargo command at a time. Every crates/**/*.rs was touched before first build. Disk started/stayed about 13 GiB available (never below 5). Every reviewer-issued Bun command used --no-env-file. Frozen decode.ts and sse.ts unchanged from 1780bb39 (`frozen-proof.exit=0`).

## Open items

### Three new X1 consequences — CLOSED

New dedicated ignored tests are decode test lines 190–205; generator lines 69–72. All three expected event sequences equal independently regenerated frozen output on the original round-2 raw SSE inputs: `x1-oracle-proof.txt`, `committed-x1.json`, `new-oracle.jsonl`. ASCII-escaped event JSON is preserved without parsing surrogate-bearing expected strings through serde. No normalization or carrier fix.

Each SSE below ends in `\n\n`. Frozen/Rust both do not throw. Frozen locations decode.ts:180–189,203–217,280–307; Rust rejection decode.rs:117–123, then finish:331–339.

| SSE data JSON | Frozen actual events | Rust actual events | Client result |
|---|---|---|---|
| `{"response":{"candidates":[{"finishReason":"\ud800"}]}}` | blank start; UPSTREAM `unrecognized Antigravity finish reason "<lone D800>"`, retryable false | only UPSTREAM `upstream stream ended before the response finished`, retryable true | frozen exposes nonretryable error after start; Rust exposes retryable truncation |
| `{"response":{"promptFeedback":{"blockReason":"\ud800"}}}` | blank start; contentFilter end, all usage zero | same retryable truncation | frozen completes filtered response; Rust errors/retry eligible |
| `{"response":{"candidates":{"length":1e309}}}` | blank start; UPSTREAM `Antigravity returned Infinity candidates, which cannot be represented`, retryable false | same retryable truncation | frozen exposes nonretryable error after start; Rust retry eligible |

`x1-serial.log` has **37 RED row executions**, 33 named rows plus four repeats, six failing tests at the final comparison assertion. All actual values are exactly the truncation event, threw=false; no oracle transport failure. `green-proof.log` feeds the Rust comparison side the oracle's expected event strings for X1 modes: **six tests pass / 37 green comparisons**. Injection preserved thrown checking and the rest of the harness and was restored. This proves the comparisons turn green, not that a future shared IR implementation has been simulated.

### Cloak-map statement — TRUE under the request-side X1 ruling

`codec.rs:82` builds cloak once from ChatRequest before wire construction. `cloak.rs:54–84` gathers portable tool names, ToolUse names, orphan ToolResult tool_use_id, and explicit ToolChoice name. All are String/&str. Provider-owned tools are skipped; vendor bags are never read by cloak construction. Vendor Object.assign in wire.rs:356 cannot mutate cloak. Aliases are ASCII plus hash suffix; from_wire keys/values are HashMap<String,String>. No safe external direct construction or upstream decode path can introduce a lone surrogate. Frozen cloak.ts:78–111 uses the corresponding request fields; its possible surrogate original value is already a request-side X1, pinned before cloak construction by antigravity_x1.rs:60 x1_tool_name. No new independently reachable decoder cloak consequence.

### Counter flag removal — CLOSED

Line-by-line assessment is in `review-notes.md`. allocate_index lines 61–78 first rejects only an already exhausted index, closes open block, sets terminal via error, emits exact UPSTREAM/nonretryable bound literal and returns None. Otherwise it returns the OLD index, checked-increments or sets exhaustion on MAX. No panic/wrap and MAX itself is emitted. Tools lines 216–243 close first, allocate before emitting, preserve supplied nonempty id or derive fc_<prior tool count>, emit start/delta/end then saturating_add. Frozen lines 226,237,254 use nextIndex++, fc_<toolCalls>, toolCalls++; this count includes calls with supplied ids. Thus last all-tool ids fc_4294967294/fc_4294967295 are correct, exactly representable as doubles.

Invariant: completed tool calls <= allocated blocks until saturation. Reaching mathematical tool count MAX+1 requires all MAX+1 permitted blocks to be tools; index_exhausted is already set. No next tool allocation can observe saturated count as an id. Saturation preserves >0 for final toolUse. Therefore tools_exhausted never independently gates a reachable allocation; removing it and the tool parameter is correct, rather than seeding an impossible state.

Text lines 250–277 reuse an open same-kind block without allocating. At MAX it can continue emitting deltas even with index_exhausted=true; a different kind or tool closes it then errors on next allocation. The continuing-text unit explicitly tests the extra thinking delta at MAX, exact close/error ordering and later message/finish silence. Four unit scenarios cover all-tool, alternating text, mixed, continuing-text histories. Ordinary behavior is unchanged by the removed redundant flag/parameter; two-seed regression confirms it.

## Minor — final permitted tool completion is not pinned by committed boundary test

This is a coverage gap, **not a product defect**. Current saturating code is correct. Mutation `saturating_add(1)` → `wrapping_add(1)` survives the committed corpus and counter unit: the unit always attempts a forbidden next allocation, masking the final count's use in stopReason. Likewise overflow-to-zero survives. This is unlike round 2's independently unreachable flag survivors: a normal finish after the last permitted tool is reachable.

Frozen source decode.ts:237,254,315; Rust decode.rs:242,309–313; unit lines 349–429. Symbolic minimal paired reproduction: after 4,294,967,295 prior tool blocks, feed `data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x"}}]},"finishReason":"STOP"}]}}\n\n`. Frozen emits blank start (seeded fresh started state), tool blockStart(index=4294967295,id=fc_4294967295,name=x), toolJson("{}"), blockEnd, end(toolUse,zero usage), no throw. Current Rust matches; wrapped MUTANT emits the same prefix but end(endTurn). Client frozen/current signals tool result expected, mutant signals conversation over. Existing-start prefix can be omitted with started=true without changing the consequence. This is symbolic counter seeding rather than claiming a billions-frame execution.

Independent seeded frozen execution `boundary-oracle.json` confirms the above sequence using copied frozen source with only counter initializers changed. Temporary reviewer unit `survivor_proof.py` passes original and fails wrapping mutant (`survivor-original.exit=0`, `survivor-wrapping.exit=101`). Suggested follow-up: retain a boundary finish assertion checking toolUse after MAX. Approval is not blocked because the production implementation is correct and the requested dead-flag removal is justified.

## Regression

Copied prior scripts into this evidence directory; fresh frozen runs for both seeds AND fixed extras/targeted rows. Comparison uses binary64 numeric semantics; neither X1 nor input/output is normalized. Temporary Rust harness uses the SSE incremental path and 2 MiB worker stack. Complete pairs and difference lists are `{918237,732941,extra,targeted,new}-{oracle,rust}.jsonl` and `*-differences.json`.

| Seed | Random/main rows | Fixed extras | Total | Equal | Different | Classification |
|---|---:|---:|---:|---:|---:|---|
| 918237 | 22,012 | 49 | 22,061 | 22,025 | 36 | 30 X1 + 6 depth |
| 732941 | 22,012 | same 49 | 22,061 | 22,025 | 36 | 30 X1 + 6 depth |
| prior new boundary/X1 controls | 9 | — | 9 | 4 | 5 | 3 X1 + 2 depth |

Every X1 extra has exact committed named input and expected event counterpart (`counterparts.txt`). Four main depth positions args/ignored/error/usageMetadata and two targeted ignored/usage cases have position-class counterparts among the ten committed bounded-depth rows. New object-form >bound control has no exact object-form fixture but belongs to the same explicitly ruled parser-depth class; array/object boundary, 40,000 accepted / 40,001 refused, and bracket-string control reproduced. **No unruled or unpinned consequence found**. Fixed extras are shared, not claimed as independently randomized for both seeds.

## Audit and scope

Read decoder section through EOF against frozen and Rust. Depth exception includes literal, client retry consequence and preserved unclosed prefix; counter policy and IDs accurate; new X1 consequences and cloak statement supported; exact six frozen billing fixtures retained. No stale unsupported substantive statement requiring changes.

Minor prose precision: line 191 'All call string' is too broad for candidate-length numeric coercion, which calls try_to_number directly (193–194 clarify). '33 distinct X1 rows' means distinct names, not 33 distinct SSE byte strings: overflow/argskey duplicates surrogate/argskey, explicitly disclosed. Historical 'line at audit' locations are not current line numbers. 'No stack-limit divergence observed' is limited to preceding in-bound probes, not a denial of the documented B1 difference.

Request audit prefix is **byte-identical** to 998eab1c, SHA256 cba27596a6cba643f5762be64b8a6f94e23ae37a8cbbee8e3659f9e3fe6ad232 (`request-proof.txt`). `diff-stat.txt` confirms only four files: decode.rs +52/-18; decoder Rust/TS tests; conformance audit. No request product changes in the range. Frozen sources unchanged.

## Mutation table

Each mutation starts from exact HEAD and is restored finally. Tests are active antigravity_decode integration corpus (not a filter accidentally excluding frozen_corpus), then counter_exhaustion_is_terminal if integration passes. No compile-error kill counted. R2 prefix denotes all ten still-applicable round-2 counter mutations, adapting guard/tool advance to new code. Five old tool-flag/parameter mutations no longer apply because their subject was removed.

| # | Mutation | Result |
|---|---|---|
| 1 | R2 bound guard | detected |
| 2 | R2 bound retry | detected |
| 3 | R2 bound code | detected |
| 4 | R2 bound literal | detected |
| 5 | R2 index exhaustion flag | detected |
| 6 | R2 return zero index | detected |
| 7 | R2 same kind filter | detected |
| 8 | R2 terminal flag | detected |
| 9 | R2 tool advance | detected |
| 10 | R2 index advance | detected |
| 11 | tool +2 | detected |
| 12 | tool reset | detected |
| 13 | tool wrapping | SURVIVED |
| 14 | tool unchecked | detected |
| 15 | premature tool saturation | detected |
| 16 | gate tool at MAX | detected |
| 17 | omit tool allocation | detected |
| 18 | omit text allocation | detected |
| 19 | index +2 | detected |
| 20 | early exhaustion | detected |
| 21 | continuation allocates | detected |
| 22 | tool off by one id | detected |
| 23 | tool uses block count id | detected |
| 24 | bound Continue | detected |
| 25 | lose text close | detected |
| 26 | tool saturating subtract | detected |
| 27 | tool constant MAX | detected |
| 28 | tool constant MAX-1 | detected |
| 29 | tool constant one | detected |
| 30 | tool double | detected |
| 31 | tool overflow zero | SURVIVED |
| 32 | tool overflow decrement | SURVIVED |
| 33 | tool equivalent checked | SURVIVED |

**33 mutations: 29 detected / 4 SURVIVED / 0 build errors.** At least 15 directly modify changed allocation-call/guard/tool-increment lines. Equivalent checked-add-with-MAX fallback survives appropriately; wrapping/zero-fallback expose the Minor coverage gap above; overflow fallback MAX-1 retains nonzero and cannot affect another id after index exhaustion, so is behaviorally equivalent on reachable streams. See separate JSON tables and per-mutation logs.

## Gates (exit values read from .exit files)

The package gate ran once and passed, 62 summaries / 248 passed / 0 failed / 26 ignored. No admitted_drain flaky failure or rerun. Initial clippy=101/fmt=1 were reviewer harness contamination only (unformatted temporary example with unwrap lint); `harness-{clippy,fmt}` preserves those logs. Example removed before final gates below. Ignored run intentionally red, not a gate claimed green.

- `cargo test --offline -p omni-providers -p omni-ir -p omni-crypto` **exit=0** (`gate.exit`).
- `cargo clippy --offline -p omni-providers -p omni-ir -p omni-crypto --all-targets -- -D warnings` **exit=0** (`clippy.exit`).
- `cargo fmt --all -- --check` **exit=0** (`fmt.exit`).
- `cargo test --offline -p omni-providers --test antigravity_decode -- --ignored --nocapture` **exit=101** (`x1.exit`).
- `cargo test --offline -p omni-providers --test antigravity_decode -- --ignored --nocapture --test-threads=1` **exit=101** (`x1-serial.exit`).
- `cargo test --offline -p omni-providers --test antigravity_decode -- --ignored --nocapture --test-threads=1 [expected injection]` **exit=0** (`green-proof.exit`).
- `cargo test --offline -p omni-providers --test antigravity_decode` **exit=0** (`final-decoder.exit`).
- `cargo test --offline -p omni-providers --lib counter_exhaustion_is_terminal` **exit=0** (`final-counter.exit`).

Log scan of `FAILED|panicked|^error` and case-insensitive `stack overflow|SIGSEGV|SIGABRT`:

| Log | Failure-pattern lines | Crash-pattern lines |
|---|---:|---:|
| boundary-oracle.log | 0 | 0 |
| build.log | 0 | 0 |
| clippy.log | 0 | 0 |
| compare.log | 0 | 0 |
| extra-mutation-01.log | 7 | 0 |
| extra-mutation-02.log | 4 | 0 |
| extra-mutation-03.log | 4 | 0 |
| extra-mutation-04.log | 4 | 0 |
| extra-mutation-05.log | 7 | 0 |
| extra-mutation-06.log | 0 | 0 |
| extra-mutation-07.log | 0 | 0 |
| extra-mutation-08.log | 0 | 0 |
| extra-mutations.log | 0 | 0 |
| final-counter.log | 0 | 0 |
| final-decoder.log | 0 | 0 |
| finish-checks.log | 0 | 0 |
| fmt.log | 0 | 0 |
| gate.log | 0 | 0 |
| green-proof.log | 0 | 0 |
| harness-clippy.log | 15 | 0 |
| harness-fmt.log | 0 | 0 |
| mutation-01.log | 4 | 0 |
| mutation-02.log | 4 | 0 |
| mutation-03.log | 4 | 0 |
| mutation-04.log | 4 | 0 |
| mutation-05.log | 4 | 0 |
| mutation-06.log | 4 | 0 |
| mutation-07.log | 4 | 0 |
| mutation-08.log | 4 | 0 |
| mutation-09.log | 7 | 0 |
| mutation-10.log | 4 | 0 |
| mutation-11.log | 4 | 0 |
| mutation-12.log | 7 | 0 |
| mutation-13.log | 0 | 0 |
| mutation-14.log | 4 | 0 |
| mutation-15.log | 4 | 0 |
| mutation-16.log | 4 | 0 |
| mutation-17.log | 4 | 0 |
| mutation-18.log | 4 | 0 |
| mutation-19.log | 4 | 0 |
| mutation-20.log | 4 | 0 |
| mutation-21.log | 4 | 0 |
| mutation-22.log | 7 | 0 |
| mutation-23.log | 4 | 0 |
| mutation-24.log | 4 | 0 |
| mutation-25.log | 4 | 0 |
| mutations.log | 0 | 0 |
| prepare.log | 0 | 0 |
| survivor-original.log | 0 | 0 |
| survivor-proof.log | 0 | 0 |
| survivor-wrapping.log | 4 | 0 |
| x1-serial.log | 14 | 0 |
| x1.log | 14 | 0 |

Failures occur in intentional red X1/mutation/coverage-proof runs and the preliminary harness lint failure only; final ordinary gates are clean. No production stack overflow/SIGSEGV/SIGABRT observed.

## What approval rests on / parked items

1. **X1 shared carrier parked:** lone UTF-16 surrogates and numbers beyond double range reject the whole frame, even in ignored fields. Rust may change successful/filtered/nonretryable frozen responses into retryable truncation. All 33 named decoder rows retain frozen expectations and fail for the right reason; do not fix or normalize here. Request-side surrogate cloak inputs remain request-side X1.
2. **B1 bounded JSON difference:** above total depth 40,000 Rust refuses before any event of that frame, with Throw("upstream JSON exceeds depth 40000") wrapped as retryable antigravity codec decode threw; prior prefix remains unclosed. Ten committed rows pin frozen actual outputs/throw prefixes and Rust refusal. This can change client commitment/retry and stringify timing. Accepted depth and bracket-string controls match.
3. **u32 resource policy:** MAX itself emitted; the next allocation closes open block then exact terminal nonretryable UPSTREAM bound error; later frames/finish add nothing. Same-kind existing text can continue without allocating. Frozen can continue beyond this bound. No need for independently unreachable tools_exhausted flag.
4. Inherited SSE resource/UTF-8 policy (including 10,485,760 UTF-16-unit record cap) remains unchanged, not a new decoder divergence. Unclassified raw Throw diagnostic text may differ but adapter wraps both as retryable codec decode threw, preserving emitted prefixes.

No exhaustive arbitrary-stream proof, real 4-billion-message run, new allocator profiling/resource stress beyond reusing fixed corpus, provider/gateway e2e, or shared-IR X1 repair. Adapter consequences are source-derived, not live provider executions. Review does not reapprove request implementation or gateway registration/OAuth integration. Minor missing boundary-finish assertion noted, not silently counted equivalent.

## Restoration

All temporary product/test injections restored; temporary example removed. `restored-status.txt` is empty; `restored-head.txt` is 38c7b5dea409a2372384f5b2caab3aad3bb4714e. Final decoder/counter/clippy/fmt rerun on restored sources. No commits or retained checkout modifications.
