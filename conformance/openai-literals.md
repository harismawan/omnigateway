# Frozen OpenAI test disposition (step 2)

Numbers below are 1-based `test(...)` declaration order within each frozen file.
Every declaration is assigned exactly once. Differential means exact wire JSON,
codec JSON/ordered headers/degradations/native flag against real Bun, not a
claim that each original expect() was copied. Mixed OAuth/API tests stay later
until their OAuth assertions can run. Frozen titles sometimes describe obsolete
behavior (the image test forwards images; system turns become developer).

| File | Total | Ported | Differential | Later |
|---|---:|---:|---:|---:|
| openai.test.ts |49|0|20|29|
| openaiCacheKey.test.ts |19|1|18|0|
| openaiCodec.test.ts |7|3|1|3|
| openaiCodexFingerprint.test.ts |46|0|0|46|
| Total |121|4|39|78|

## Declaration-by-declaration disposition

Each number in a grouped row names an individual declaration with the same
disposition. This grouping keeps the inventory readable without abbreviating
the source authority: locate titles with `grep -n '^test('` in the named file.

| File | Test numbers | Disposition / named evidence |
|---|---|---|
| openai.test.ts |1,2,3,4,5,6,8,9,10|baseline differential (messages/system/tool choices/reasoning/images/max tokens)|
| openai.test.ts |7|effort-ladder differential|
| openai.test.ts |11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26|Later: decoder|
| openai.test.ts |27,28,29|baseline differential (developer turns, sampling)|
| openai.test.ts |30,31|Later: OAuth|
| openai.test.ts |32,33,34|Later: decoder|
| openai.test.ts |35|foreign-drops differential (1M beta)|
| openai.test.ts |36|baseline differential (no beta)|
| openai.test.ts |37,38,39,40,41,42,43,44|Later: decoder|
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
| openaiCodexFingerprint.test.ts |1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19|Later: OAuth/lite/fingerprint|
| openaiCodexFingerprint.test.ts |20,21,22,23,24,25,26,27,28,29,30,31|Later: OAuth/lite/fingerprint/catalog|
| openaiCodexFingerprint.test.ts |32|Later: OAuth effort-update half; public API shape in baseline (no configuration/provenance)|
| openaiCodexFingerprint.test.ts |33,34,35,36,37,38,39,40,41,42,43,44,45,46|Later: OAuth/lite/fingerprint/catalog|

Chat-completions file attachments are deliberately supplied in rich-ingress;
the frozen ingress drops non-image attachments rather than creating file IR.
Messages document tool results and Responses input_file tool results do carry
files. The corpus compares these actual dialect semantics rather than claiming
every surface preserves files.
