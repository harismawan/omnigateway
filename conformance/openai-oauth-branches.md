# OAuth/lite branch inventory

Frozen paths below are under `packages/providers/src/openai/`. Inventory units
are source decisions, grouping adjacent outputs controlled by one decision.
24 decisions, all reached in both directions by named whole-codec rows.
This is source inspection plus differential inputs, not instrumented coverage.
`branches` means category `oauth-branches` in openai-oauth-request-reference.ts.
Its 36 rows: 2 models × 2 credentials × 8 patches, plus 2 unsafe models and
2 absent/nonstring account IDs. First run green, no production correction.
174 prior rows +36 =210 requests (194 OAuth, 16 API-key).

| File:line | Decision / effect | Taking / not taking witnesses |
|---|---|---|
|codec.ts:42|accessToken non-null selects OAuth|branches true / false|
|codec.ts:45|read stored secrets only OAuth|branches salted true / false|
|codec.ts:56|Codex window and turn headers|branches true / false|
|codec.ts:62|lite header|gpt-6-astra / gpt-5.5|
|codec.ts:80|content-encoding zstd|branches true / false|
|codec.ts:83|OAuth auth/account/host versus API auth|branches true / false|
|codec.ts:118|Codex versus API URL|branches true / false|
|codec.ts:124|bodyEncoding marker|branches true / false|
|wire.ts:199|lite reasoning context|reasoning category astra / 5.5|
|wire.ts:423|OAuth AND lite model|branches true astra / false astra and true 5.5|
|wire.ts:424|API instructions body field|branches false controls / true controls and baseline|
|wire.ts:430|drop portable maxTokens OAuth|branches true controls / false controls|
|wire.ts:436|drop portable temperature OAuth|branches true controls / false controls|
|wire.ts:445|OAuth strict:false tool schema|branches true controls / false controls|
|wire.ts:457|lite tools prefix versus body tools|branches true astra controls / true 5.5 controls|
|wire.ts:469|default auto choice only OAuth|branches true baseline / false baseline and choice|
|wire.ts:474|set parallel_tool_calls only OAuth|branches true / false controls|
|wire.ts:475|parallel disabled lite; non-lite catalog support|branches true astra / true 5.5 controls|
|wire.ts:482|between-tools degradation spelling|branches true / false controls|
|wire.ts:487|Codex reasoning defaults versus API rules|branches true / false baseline and controls|
|wire.ts:516|credential salt only OAuth|branches salted true / false baseline|
|wire.ts:519|include/text defaults and per-field vendor merge|branches true / false merge and scalar-merge|
|wire.ts:544|API early return versus lite history and metadata|branches false / true merge|
|wire.ts:560|supported model AND valid effort history update|branches true astra baseline / invalid-effort and true 5.5|

Nested decisions: `codec.ts:66` safe routing hint present/absent exercised by
tier, bad-tier, routing-omitted; `:87` string account present/absent by baseline
and account-omitted. `wire.ts:239` client metadata replacement/preservation and
`:244` object merge/scalar replacement exercised by merge/scalar-merge/baseline.
`:575` accepted effort versus metadata fallback covered by B1 and invalid-effort.
Not included in the 24 flag-decision count: missing both tokens auth-error arm
(`codec.ts:93`) is not reached by these 210 successful-request rows. Existing
API missing_token_is_auth covers Rust's shared error; a credential-selected
real-TS error comparison remains to add. No flag decision is marked unreached.

Important observed behavior: OAuth drops portable maxTokens/temperature but
vendor max_output_tokens/temperature survive. Vendor store, parallel calls,
instructions and tools survive too; input is replaced by assembled history.
No additional refusal/stripping should be invented. The portable response
format rewrite is shared by both credential modes, not an OAuth-only branch.
Only exact catalog name gpt-5.5 disables lite; unknown names (including
__proto__) use lite defaults. B5's 28 rows exercise all 12 catalog entries and
two unknown names, prefix absent/present, native reasoning metadata replacement,
assistant output annotations, multi-turn history and developer provenance.
