# B3 OpenAI / Codex

## Item B implemented — HEAD `f35643f0`; empty-body decision pending

Worktree rust-providers clean; append-only commit, no push/merge.
First new wire test failed with UnsupportedEncoding(Zstd): `s5b-red.log`.
Client now sends nonempty zstd bodies, level 3 / one write_all / finish;
source remains uncompressed; compressed allocation reused for wire bytes.
Depth: compression consumes already-serialised bytes and holds no JSON value.
Raw TCP captures compared to frozen nodeHttpClient via Bun reference script:
source sizes 37, 131091, 3145746, real OAuth codec request (1653 bytes),
and 2-byte mixed-case/whitespace encoding acceptance probe.
All header lists/order equal; Content-Length correct; both bodies decompress
exactly to source; compressed bytes identical in all five probes (`s5b-green.log`).
Both framing refusals occur before URL parsing/network: supplied content-length;
missing/wrong/duplicate content-encoding. Rust InvalidEncodedRequest preserves
frozen text `{provider} codec buildRequest did not return a usable request`;
frozen type is GatewayError UPSTREAM (adapter); Rust checks in transport.
Observed empty frozen POST: content-encoding: zstd, Host: fixture,
Connection: keep-alive, Transfer-Encoding: chunked (no Content-Length).
After CRLFCRLF, hex `390d0a28b52ffd00580100000d0a300d0a0d0a`:
9-byte frame `28b52ffd0058010000`, chunk terminator (`s5b-empty.log`).
Existing explicit chunking needs a new branch for this implicit-empty case;
per instruction Rust refuses with EmptyEncodedBody. Controller decision pending;
OAuth emits a nonempty JSON object. Known differences documented in
conformance/openai-compression.md, Implemented section; byte identity not required.
Item A depth audit remains committed in d0e142c6 (details in depth doc).

Post-last-commit gates, all logs under `/tmp/opencode/b3/`:
`s5b-tests.log`: 53 `test result: ok` summaries; 235 passed; 4 ignored; no FAILED.
Final result: `test result: ok. 1 passed; 0 failed; 0 ignored; ... finished in 0.07s`.
`s5b-clippy.log`: `Finished dev profile [unoptimized] target(s) in 0.18s`.
`s5b-fmt.log`: `exit code: 0`. Existing ignored tests unchanged.

Next: controller decides whether to accept empty-body refusal or extend implicit
chunking. Then step 5, gateway integration: provider registration, startup
initialize(), catalog from generated descriptors, persist OAuth result provider
data with ensure_secrets(prior), end-to-end driver against frozen gateway,
dispatch_depth cases, and a benchmark-matrix entry.

## D1 vendor-depth checkpoint — HEAD `8ec4c4a5`

**D partially complete: six vendor carriers committed; remaining D below.**
Source unchanged after scratch restoration; no product defect found in these
six baseline cases. `openai_oauth_depth.rs` builds/drops each request/result
with 39,990 nested arrays on a 2 MiB thread in an isolated process. All six
baseline/restored cases pass. Body length distinguishes retained/discarded data.

| Carrier/source (crates/omni-providers/src/) | Mutation | Observed outcome |
|---|---|---|
| text per-field merge, openai/wire.rs:334 | plain clone | SIGSEGV 11 |
| reasoning per-field merge, openai/wire.rs:334 | plain clone | SIGSEGV 11 |
| reasoning array replacement, openai/wire.rs:337 | plain clone | SIGSEGV 11 |
| input overwrite, openai/wire.rs:394 | plain insert + remove openai/mod.rs:70 scope | stack overflow / SIGABRT 6 |
| stream overwrite, openai/mod.rs:90 | plain insert + remove mod.rs:70 scope | stack overflow / SIGABRT 6 |
| client metadata, openai/wire.rs:323–325,402 | same insert/scope mutation | Pass: borrowed value skipped, never builder-owned; request drops iteratively; generated replacement is shallow primitives |

Full initial carrier inventory with source lines is now at the top of
`conformance/openai-depth.md`. Remaining inventory/work, not safety claims:
tool schema/strict rewrite and lite prefix (wire.rs:234–253, lite.rs:56–61);
tool inputs/results/native results (wire.rs:107–115); native fields and foreign
native (wire.rs:117); cache first-item fallback (wire.rs:175–187); intermediate
input and return replacement (wire.rs:202,394); response-format schema/text
(wire.rs:370; shared response_format.rs needs line-level expansion); lite
message content/annotations (lite.rs:139–154), native function/output fields
(lite.rs:157–161), reasoning passthrough removal (lite.rs:163–171), unknown
native item (lite.rs:173), LiteArgs drop (lite.rs:22–29); credential data borrowed
lookups (identity.rs:30–40, oauth.rs:53–58); generated metadata (oauth.rs:63–75);
system/provider-tool and media helper inventory still needs expansion.

Logs `/tmp/opencode/b3/s4d-depth-vendor-baseline.log`,
`s4d-depth-clone-{text_merge,reasoning_merge,scalar}.log`,
`s4d-depth-insert-noscope-{input_replace,stream_replace,metadata}.log`.
All scratch mutations restored; no new tripwire entries. After commit gates:
**52 successful summaries, 231 passes including subprocess repetitions,
4 ignored, zero failures**; strict all-target clippy, fmt/diff check and three
source tripwires pass. Logs `s4d-depth-final-{tests,clippy}.log`. Builds use
incremental=0/dev debug=0/test debug=0. Worktree clean.

C2/C3 status unchanged: OAuth decode matches shared codec semantics; native
flag comes from client include, not forced upstream include. 289 whole request
comparisons; literal table **35 ported /86 differential /0 undecided**. X1 two
ignored comparisons unchanged. Transport still refuses OAuth Zstd marker;
empty-body frame question unresolved. Startup capture/refresh persistence and
gateway integration remain deferred. No HTTP or public IR changes.

**Next fresh session: finish D's remaining carriers above**, baseline then
scratch mutation each, log actual process result, restore; fix any failing
baseline as a defect. Then compressed request body in HTTP client under rules
and empty-body question in `conformance/openai-compression.md`. Then gateway
integration: registration, startup `initialize()`, generated-descriptor catalog,
persist OAuth result provider data, end-to-end driver, `dispatch_depth` cases,
benchmark-matrix entry. This checkpoint is not a complete OAuth depth audit.

## C2/C3 complete — HEAD `31db790c`; D next

**C2 `c0875139`, C3 `31db790c` committed. D not started.** Stopping at a
committed-item boundary for context. No production changes. Request codec now
matches **289 whole requests: 271 OAuth +18 API-key controls**; four added
`unsafe-affinity` rows cover both hosts with CRLF/Unicode client keys. Literal
inventory: **121 =35 ported +86 differential +0 later/undecided**. C1 literals
still passed first; no new literals in C2/C3 and no comparison failures observed.

**OAuth changes nothing on the decode side for the same client include.**
Frozen codec.ts:103–132 reads nativeReasoning from the original client bag,
not OAuth's forced upstream encrypted-content include. Both modes call the
same SSE parser/decoder; no credential argument reaches decode, and there is
no codec error-classifier override. decode.ts:119–125,266–351 uses the same
native folding, error mapping and usage rules. Buffered output uses the same
collector/renderers. This statement concerns codec behavior, not HTTP errors
or transport integration.

Evidence: new `openai-oauth-decode-reference.ts` reuses all 158 decoder rows,
builds both credential modes, passes actual build decodeState to frozen codec
decode, and checks events plus buffered three-dialect bytes against the direct
decoder oracle at all three chunkings. All match. Rust OAuth codec path checks
**152 non-parked rows ×3 =456 event comparisons +1,368 buffered comparisons**.
Six non-numeric usage rows remain excluded by the existing X1 filter; TS-only
agreement on those is not a Rust parity claim. Native false/true reasoning
rows cover the distinction between client include and forced upstream include.
Details: `conformance/openai-oauth-decode.md`. First C2/C3 runs green.

Gates **after final commit**: three-crate tests **51 summaries, 230 passes
including subprocess repetitions, 4 ignored, zero failures**. Strict all-target
clippy, fmt check, diff check pass; all three source tripwires pass in suite
(`json_writes_use_iterative_release`, `public_boundary_inventory_matches`,
`owner_reexports_are_pinned`). Logs `/tmp/opencode/b3/s4d-{c2,c3,final-tests,final-clippy}.log`.
All builds incremental=0/dev debug=0/test debug=0. Worktree clean.

### D depth status (no new cases or mutations run)

| OAuth/lite carrier | Observed mutation/outcome this turn |
|---|---|
| Vendor per-field merge/scalar replacement | Not investigated; D pending |
| Client metadata replacement/drop | Not investigated; D pending |
| Tool schema OAuth strict rewrite | Not investigated; D pending |
| Tool inputs/results into lite history | Not investigated; D pending |
| Native reasoning passthrough/replacement | Not investigated; D pending |
| Response-format schema | Not investigated; D pending |

No structural-safety claim is made for these paths. **Next session: D**, using
`openai_depth.rs` and `conformance/openai-depth.md` as patterns: enumerate every
arbitrary-JSON carrier held/replaced/merged/dropped in OAuth/lite, run ~40,000
levels on 2 MiB subprocess threads, each with scratch mutation and observed
process outcome (restored, log retained), or justify structural safety when
mutation does not fail. Commit D, then run final gates. After D: compressed
body in HTTP client, resolving the empty-body frame question in
`conformance/openai-compression.md`; then gateway integration.

Known differences unchanged: transport refuses OAuth Zstd marker; empty-body
compression bytes/reachability unresolved; X1 lone-surrogate escapes and
non-numeric usage ignored comparisons unchanged; startup environment capture
timing and refresh persistence deferred. No HTTP/refresh/registration changes.

## C1 captured-fingerprint checkpoint — HEAD `b43d7310`

**C1 committed; C2 and C3 not started.** Stopping at the permitted C1 checkpoint
to preserve context. No production change. OAuth request codec: **285 exact
whole-request comparisons green (269 OAuth +16 API-key controls)**, previously
272. Added `fingerprint-behavior` (9 rows: prefix absence, opening/next/mixed
turns, orphan repair, future and near-UUID keys) and `fingerprint-clock` (4 rows:
two request IDs × absent/present start). Rust consumes each row's ID/start when
provided; prior 272 rows retain their original fixed identity inputs.

Read all 46 frozen fingerprint declarations in <=120-line sections. Six tests
in `openai_fingerprint_literals.rs` pin 31 original declarations: captured
header order/casing/constants, metadata keys/order/values, body order/shape,
prefix UUID vectors, history metadata, catalog rows, provenance, ID formats,
stored installation ID, include/decode flag, and client overrides. Remaining
15 receive named behavioral corpus dispositions. Literal table across 121:
**35 ported /81 differential /5 still later (C3 pending)**. This is not yet
the requested final no-undecided inventory. The five are openai.test.ts 30/31
and openaiCodec.test.ts 1/2/7. No fingerprint declaration is deferred to refresh
or connect routes; test 2 pins the zstd marker only, not the transport frame.

**No literal failed first:** initial three functions passed, then expanded
five, then final six. No request differential mismatch in the 13 new rows.
Prefix declaration 7 pins its two provider-visible UUIDv5 vectors; its standalone
Python.org helper vector was not copied. Mixed behavior/format tests name both
literal and differential evidence in the disposition table.

Final code gates: three-crate cargo tests **51 successful summaries, 229 passes
including subprocess repetitions, 4 ignored, zero failures**; strict all-target
clippy, fmt check, diff check passed. All three source tripwires pass within
that suite (`json_writes_use_iterative_release`, `public_boundary_inventory_matches`,
`owner_reexports_are_pinned`). Logs `/tmp/opencode/b3/s4c-final-tests.log` and
`s4c-final-clippy.log`; literal first/expanded and C1 focused runs use `s4c-`
prefix too. Cargo builds use incremental=0/dev debug=0/test debug=0.

Decode status unchanged: shared decoder differential is still the earlier
158 rows ×3 chunkings with buffered three-dialect output. **No OAuth codec-level
SSE comparison added this turn; no new claim about OAuth decode behavior.**
Prior inspection below says native reasoning derives from original client
include, not OAuth's forced include; C2 must verify that through the codec.

Known differences unchanged: HTTP transport refuses the OAuth Zstd marker;
empty-body compressed bytes/reachability question remains in
`conformance/openai-compression.md`. X1 unpaired-surrogate upstream escapes and
non-numeric usage counts retain their two ignored tests unchanged. Startup
environment capture timing and refresh persistence remain deferred. No new
production mismatch observed; OAuth/lite depth remains unaudited.

**Precise next session:** finish C2 (grep/read frozen codec.ts/decode.ts OAuth
and native state; reuse SSE corpus through codec decode state, compare events
and buffered answers for all three dialects), then C3's five declarations,
updating table to zero undecided rows. Then depth for **every arbitrary-JSON
carrier on OAuth/lite**: 2 MiB subprocess cases near 40,000 levels, each with
a scratch mutation, or a structural-safety statement. Then compressed HTTP
body, including the empty-body frame question in openai-compression.md; then
gateway integration. Preserve X1 ignores and the frozen product TypeScript.

## Step B coverage checkpoint — HEAD `0e0d9d61`

**272 request comparisons green: 256 OAuth +16 API-key controls.** B5–B8
committed; Step C not started this turn. No production changes this turn.

| Category | Rows | First failure / commit |
|---|---:|---|
|Three dialects buffered/streaming|6|Historical row 0 Auth; da138696|
|B1 reasoning|76|Historical row 36 invalid effort; fixed 310b183f|
|B2 tools/mixed results|16|First run green a3fff63f|
|B3 media ingress|36|First run green 96dcdfc5|
|B4 response format|12|First run green 9ca9634e|
|B5 lite/catalog|28|First run green f2a06a4f|
|B6 OAuth branch controls|36|First run green d352f767|
|B7 identity|22|First run green 9c1185a1|
|B8 cache/history pairs|40|First run green f8518b1b|

Final lint-only commit 0e0d9d61 removes redundant Credentials default; first
clippy failed needless_update. No differential failure in these four additions.
B5: all 12 catalog entries +unlisted and __proto__, prefixes absent/present;
native reasoning passthrough replacement, assistant text, user turns, developer
message. B6: two models ×two credentials ×eight control/vendor patches plus
unsafe model routing and missing/nonstring account IDs. Inventory in
`conformance/openai-oauth-branches.md`: **24 OAuth/lite source decisions, 24
reached both ways, 0 unreached** (inspection of inputs, not instrumentation).
Nested routing/account/vendor decisions covered separately. Missing-both-token
error arm is outside successful-row coverage; shared Rust API auth test exists,
but credential-selected real-TS error comparison remains unperformed.

B7: 11 provider-data shapes ×two models. Valid installation UUID preserved;
valid lowercase 64-hex salt keys derived identities. Missing/malformed fields
independently fall back; uppercase UUID accepted, uppercase salt rejected.
Request bytes match for absent/account-only/complete/partial and malformed
string/scalar/nested values. Codec reports no backfill field or degradation:
it reads secrets, derives fallback installation ID, and does not persist them.
Refresh remains responsible for backfill.
B8: salted/unsalted ×four identity choices ×original/append/opening edit/system
edit/later-assistant edit. Whole bytes compared independently against TS for
every member of each group; no separate cross-row equality assertions added.

Clock/randomness unchanged: both sides receive startedAt=1794000000123 and
requestId=fixed-oauth-request. Request builder calls no randomness; exact
deterministic IDs compared. No clock patch or shape-only comparison.

Final gates after last commit: 50 summaries, 223 passes including children,
4 ignored, zero failures; all three tripwires, strict all-target clippy, fmt,
diff check pass. Worktree clean. Logs `/tmp/opencode/b3/s4b-b8-final-`
`{tests,clippy,fmt}.log`, first runs `s4b-{catalog,branches,identity,cache}-first.log`.
All Rust builds incremental=0/dev debug=0/test debug=0. No large scratch created.

Known differences/examples unchanged: transport refuses Zstd marker on OAuth
instead of compressing; prior empty-string compression probe differs in bytes
and reachability remains unresolved. X1 escaped lone surrogate text and string
usage counts remain parked ignored comparisons (not rerun). Gateway startup
environment capture integration remains deferred: library first use can capture
later than frozen module import. Refresh/persistence remains deferred: absent
stored secrets are not persisted by builder. No mismatch observed in this
corpus; OAuth/lite depth not audited. Fingerprint dispositions unchanged:
4 ported +66 differential +51 later overall; all 46 fingerprint declarations
still need Step C review against the expanded corpus.

**Next: Step C**, read all 46 fingerprint tests in sections and update literal
dispositions; add OAuth SSE codec comparison. Frozen codec.ts:109–112 reads
nativeReasoning from original client include; :130–133 uses the same decoder
for both credential modes, not the forced OAuth include. Then roadmap item 3
OAuth/lite depth, item 4 HTTP compression including empty-body question, item 5
remaining literals. Missing-token differential can join Step C codec edges.

## Step B categories 1–4 green — HEAD `9ca9634e`

Item 2 remains partial: **146 whole OAuth request comparisons pass**. Each row
compares URL, ordered/cased headers, uncompressed JSON bytes, zstd marker,
degradations and nativeReasoning state against the real frozen codec.
Worktree clean; no HTTP/product TS/IR public-type/dependency changes.

| Category | Rows | First run / commit |
|---|---:|---|
|Three dialects × buffered/streaming (Step A)|6|Prior Auth RED; green da138696|
|B1 reasoning|76|RED row 36: gpt-6-astra vendor effort="invalid"; fixed 310b183f|
|B2 tools|16|First run green; a3fff63f|
|B3 media ingress|36|First run green; 96dcdfc5|
|B4 response format|12|First run green; 9ca9634e|
|B5 dedicated lite/catalog coverage|0|Pending|
|B6 exhaustive OAuth-flag branch inventory|0|Pending|
|B7 stored identity variants|0|Pending|
|B8 cache/history stability pairs|0|Pending|

B1: two models (lite+effort updates gpt-6-astra / non-lite gpt-5.5), seven
portable efforts × three displays, five reasoning modes/defaults, twelve vendor
reasoning values including absent effort, ultra/persistent, invalid string,
null, number, empty and CRLF. Fix separates accepted effort for history update
from metadata fallback. Before fix row 36 added a low-effort update; frozen
omits it. Other invalid rows were not individually run before correction.
B2: two models × single/parallel × answered/orphan × plain/mixed results;
mixed combines tool image/PDF and new user text/image within the same message,
then a new user turn. Mixed flag duplicates the no-result orphan rows.
B3: three actual ingress dialects × buffered/streaming × two models ×
text/plain, application/pdf, application/octet-stream. Includes image forms,
Anthropic result documents, OpenAI attachments, Responses result files/images.
Body and notes match frozen movement/inlining/dropping behavior for those rows;
this is not an exhaustive media-refusal inventory.
B4: two models × six vendor shapes: JSON object/schema, text, text.format,
explicit verbosity plus format, scalar text plus response_format.

Clock/randomness unchanged: explicit startedAt=1794000000123 and
requestId="fixed-oauth-request" on both sides. Credential accountId="account";
stored secrets absent. No random generator invoked by builder; deterministic
fallback IDs compared exactly, no shape-only fields or clock monkeypatch.

Verification after last commit: required three-crate test suite passed with
50 summaries, 223 passes including children, 4 ignored, zero failures; all
three source tripwires, strict all-target clippy, fmt and diff check pass.
Logs `/tmp/opencode/b3/s4b-b4-{tests,clippy,fmt}.log`; category runs
`s4b-reasoning-{red,green}.log`, `s4b-{tools,media,format}-first.log`.
All Rust builds use incremental=0/dev debug=0/test debug=0.

Known differences with concrete examples: HTTP still rejects the OAuth
request's Zstd marker instead of sending compressed JSON; prior empty-string
compression probe differs in bytes (empty-body reachability unresolved).
X1 parked upstream unpaired-surrogate escape and nonnumeric usage-count cases
remain ignored, e.g. escaped lone high surrogate in event text and a string
usage count. This turn did not rerun those ignored comparisons. Credential
refresh/persistence and gateway startup profile capture remain deferred (e.g.
absent stored secrets are deterministically derived, not persisted by builder;
profile is captured at explicit initialize/first library use, not TS import).
No mismatch observed in the 146 compared rows; no broad parity claim.
The invalid-effort history-update difference from Step A is now fixed.

**Next category: B5** all catalog rows/unlisted model, lite switching, prefix
instructions/tools, native reasoning/history ID/provenance paths. Then B6 grep
all OAuth branches and cover each, B7 whole-codec identity variants, B8 paired
cache/thread histories. Step C remains untouched: review all 46 fingerprint
declarations and OAuth SSE codec comparisons; inventory remains 4 ported +66
differential +51 later. Afterwards item 3 depth for OAuth/lite carriers, item 4
HTTP compression including empty-body question, item 5 remaining literals.

## Step A green — HEAD `da138696`

**Item 2: first OAuth builder/codec corpus green; broad parity incomplete.**
Commit `da138696` connects `OpenAiCodec`, selecting OAuth when access_token is
Some (including an empty token), retaining the existing API-key-only entry.
OAuth uses the Codex URL, profile/protocol headers, body zstd marker, shared
identity validation, catalog/turn metadata and lite::to_lite. Turns and media
provenance are recorded during wire assembly; orphan repair inserts None turn
metadata for inheritance. No HTTP implementation change. Test is unignored.

| OAuth corpus category | Rows | Status |
|---|---:|---|
|Three dialects × buffered/streaming|6|Exact URL, ordered/cased headers, JSON bytes, encoding marker, notes and decode-state equal|
|Tools single/parallel/orphan, reasoning ladder, images/files|0|Step B pending|
|Response format, lite switching, restrictions|0|Step B pending|
|Stored identity variants, cache/history stability pairs|0|Step B pending|
|OAuth upstream SSE|0|Step C pending|

First RED remains row 0 Auth in `s4b-red-executing.log`. Implementation first
compile failed at Map-versus-Value credential identity input (`s4b-a.log`),
fixed by sharing the reader through a borrowed lookup closure. First executing
implementation comparison passed all six; no header/body mismatch observed.
Clippy then found test-only encode wrapper, tuple type complexity and discarded
fmt Result; corrected. Header insertion order also corrected by inspection so
operator order overrides retain frozen protocol insertion order.

Clock/randomness: both oracle and Rust receive startedAt=1794000000123 and
requestId="fixed-oauth-request"; accountId="account", stored secrets absent.
Neither request builder calls a random generator; fallback identities derive
deterministically. No clock patch, random override or shape-only comparisons.

Gates passed on committed contents: 50 summaries, 223 passes (including child
summaries), 4 ignored, zero failures. All three tripwires pass in the three-crate
suite; strict all-target clippy, fmt and diff check pass. Logs
`/tmp/opencode/b3/s4b-a-final-{tests,clippy,fmt}.log`; builds use incremental=0,
dev debug=0, test debug=0. Prior 247 API request rows remain green.

Known differences/deferred concerns: HTTP still refuses body encodings;
prior compression probe empty-body difference unresolved; X1 unpaired-surrogate
and nonnumeric usage ignores unchanged. Credential persistence and gateway
startup profile capture remain deferred. OAuth depth not audited. Broad OAuth
restrictions, provenance edge cases and stored identity behavior are implemented
but not yet established by whole-codec corpus. Inspect effort-update selection
for invalid vendor effort: frozen omits history update while metadata falls back;
current builder uses the metadata fallback for both (outside these six rows).
Fingerprint inventory unchanged: 4 ported +66 differential +51 later; 46
fingerprint declarations still require Step C review. No new literal claim.

**Next:** Step B one category/commit, starting tools single/parallel/orphan and
mixed tool media, then effort ladder (including invalid vendor effort noted
above), files/formats, lite models, restrictions, identity variants and paired
history stability. Step C only after B: all 46 dispositions and OAuth SSE codec
comparison. Then roadmap item 3 OAuth/lite depth, item 4 HTTP compression and
empty-body question, item 5 remaining literals.

## OAuth RED-only checkpoint — HEAD `9e467195`

**Item 2 remains incomplete: no OAuth builder implemented.** Commit
`9e467195` adds a real frozen-codec oracle and Rust comparison, explicitly
ignored pending implementation. This is evidence scaffolding, not parity.
Run `cargo test --offline -p omni-providers --test openai_oauth_request -- --ignored`
to reproduce. The test currently invokes OpenAiApiKeyCodec with an OAuth-only
credential; replace that with the credential-selecting codec when implemented.

| OAuth corpus category | Generated rows | Observed comparison |
|---|---:|---|
|Three client dialects × buffered/streaming|6|Row 0 fails Auth; remaining rows not reached|
|Tools, parallel/orphans, reasoning ladder, media/files, formats|0|Pending|
|Cache/history pairs, lite switching, restrictions|0|Pending|
|Stored identity variants|0|Pending whole-codec comparisons|

First compile attempt failed because BodyEncoding is not Serialize
(`s4b-red.log`); harness corrected to map its Zstd variant to `zstd`.
First executable RED is buffered Anthropic row 0: `openai credential has no
token` (`s4b-red-executing.log`). Oracle produces all six rows successfully.
Assertions prepared for URL, ordered/cased headers, uncompressed body string,
encoding marker, degradations and nativeReasoning decode state.
Both sides receive requestStartedAt=1794000000123 and
requestId="fixed-oauth-request". No clock monkeypatch or random generator
override: frozen builder derives IDs deterministically with these inputs;
stored secrets absent, accountId="account". No random-by-design fields have
been compared by shape in this checkpoint.

Fingerprint disposition unchanged: 46 declarations still await this session's
requested review; overall prior inventory remains 4 ported +66 differential
+51 later. No new literal coverage claimed. No OAuth SSE comparison added.
Known differences remain: OAuth request unsupported in Rust; HTTP encodings
refused; compression empty rows differ in prior probe; parked X1 surrogate and
non-numeric usage mismatches unchanged. Prior identity persistence and startup
environment-capture integration remain deferred. No product TS/HTTP changes.

Verification: required three-crate suite passed: 50 summaries, 222 passes
including child summaries, 5 ignored (new OAuth RED plus prior 4), zero
failures. Three source tripwires pass within that suite. All-target clippy
`-D warnings`, fmt check and diff check pass. Logs `/tmp/opencode/b3/s4b-`
`{tests,clippy,fmt}.log`; Rust builds used all three requested environment flags.

**Precise next step:** finish item 2: read remaining frozen profile/identity and
lite sections, implement crate-private catalog/codexTurn and OAuth wire options,
populate positional turns/tool parts during assembly and orphan repair, reuse
identity reader and lite::to_lite; connect credential-selected codec, unignore
and pass these six comparisons, then expand requested corpus and review all
46 fingerprint declarations. Codec decode is shared in frozen codec.ts:130–133;
nativeReasoning comes from original client vendor include, not OAuth defaults.
After item 2: item 3 depth for OAuth/lite carriers; item 4 HTTP compression
including empty-body reachability/parity; item 5 remaining literals.

## Lite sub-checkpoint — HEAD `da0dcbf8`

**Item 2 remains incomplete. Next: add codexTurn/catalog selection and OAuth
wire/codec builder, first failing real-TS whole-request comparison.** Reuse
crate-private lite::to_lite; its positional turns/tool_parts must be populated
during wire assembly, including orphan repair/mixed media, not guessed from
final item roles. See conformance/openai-lite.md. Worktree clean.

| Item | Status |
|---|---|
|0 encoder|Accepted previous 34954c2c, exact pin/licences below|
|1 identity|Complete helper checkpoint 646e38b3; persistence deferred|
|2 OAuth request|Partial da0dcbf8: isolated lite assembly only; no OAuth builder/codec yet|
|3 depth|Pending 40k tests/mutations for lite and future OAuth carriers|
|4 HTTP|Pending; refusal unchanged; empty-body reachability/parity still must be resolved|
|5 literals|Pending, inventory unchanged|

| Corpus | Rows | Observation |
|---|---:|---|
|Lite helper|24|2 lite modes ×2 identity/time modes ×3 histories ×2 prefix/effort modes; exact JSON bytes/key order equal|
|Whole OAuth codec|0|Not yet implemented|
|Frozen literals|121|4 ported +66 differential +51 later unchanged|
|Compression probe (prior)|24|22 identical; both empty rows differ, all decode exactly|

Lite history includes text/image, assistant annotation replacement, function
call/output, reasoning passthrough replacement, file tool provenance, unknown
native item. Prefix tools/schema/instructions and effort insertion compared.
First RED missing module s4-lite-red.log. Intermediate compile corrected
js::to_string argument; first executing harness corrected expected row count
48→24. No production byte mismatch observed in these 24 rows thereafter.

| Mutation | Result |
|---|---|
|Suppress lite base-instruction provenance|Fails real-TS row 13, s4-lite-mutation.log; restored green|
|Depth mutation|Not yet run; no claim of proven deep safety|

Ownership by inspection: LiteArgs iteratively releases input/tools; output is
deep::Owned; intermediate JSON assembly within deep::scope, replacements use
deep::insert, removed reasoning passthrough uses deep::drop. Exact tripwire
exception for history Vec::insert shifts elements without replacing/dropping
them in the scope. All three tripwires pass; no public API or IR type changes.

Verification: three-crate tests pass, 49 summaries totaling 222 passed/0 failed/
4 ignored **including subprocess summaries**; clippy all-targets -D warnings,
fmt check, offline gateway build pass. Logs /tmp/opencode/b3/s4-lite-
{tests,clippy,fmt,build}.log; restored targeted comparison 1 passed in
s4-lite-green.log. Required CARGO settings used. No scratch retained.

Known differences unchanged: X1 surrogate/non-numeric usage, depth policy,
empty compressed frame representation. OAuth/lite not connected and HTTP
compression not implemented; no wire/capture or fingerprint completeness claim.
Step 5 remains registration, startup initialize(), router generated catalog,
**persist the OAuth result's provider data, calling ensure_secrets(prior) when
that result is built**, end-to-end driver, dispatch_depth, benchmark-matrix entry.

## Encoder follow-up checkpoint — HEAD `34954c2c`

**Next remains item 2: failing real-TS OAuth request/lite differential first.**
This follow-up resolved the compression prerequisite and measured the encoder;
items 2–5 are not implemented. Worktree clean after commit.

| Item | Status / commit |
|---|---|
|0 encoder|Unblocked: exact approved zstd pin, `34954c2c`|
|1 identity|Previous `646e38b3` unchanged|
|2 OAuth/lite request|Pending|
|3 OAuth/lite depth|Pending|
|4 HTTP compression|Pending; existing transport refusal unchanged|
|5 literals|Pending; 121 =4 ported +66 differential +51 later unchanged|

### Dependency / frame evidence
Exact dependency: zstd 0.14.4 default-features=false; resolved offline with
zstd-safe 8.3.0, zstd-sys 2.1.3+zstd.1.5.7. Also adds jobserver 0.1.35 via cc;
no existing dependency versions changed. Fetched manifest licences, correcting
the provisional earlier note: zstd **BSD-3-Clause**, zstd-safe **BSD-3-Clause**,
zstd-sys **BSD-3-Clause AND BSD-2-Clause**. Controller permits unsafe inside
dependencies; no application unsafe added. Raw blocks/external executable rejected.

| Frame category | Rows | Observation |
|---|---:|---|
|Sizes 0,1,7,62000,128KiB±1/at,507000,2MiB±1/at,8MiB × repeating/xorshift bytes|24|22/24 SHA-256 identical to frozen runtime; all 24 standard-decoded exactly|
|OAuth corpus frames|0|Not yet assembled|
|Identity corpus (prior)|96 hash +16 secret rows|Unchanged; suite green|

Exact differences: both size=0 cases produce 9-byte frames; Rust header
`28 b5 2f fd 20 00`, TS header `28 b5 2f fd 00 58`. All nonempty probe frames
match. No general compressed-byte equivalence claimed. First RED used plain
bytes and failed the real TS hash; actual streamed encoder then failed the
strict equality check on empty input. Equality is now diagnostic as requested;
decompression remains asserted. Prior identity mutation unchanged; no new depth
mutation claimed. Logs under /tmp/opencode/b3: s4-zstd-red.log and
s4-zstd-green.log. No HTTP/local-stub/capture assertion claimed yet.

Gates passed: offline check; offline omni-gateway build once
(`s4-zstd-gateway-build.log`); three-crate tests (`s4-zstd-tests.log`, 43 Running
suites, 49 summaries totaling 221 passed/0 failed/4 ignored **including child
summaries**); all three source tripwires; all-targets clippy -D warnings
(`s4-zstd-clippy.log`); fmt check (`s4-zstd-fmt.log`).

Persistence finding by inspection: codec.ts:43–45 only reads secrets.
oauth.ts:146–170 puts ensureCodexSecrets(prior) in returned providerData on
exchange/refresh. Step 5 must persist OAuth result providerData with credential
updates; the provider OAuth result builder must call ensure_secrets(prior).
No request-time persistence should be added.

Known differences remain the two X1 cases and 40,000 depth policy below, plus
the observed empty-frame representation difference. OAuth/lite and HTTP support
remain absent. After items 2–5, next gateway step remains registration, startup
initialize(), router catalog from generated descriptors, identity persistence,
end-to-end driver, dispatch_depth cases, and benchmark-matrix entry.

## Step 4 checkpoint — 2026-11-14, HEAD `646e38b3`

**Next: item 2, first failing real-TS OAuth codec/lite differential.** Read
`conformance/openai-identity.md` and `openai-compression.md`; reuse crate-private
identity reader and existing `omni_crypto::codex` primitives. Items 0–1 are this
session's checkpoint; no OAuth request implementation is claimed.

| Item | Status | Commit |
|---|---|---|
|0 compression prerequisite|Inspected; offline encoder blocked, options below|`2a468bb8`|
|1 identity|Reader/backfill/random generation + existing hash primitives compared; persistence deferred|`646e38b3`|
|2 OAuth request/lite|Not started|—|
|3 OAuth/lite depth|Not started; identity structurally safe by inspection below|—|
|4 HTTP compression|Deferred pending encoder decision|—|
|5 literal inventory|Unchanged; all 51 still later pending full OAuth assertions|—|

### Corpus / literals / verification
| Category | Count | Result |
|---|---:|---|
|Identity hashes|96|8 seeds ×3 salt choices ×4 instants; keyed/v4/v7/thread/prefix/instant/UUID matches|
|Stored secrets|16|read + deterministic backfill matches; absent/partial/complete and malformed values|
|Production random generation/preservation|1 test|UUID version/variant, salt length, distinct samples, no remint on valid stored data|
|Prior API request corpus|247|Existing suite passed|
|Frozen literal inventory|121|4 ported +66 named differential +51 later (unchanged)|

Full requested `cargo test --offline -p omni-providers -p omni-ir -p omni-dialects`
passed (`s4-tests.log`): 42 Running suites, 48 successful summaries totaling
220 passed /0 failed /4 ignored **including subprocess summaries**, not a unique
test count. Both X1 ignored tests remain unchanged. All three source tripwires
passed. Clippy all-targets -D warnings and fmt --check passed (`s4-clippy.log`,
`s4-fmt.log`). Required CARGO_* settings used. Final targeted identity run:
2 passed (`s4-identity-green.log`). Logs under `/tmp/opencode/b3/`.

First RED was the missing identity module (`s4-identity-red.log`). First
executing comparison failed hash row 0 on serde integer-vs-float equality of
the same instant; test fixed to compare f64 (intermediate log overwritten).
No production hash mismatch observed in corpus. Initial source tripwire found
two UUID byte writes; added exact exceptions justified as fixed [u8;16], not
JSON. Initial clippy found byte-char-slices in test; corrected.

| Mutation | Observation |
|---|---|
|Remove installation UUID validation|Real TS comparison fails stored row 9: empty string retained vs absent; `s4-identity-mutation.log`; restored green|
|Identity deep JSON|No mutation claimed: two borrowed root lookups only; arbitrary values never cloned, retained, replaced or dropped; only validated strings owned|

### Item 0 findings (full)
Frozen `http-client.ts:160–207`: UTF-8 Buffer into
`new CompressionStream("zstd", {level:3})`, one write and close, concurrently
drained output. No size threshold. Source documents streamed unpledged size,
no frame content size, non-single-segment and 2 MiB window; these frame details
were inspected, not independently measured here. OAuth codec always sets
bodyEncoding=zstd and retains uncompressed JSON for capture. Protocol inserts
content-encoding before content-type; profile default orders it after accept
and before content-type. Transport copies headers, removes none, does not add
content-encoding, and appends Content-Length of **compressed bytes** for a
nonempty source body without supplied length. CodecAdapter rejects encoded
requests containing any content-length or lacking exactly one matching
content-encoding; it does not strip headers.

Cargo.lock has no zstd crate. Local cache contains only ruzstd-0.7.3 (MIT),
whose manifest says decoder and lib exports FrameDecoder/StreamingDecoder,
not an encoder. No usable offline encoder found. Rust rejects body_encoding at
`crates/omni-providers/src/http/mod.rs:248–249`; unchanged. No dependency added.
Options needing controller decision:
1. Provision `zstd` and dependency closure (MIT wrapper family; native upstream
   BSD-3-Clause; verify exact selected package metadata before addition). Fetch
   required before offline build. Streaming level 3 can target frozen shape.
2. Explicitly authorize raw/uncompressed zstd blocks: standard-valid but larger
   than JSON, no compression. No hand-rolled encoder implemented.
3. External encoder executable introduces runtime dependency/process overhead;
   executable availability not checked. Direct system-library FFI would violate
   this increment's no-unsafe rule.
Acceptance remains exact decompressed bytes + encoding header/order + valid
standard-decodable frame; compressed-byte identity not tested without encoder.

### Differences / remaining scope
- Existing X1 unpaired-surrogate events and nonnumeric usage differences below
  remain untouched, as does the 40,000 depth policy.
- OAuth request/lite/transport not implemented in this checkpoint. Salted OAuth
  cache selection and history IDs remain item 2; identity helpers themselves
  match the tested valid hash input domain and malformed stored-field corpus.
- Backfill helper uses injected generators for exact comparison and existing
  rand for production; OAuth credential persistence/connect/refresh not wired.
- No gateway registration, catalog, startup, lifecycle/e2e, push or merge.
- No claim of coverage for malformed UUID namespaces outside normal prefix
  namespace derivation, lone-surrogate identity strings, or arbitrary malformed
  threadInstant inputs beyond the seeds listed in the reference harness.

## Previous checkpoint / history

Status: **step 3 complete, with the two X1 differences**, at the API-key library boundary. Items 3–5 committed, worktree clean at `50d24918`. Next: **step 4: Codex identity/lite, OAuth mode and zstd request body** (decompressed bytes exact, header/order exact, valid zstd; compressed bytes need not match, report whether they do). Gateway registration/startup initialization/catalog/lifecycle/e2e remain step 5. No shared IR/public Usage changes.

## Final step-3 completion
- Item 2 disposition: controller parked nonnumeric counts under X1; exact ignored reason now `parked: roadmap X1 (non-numeric upstream usage counts)`.
- Item 3 `ae2bebbf`: decoder depth audit in `conformance/openai-depth.md`. Arguments/unknown/error scope-removal mutations each PASS; logs `decode-noscope-{arguments,unknown,error}.log`. Restored production source unchanged. Structurally safe explanations: arguments remain String, collector owns independent parse scope and iterative ToolUseBlock release; unknown payload parsed into Owned and never retained; error coercion borrows JSON through stack-growing js::to_string. These are NOT claimed as demonstrated mutation failures. Prior native plain-clone mutation SIGSEGV remains the observed failing mutation (`decode-native-clone-red.log`). Restored suite passed `depth-restored-final.log`.
- Item 4 `21b35eda`: all 27 former later-decoder tests mapped in `conformance/openai-literals.md`, six explicit decoder-literal-edge streams added (duplicate message/reasoning done, DONE after completion, in_progress, metadata, keepalive). No original frozen test is parked: X1 tests are additional malformed-value cases. Targeted pass `decoder-literals.log`.
- Item 5 `50d24918`: OpenAiApiKeyCodec implements ProviderCodec, bool state from the same request reaches OpenAiDecoder. Eight real frozen codec comparisons (four include shapes × streaming/buffered), body/ordered headers/events exact. RED absent API `api-codec-red.log`; GREEN `api-codec-green.log`. No OAuth behavior or gateway registration claimed.

### Final corpus counts
| Decoder category | Rows | Result |
|---|---:|---|
| ordinary text |1|equal|
| tools single/parallel/interleaved |4|equal|
| reasoning native/non-native |2|equal|
| usage variants |4|equal|
| terminal combinations |40|equal|
| upstream errors |28|equal|
| malformed/order/long-line/missing terminal |12|equal|
| decoder-literal-edges |6|equal|
| malformed indexes/delta/response/item |34|equal|
| malformed usage |27|19 equal, 8 parked X1|
| Main total |158|150 equal × 3 chunkings: 450 event and 1350 buffered comparisons; 8 parked ×3|
| invalid/truncated UTF-8 |2|6 event +18 buffered equal|
| lone surrogates |4|parked X1 ×3|
| IR→codec→decoder |8|equal|

Frozen inventory totals: 121 declarations = 4 ported +66 named differential +51 later OAuth/lite/fingerprint. openai.test.ts: 49 =47 differential +2 later; CacheKey:19 =1 ported +18 differential; Codec:7 =3 ported +1 differential +3 later; Fingerprint:46 later. Request corpus remains 247 rows.

### Known differences from TS / remaining concerns
1. **X1 lossless text:** upstream JSON events containing unpaired surrogate escapes are dropped. Dropped content followed by valid completion can succeed with missing text/arguments/native data; dropped upstream error becomes premature-completion error. Exact corpus in openai-lossless-blocker.md; no gateway HTTP-path observation claimed.
2. **X1 nonnumeric usage:** eight malformed output/cache count rows: Rust reports numeric 2/0/1 or no numeric value (NaN serialized null), where TS forwards raw string/object/array/bool. Client usage bytes and logged count differ for that request. This disposition is controller-approved; ignored RED remains. Details openai-coercion.md.
3. Explicit JSON depth policy 40,000 differs from unbounded frozen in-process TS; malformed identity/state memory-budget hardening remains a broader gateway concern (current flat indexes use vectors, no added identity cap). No performance claim. Gateway success/failover/cancellation depth lifecycle remains step 5.

Final gates: `cargo test --offline -p omni-providers -p omni-ir -p omni-dialects` passed with **48 summaries, 218 passes including subprocess repetitions, 4 ignored, 0 failures** (`step3-final-tests.log`). Two ignores are parked X1 comparisons; default green does not mean they match. Strict all-target clippy passed (`step3-final-clippy.log`); fmt/diff and all three tripwires pass. All builds incremental=0/dev+test debug=0. No release binary/e2e this increment. Earlier failure chronology preserved below: absent decoder API RED, unknown-event text mutation RED, native clone SIGSEGV, surrogate RED, usage RED (plus corrected oracle NaN round-trip), codec absence RED. No new behavioral mismatch in final six literal-edge/eight codec rows.

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
