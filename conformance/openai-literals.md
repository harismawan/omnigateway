# Frozen OpenAI test disposition (steps 2–3)

Numbers below are 1-based `test(...)` declaration order within each frozen file.
Every declaration is assigned exactly once. Differential means exact wire JSON,
codec JSON/ordered headers/degradations/native flag against real Bun, not a
claim that each original expect() was copied. Mixed OAuth/API tests stay later
until their OAuth assertions can run. Frozen titles sometimes describe obsolete
behavior (the image test forwards images; system turns become developer).

| File | Total | Ported | Differential | Later |
|---|---:|---:|---:|---:|
| openai.test.ts |49|0|47|2|
| openaiCacheKey.test.ts |19|1|18|0|
| openaiCodec.test.ts |7|3|1|3|
| openaiCodexFingerprint.test.ts |46|31|15|0|
| Total |121|35|81|5|

## Declaration-by-declaration disposition

Each number in a grouped row names an individual declaration with the same
disposition. This grouping keeps the inventory readable without abbreviating
the source authority: locate titles with `grep -n '^test('` in the named file.

| File | Test numbers | Disposition / named evidence |
|---|---|---|
| openai.test.ts |1,2,3,4,5,6,8,9,10|baseline differential (messages/system/tool choices/reasoning/images/max tokens)|
| openai.test.ts |7|effort-ladder differential|
| openai.test.ts |11|decoder text category|
| openai.test.ts |12|decoder usage category (cache exceeds input)|
| openai.test.ts |13|decoder malformed category (text without completion)|
| openai.test.ts |14|decoder reasoning category (reasoning index 7 vs text index 2)|
| openai.test.ts |15|decoder tools category|
| openai.test.ts |16,17,18,19,20,21,22,25|decoder terminal category (event/status/reason cross product)|
| openai.test.ts |23|decoder malformed category (DONE alone)|
| openai.test.ts |24,26|decoder errors category (constructor and response.failed)|
| openai.test.ts |27,28,29|baseline differential (developer turns, sampling)|
| openai.test.ts |30,31|Later: OAuth|
| openai.test.ts |32,33|decoder-literal-edges category (message and reasoning duplicate done)|
| openai.test.ts |34|decoder usage category (prompt_tokens_details fallback)|
| openai.test.ts |35|foreign-drops differential (1M beta)|
| openai.test.ts |36|baseline differential (no beta)|
| openai.test.ts |37,38|decoder malformed category (unknown JSON/non-JSON)|
| openai.test.ts |39,40,41,42|decoder-literal-edges category (keepalive/in_progress/metadata/DONE after completion)|
| openai.test.ts |43,44|decoder reasoning category (native false/true; whole native merge)|
| openai.test.ts |45,47,48|baseline differential (native replay, orphan and answered calls)|
| openai.test.ts |46|foreign-drops differential|
| openai.test.ts |49|literal-edges differential (freeform IR flattened function)|
| openaiCacheKey.test.ts |1,2,3,5,9|baseline differential (UUID passthrough/derived bytes/precedence)|
| openaiCacheKey.test.ts |4,6,7,8,10,13,17,18|literal-edges differential (session/precedence/fallback/vendor/empty history)|
| openaiCacheKey.test.ts |11,12,14,15,16|cache-history differential (private id, growing and edited prefix)|
| openaiCacheKey.test.ts |19|Ported: before/after request equality on every integration corpus row; Rust takes immutable borrow|
| openaiCodec.test.ts |1,2|Later: OAuth host/account selection|
| openaiCodec.test.ts |3,4|Ported: captured_literal_and_small_stack fixed BODY/KEY; differential checks headers, URL and absent encoding|
| openaiCodec.test.ts |5|Ported: missing_token_is_auth; pure builder has no transport to send|
| openaiCodec.test.ts |6|baseline differential nativeReasoning flag|
| openaiCodec.test.ts |7|Later: OAuth half; API half in baseline/literal-edges|
| openaiCodexFingerprint.test.ts |1,2,3,5,25|Ported: openai_fingerprint_literals::captured_headers_and_metadata (zstd marker only; wire frame belongs to transport compression)|
| openaiCodexFingerprint.test.ts |4,6,7,8,11,36,38,44|Ported: captured_body_prefix_and_history (7 pins both provider-visible UUIDv5 prefix vectors; helper vector remains in frozen test)|
| openaiCodexFingerprint.test.ts |28,29,30,33,34|Ported: catalog_and_non_lite_literals|
| openaiCodexFingerprint.test.ts |10,14,20,21,22,23,32,35|Ported: overrides_and_identity_literals; 10/14 behavioral portions also identity/fingerprint-clock; 32 API half oauth-branches|
| openaiCodexFingerprint.test.ts |31,37,39|Ported: media_and_system_provenance_literals|
| openaiCodexFingerprint.test.ts |15,17|Ported: stored_and_derived_id_literals; behavior also identity/cache-pairs|
| openaiCodexFingerprint.test.ts |9,12,13,40,41,42,43|Differential: fingerprint-behavior (prefix absence, turn progression/mixed result, orphan repair, future/invalid UUIDs)|
| openaiCodexFingerprint.test.ts |16,18,19|Differential: identity + cache-pairs (salted identity and caller keys; invalid stored values)|
| openaiCodexFingerprint.test.ts |24,26|Differential: reasoning + lite-catalog (mode/effort/default catalog and invalid effort header sanitization)|
| openaiCodexFingerprint.test.ts |27|Differential: oauth-branches routing-omitted (Unicode model ASCII metadata)|
| openaiCodexFingerprint.test.ts |45|Differential: fingerprint-behavior + cache-pairs (new user turn ids)|
| openaiCodexFingerprint.test.ts |46|Differential: fingerprint-clock (absent/present start, two request ids); no clock API in Rust builder|

C1 checkpoint: six Rust literal test functions cover 31 frozen declarations;
all passed on first execution (first three before expansion, then remaining
three). Behavioral differential disposition names a category rather than claiming
each original expect was copied. 285 whole-request rows now include 13 new
fingerprint boundary rows (269 OAuth + 16 API-key controls). The remaining five
later declarations above await C3, after C2 OAuth codec-level decode comparisons.

Chat-completions file attachments are deliberately supplied in rich-ingress;
the frozen ingress drops non-image attachments rather than creating file IR.
Messages document tool results and Responses input_file tool results do carry
files. The corpus compares these actual dialect semantics rather than claiming
every surface preserves files.

None of these 121 original declarations is parked: their decoder literals use
ordinary strings and numeric usage. Additional Rust tests parked under X1 are
`openai_lossless::lone_surrogates_match_ts` and
`openai_decode::malformed_usage_matches_ts`, with exact corpora documented in
openai-lossless-blocker.md and openai-coercion.md. They do not count as ported
original declarations. All 27 former "later: decoder" declarations above now
have a named differential category; all compare buffered bytes too.
