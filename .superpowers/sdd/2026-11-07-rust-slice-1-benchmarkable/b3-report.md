# B3 OpenAI / Codex

Status: **step 3 INCOMPLETE**. Item 1 parked under X1 by controller, disposition commit `01c1a3a3`. Item 2 rows committed `03667f76`, revealing a separate public Usage representation mismatch; not parked/accepted. Items 3–5 pending, step 4 not started. Next: controller decision on malformed output/cache counts (public f64 Usage cannot represent TS string/object/array/bool). No public IR or production changes made. Worktree clean.

## Latest checkpoint: X1 disposition and malformed coercion
- `01c1a3a3`: ignored reason exactly `parked: roadmap X1 (lossless UTF-16 stream text)`. Known difference: an upstream event containing an unpaired surrogate escape is dropped. Text/tool-arguments/native-item fixtures followed by valid completion succeed with missing content/empty input/empty native payload; they do NOT end in error. Dropped upstream error becomes premature-completion error. Library buffered renderers ignore errors; no gateway HTTP-path observation claimed. Updated `conformance/openai-lossless-blocker.md`.
- `03667f76`: 61 new rows, first-run RED `coercion-first-red.log`. Index 9, nonstring delta 9, nonobject terminal response 9, missing item/type 7 all match. Usage 27: 19 match, eight remain RED. Full details in committed `conformance/openai-coercion.md`.
- Actual failures: output_tokens and cached_tokens each as string "2", object {}, array [], boolean true. Frozen TS preserves raw values; Rust f64 Usage coerces to 2/NaN/0/1. Buffered totals can differ through JS concatenation/coercion. This is an existing shared IR exception, NOT X1 and NOT accepted as another parked difference. Retained `malformed_usage_matches_ts` ignored explicitly as unresolved; `--ignored` fails (`coercion-usage-red.log`).
- Oracle correction: collecting JSON-round-tripped events converted NaN to null; now collects original TS events. Initial input_tokens={} buffer mismatch disappears. No product fix; no false claim of Rust equivalence on the eight remaining rows.

### Current decoder corpus
| Category | Rows | Status |
|---|---:|---|
| text/tools/reasoning/usage/terminal/errors/malformed |91|prior matching corpus|
| coercion-index |9|equal|
| coercion-delta |9|equal|
| coercion-response |9|equal|
| coercion-item |7|equal|
| coercion-usage |27|19 equal, 8 RED|
| Total main decoder corpus |152|144 equal ×3 chunkings (432 event,1296 buffered comparisons); 8 unresolved ×3|
| raw invalid/truncated UTF-8 |2|equal ×3 (6 event,18 buffered)|
| X1 lone-surrogate cases |4|parked RED ×3|

Gates at checkpoint: full required three-crate test run **47 summaries, 217 passes including subprocess repetitions, 4 ignored** (`coercion-checkpoint-tests.log`). One additional ignore is unresolved malformed Usage; default green DOES NOT establish full parity. Strict all-target clippy passed (`coercion-checkpoint-clippy.log`), fmt/diff checks passed, all three tripwires passed. Builds incremental=0/dev+test debug=0. No new depth mutations or literal reclassification; previous tables below remain current for those items. Stop after committed item-2 evidence checkpoint; not step-3 completion.

## Latest: item 1 exact blocker evidence — 63b1aeaa
Grep confirmed `jsjson::parse_js`, `JsValue` and `text::Text` exist, but public Delta Text/Thinking/ToolJson and StreamEvent Error.message still use String; native maps use serde Value. Collected TextBlock/ToolUseBlock/ProviderNativeBlock also use String/serde Value. A raw unpaired UTF-16 unit cannot inhabit these types. Parsing losslessly alone does not solve event equality or buffered answers. Full audit, TS emission table and continuation in committed `conformance/openai-lossless-blocker.md`.

| New category | Fixtures | Chunkings | Observation |
|---|---:|---:|---|
| lone surrogate (text, arguments, native reasoning, error) |4|3 each|all 12 event comparisons RED; buffered mismatches logged per dialect|
| raw invalid UTF-8 FF C0 AF |1|3|3 event + 9 client comparisons equal; TS emits 3 U+FFFD|
| truncated UTF-8 EOF F0 9F inside unfinished JSON |1|3|3 event + 9 client comparisons equal; no delta, premature-completion error|

First new comparison explicitly failed (`lossless-public-ir-red.log`). Exact TS output retained in `/tmp/opencode/b3/lossless-ts-outputs.json` (18 rows, full event and three client JSON strings). TS preserves escaped `\ud83d` in text; tool partial with that unit becomes Messages input `{x: surrogate}` and Chat/Responses JSON-string arguments with escaped `\\ud83d`; native summary/encrypted_content preserve it in Messages/Responses (Chat suppresses native); error event has UPSTREAM/retryable true with surrogate message (buffered rendering ignores the error). Rust skips these payloads; the error case ends with EOF error instead. These are known differences, not fixed.

Retained surrogate test is explicitly ignored with blocker reason; `--ignored` reproduces RED. Default test success therefore DOES NOT establish lossless parity. Raw-byte test passes (`raw-utf8.log`). Final full three-crate test run passed with **47 result summaries, 217 passes including subprocess repetitions, 3 ignored** (`lossless-checkpoint-tests.log`); one new ignored test is the deliberate blocker. Strict all-target clippy passed (`lossless-checkpoint-clippy.log`), fmt/diff and all three tripwires passed. All Rust builds incremental=0 and dev/test debug=0. No dependency/public API/product TS changes. No new mutations this turn; previous depth/literal inventories remain as below.

## Step 3 initial checkpoint — be5df952
Implemented standalone `OpenAiDecoder::new(native_reasoning)` with flat first-seen indexes, text/tool arguments, native/thinking reasoning, output-item ownership, usage/error mapping and terminal validation. Decoder caller must pass the API builder's bool; no ProviderCodec connecting them yet. Unknown output items ignored. Buffered collection compared through all three client egress functions, exact JSON strings.

Initial RED was absent module/API (`decode-red.log`), not behavioral. First implemented event corpus and later collection comparison passed (`decode-first.log`, `decode-collection.log`). Behavioral mutation removing OpenAI from unknown-event error text fails (`decode-message-mutation-red.log`), restored afterwards. No claim that a behavioral comparison failed before implementation.

| Decoder category | Rows |
|---|---:|
| ordinary text |1|
| tools (one/two, with/without interleaved text) |4|
| reasoning (thinking/native) |2|
| usage |4|
| terminal combinations |40|
| errors (seven codes × two event names × before/after content) |28|
| malformed/order/duplicate/missing/long-line/unknown |12|
| Total |91|

Each row runs whole-buffer, single-byte and seven-byte chunking in BOTH TS and Rust: **273 event comparisons, 819 buffered JSON comparisons**. Valid multibyte text is split across byte chunks. Actual EOF truncated inside UTF-8 is NOT tested yet. Long line is 20,000 chars. Missing terminal, duplicate terminal, invalid JSON, unknown event/non-JSON, cut-mid-event and out-of-order delta included. No arbitrary malformed field coercion or lone surrogate corpus yet.

Depth: four 39,990-level 2 MiB subprocess cases pass: function argument string through collector, native finished-item payload through collector, unknown item's payload, error message nested-array coercion. Native clone_map→plain clone mutation SIGSEGV (`decode-native-clone-red.log`), restored. Remaining carriers have **no mutation evidence yet**; do not call their protections covered. Parsed payload is Owned, scoped; native emitted maps use iterative StreamEvent ownership. Constructor inventory added; no write/reexport exceptions. No retained arbitrary JSON in decoder state (only strings/bools).

Full three-crate tests passed (`decode-tests.log`): **46 summaries, 216 passes including subprocess repetitions, 2 ignored, zero failures**. Strict clippy initially reported collapsible-if; fixed and passed (`decode-clippy.log`). fmt/diff passed; restored targeted 2-test suite passes (`decode-restored.log`). All builds incremental=0/dev+test debug=0. Three tripwires pass.

### Explicit remaining concerns
- Public decoder parses serde Value: lone-surrogate payload currently skips as invalid JSON, unlike TS. Must fix/verify before step 3 acceptance; shared IR strings may require deliberate lossless handling.
- Usage is f64: numeric-string/malformed output counts may differ from TS. Need real comparison before deciding representation.
- Index/ownership keys use strings; malformed object keys only deliberately never match. Need coercion/identity corpus, including null/bool/number/string, and memory/identity limits review (currently vectors unbounded).
- Frozen decoder literal inventory still lists 27 decoder tests as later; **not reclassified** until explicit mapping/extra cases complete. Existing 121-test table remains unchanged.
- API codec bool and decoder are not yet connected via ProviderCodec. OAuth/lite, zstd, catalog, gateway startup call/lifecycle/e2e remain later. No full step-3 or full-provider parity claim.

## A2–A4 latest completion
- A2 `5694ce31`: rich ingress, cache history, foreign drops, full seven-value effort ladder. First comparison passed (`a2-first.log`); wire order comparison also passed (`a2-wire.log`). **No Rust/TS discrepancy or product fix observed.**
- A3 `389d3c0c`: complete 121-declaration disposition inventory in committed `conformance/openai-literals.md`, request edge corpus, missing-token AUTH literal, request immutability assertions, URL/uncompressed checks. Targeted tests passed (`a3-tests.log`).
- A4 `93fb9b46`: public `omni_providers::openai::initialize()`, strings-only public boundary inventory entry. Production and test use the same OnceLock capture helper. Child processes initialize from environment then submit changed version/UA/order values to that helper; headers remain equal. Bun oracle actually changes process.env after import. Rust process-wide set_var is unsafe in this edition; **no actual Rust process environment mutation was performed**, honoring the no-unsafe rule. Gateway startup must call initialize in step 5; library first-use fallback remains.
- Follow-up `18ceba75`: clippy requested `.expect_err()` rather than `.err().expect()` in new AUTH assertion. Extra append-only commit rather than rewriting A3/A4 history. Initial final clippy did fail on this lint; corrected final clippy passes. No behavioral change.

### Current differential corpus (247 rows, each compared at wire and codec levels)
| Named category | Rows | Observed scope |
|---|---:|---|
| baseline |168|original codec/wire/cache/reasoning/media/vendor, including 6 simple dual-ingress rows|
| rich-ingress |18|3 dialects × buffered/streaming × 3 file media types; tools/images/structured format combined|
| cache-history |16|4 identity sources × original/growing/system-edited/opening-edited history; key bytes compared to TS|
| foreign-drops |2|foreign native/provider tools/1M beta, both stream flags|
| effort-ladder |21|none/minimal/low/medium/high/xhigh/max × default/omitted/updates display|
| literal-edges |22|session/key precedence/invalid values, unsafe keys, private conversation ids, empty history, freeform tool IR|

Rich ingress compares client JSON through BOTH real parsers before provider encoding. Frozen Chat Completions drops non-image file attachments; its rows deliberately test that behavior, not file preservation. Messages document tool-results and Responses input_file tool-results carry files. Exact JSON/degradation comparisons include these differences. No compressed or OAuth cases yet.

### Frozen declaration inventory counts
Full per-declaration dispositions (1-based source order, grouped by category) are committed in `conformance/openai-literals.md`; mixed OAuth/API tests remain marked later until both halves run.
| File | Total | Ported | Named differential | Later |
|---|---:|---:|---:|---:|
| openai.test.ts |49|0|20|29|
| openaiCacheKey.test.ts |19|1|18|0|
| openaiCodec.test.ts |7|3|1|3|
| openaiCodexFingerprint.test.ts |46|0|0|46|
| Total |121|4|39|78|

### Final gates observed
`cargo test --offline -p omni-providers -p omni-ir -p omni-dialects` passed (`a-final-tests.log`): **45 successful summaries, 214 passes including subprocess repetitions, 2 ignored, 0 failures**. All three source tripwires pass. Strict all-target three-crate clippy passes after lint fix (`a-final-clippy.log`); targeted request tests rerun after lint fix (`a-lint-fix-tests.log`), fmt and diff checks pass. All builds incremental=0/dev+test debug=0; long timeout used. Earlier A1 mutation logs remain intact. No release/gateway e2e performed. Historical gap lists below are superseded by this section.

## A1 completion — `933ee7c1`
Eight isolated 2 MiB cases, 39,990 levels: vendor retention, vendor stream replacement, tool input, tool schema, native retention, foreign-native drop, response-format schema.default, malformed text-format drop. Fixture construction moves deep values into shallow typed IR; build/output assertions/request+result release occur on the worker. See committed `conformance/openai-depth.md` for ownership audit and exact mutation table.

| Carrier | Mutation log under /tmp/opencode/b3/ | Observed result |
|---|---|---|
| vendor | a1-plainclone-vendor.log | SIGSEGV |
| tool input | a1-plainclone-tool_input.log | SIGSEGV; introduced clone regression, real writer borrows |
| tool schema | a1-plainclone-tool_schema.log | SIGSEGV |
| native payload | a1-plainclone-native.log | SIGSEGV |
| vendor replacement | a1-plaininsert-noscope-vendor_replace.log | stack overflow, SIGABRT |
| response-format schema.default | a1-noscope-format_schema.log | stack overflow, SIGABRT |
| malformed text format drop | a1-noscope-format_drop.log | stack overflow, SIGABRT |
| foreign native drop | a1-noscope-native_drop.log | PASS; no encoder ownership/walk of payload; IR Drop iterative |

Non-failing mutations explicitly retained: removing scope alone passes vendor/tool_input/tool_schema/native/vendor_replace; plain insert alone passes vendor_replace. Replacement has redundant protection (scope and iterative insert), so removing both is required. Dropped foreign native and provider-tool wire data are structurally borrowed/presence-only; no encoder clone/replace/drop to mutate. Scope removal is not claimed to test all protections. SIGSEGV results are reported as such, not relabelled as diagnosed stack overflow.

All mutations restored, production files byte-identical to pre-A1 commit. Baseline eight cases pass (`a1-baseline.log`). Full required three-crate suite passes (`a1-tests.log`): **45 successful summaries, 213 passes including nested subprocess repetitions, 2 ignored, 0 failures**. Strict all-target clippy passes (`a1-clippy.log`), fmt/diff checks pass, all three source tripwires pass. Builds use incremental=0/dev+test debug=0. No runtime changes, new dependencies or additional known TS differences. No decoder/lifecycle/e2e claim. This continuation stops at the committed A1 item.

## Latest continuation: `bcd56e5e`
- API-key request builder with crate-private wire helpers, cache thread derivation, native replay/id removal, orphan repair, reasoning/tools/media, response format, vendor merge, ordered headers/body. No dependency added; existing SHA-256 reused. Shared custom/Anthropic request paths unchanged.
- Real Bun oracle: **168 cases**, exact wire JSON/key/degradations in a unit test; exact codec body/ordered headers/native-reasoning flag in integration test. Six cases enter through both TS and Rust ingress (three dialects × buffered/streaming); the richer cases start from IR. Three file media types, tool-result images, tool choices, native reasoning replay, vendor overrides, cache key boundary/unsafe cases, reasoning modes included.
- Ported fixed codec BODY/KEY literal from openaiCodec.test.ts. 2 MiB subprocess successfully builds/drops a request with a 39,990-level vendor replacement. This is a successful run only, NOT mutation-proven deep protection coverage.
- Profile environment differential: four child environments (valid, empty, CRLF, non-ASCII version), overridden order, case-preserving Accept replacement, Linux platform. OnceLock resists a second source. Capture currently happens at first use; startup invocation is still to be wired at step 5. No claim of import-time-equivalent gateway capture yet.
- Initial RED: missing OpenAI module (`request-red.log`). Additional behavioral RED: forced stream=false fails real-TS codec comparison (`stream-mutation-red.log`), then restored. Wire comparison also failed on an oracle-only undefined property: TS assigned an undefined vendor key whereas JSON transmission omitted it. Oracle now JSON-normalizes before running TS; undefined in-process plugin values are outside this parsed-JSON corpus.
- Final requested three-crate test command passed: **44 successful result summaries, 212 passes including nested subprocess runs, 2 ignored**, zero failures (`/tmp/opencode/b3/step2-tests.log`). These totals include nested children, not 212 unique tests. All three source tripwires passed. One public function inventory entry justified by scoped assembly returning only strings/headers/bool; no JSON-write or reexport exceptions added.
- Strict three-crate all-target clippy passed (`step2-clippy.log`); fmt check and diff check passed. All Rust builds used CARGO_INCREMENTAL=0 and dev/test debug=0. Earlier 120-second full test invocation timed out in existing emitted_depth; rerun with 600-second allowance passed.

### Remaining step-2 verification gaps / concerns
The four frozen files have NOT been exhaustively ported: only the codec literal is pinned directly; selected wire/cache/fingerprint behavior is exercised through the generated oracle. Rich end-to-end ingress combinations (tools/images/files/format across all three dialects), cache history-stability pairs, foreign native/provider tool drops and full effort ladder still need explicit corpus cases. The small-stack case needs a demonstrated failing protection mutation and broader arbitrary-JSON carriers (tool input/schema/native/response-format). No missing-token literal test yet. New request builder is not a ProviderCodec and is not registered; that awaits decoder/step 5. Public startup initialization must be connected then. Full tests passing does not close these gaps.

### Controller decisions retained
Step 4 zstd: compare decompressed bytes exactly, content-encoding value/position exactly, valid frame; compressed bytes need not match. Report whether TS-level output happens to match. Compression dependency permitted with crate/licence/rationale, prefer existing lockfile. Step 5: fill OpenAI catalog from generated data and compare to frozen models/Codex catalog. Always SSE upstream; buffered clients collect.

## Frozen source map (inspection)
- `codec.ts`: credential-selected API/Codex URLs, ordered headers/body, OAuth zstd, always SSE; decode-state native reasoning flag from client vendor bag.
- `wire.ts`: IR messages/tools/media/reasoning, orphan call repair, system developer turns, vendor merge, response format, cache affinity; OAuth restrictions and lite assembly.
- `profile.ts`: import-time environment capture, CLI headers/order, body order, platform sandbox.
- `decode.ts`: SSE JSON payloads to IR, flat index allocation, native reasoning, usage/errors/terminal validation. No separate upstream JSON-response decoder; buffered clients collect SSE.
- `codexIdentity.ts`: UUID-shaped hashes, stable cache thread IDs, salted IDs and stored credential secrets.
- `codexLite.ts`: prefix tools/instructions, history IDs/provenance, effort update and turn metadata.
- `codexCatalog.ts`: 0.165.0 per-model lite/reasoning/verbosity flags; unknown-model defaults.
- `models.ts`: curated prices and API/OAuth limits. `descriptor.ts`: capabilities, model prefixes, callback/presentation. `index.ts`: adapter registration/exports.
- `oauth.ts`: PKCE start/exchange, form-encoded refresh, ID-token claims, secret backfill; usage/reset-credit methods are outside this increment.

## Rust reuse and missing counterparts (inspection)
Reuse `omni-ir` request/stream/Text, JS JSON/coercion, deep ownership/scope helpers; provider system/response_format/tool_result_files, SSE, HTTP/error/adapter contract, shared OAuth response helpers and gateway refresh/CAS. Follow Anthropic's isolated selection and differential pattern. Existing custom Responses wire is structurally similar but has provider-specific differences; do not change its request path. Router already registers OpenAI descriptor prefixes but leaves its catalog empty (`crates/omni-router/src/providers.rs:72`); generated data exists. HTTP has a Zstd encoding enum but `HttpClient::send` rejects every body encoding with UnsupportedEncoding (`crates/omni-providers/src/http/mod.rs:248`): OAuth needs real transport work and exact Codex frame verification, not just setting the enum. No websocket transport appears in the frozen OpenAI module. OpenAI codec, profile, identities, lite, OAuth flow and dedicated decoder have no provider-specific Rust counterpart yet.

## Scope and remaining steps
1. Source map: inspected all 2,351 OpenAI source lines in sections; json_writes/public_json_boundary headers, owner_reexports inventory and Anthropic report first 60 lines read. Documentation checkpoint committed as `2d2ae7ef` (`conformance/openai-migration.md`).
2. API-key profile/wire: pending (requires thread-ID derivation subset from identity).
3. SSE payload decode and buffered collection parity: pending.
4. OAuth/lite/full identity/refresh: pending.
5. Adapter registration, real-gateway e2e and small-stack lifecycle: pending.
6. Final gates/release manifest: pending.

Out of scope: connect HTTP routes, quota/usage/reset-credit polling, dashboard, websocket transport. No known implemented differences yet because no OpenAI implementation exists. No changes to frozen TS or other providers' ordinary request paths. No release binary produced.

## Observed verification
- Frozen baseline: `bun test packages/providers/test/openai.test.ts packages/providers/test/openaiCacheKey.test.ts packages/providers/test/openaiCodec.test.ts packages/providers/test/openaiCodexFingerprint.test.ts`: **121 pass, 0 fail, 543 assertions, 4 files**. Log `/tmp/opencode/b3/frozen-openai-baseline.log`.
- `git diff --check`: passed before documentation commit; worktree status empty after commit.
- No Rust tests, differential comparisons, mutation RED checks, lifecycle cases, e2e drivers, clippy/full gates or release build run. No failing comparison yet: step 2 must begin RED, not assume this frozen baseline demonstrates Rust parity.

## Continuation details
API-key wire is close to custom's Responses encoder, but must fork provider behavior rather than add custom-path work: OpenAI native replay strips id, repairs unanswered function calls, derives UUID-shaped cache key before vendor merge, then overwrites prompt_cache_key afterward. Wire body insertion order differs from codec body order; compare both. Reuse SHA-256 already in dependencies for unkeyed thread derivation. Profile uses import-time environment defaults and ordered case-preserving merge. Keep wire helpers crate-private and test through a scoped codec or internal unit tests to avoid unnecessary public JSON boundary entries. Deep response-format helpers rely on caller scope; do not call unscoped. Existing test oracle pattern: `crates/omni-providers/tests/anthropic-wire-reference.ts` plus `anthropic_wire.rs`.
