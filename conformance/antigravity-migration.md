# Antigravity codec migration — partial foundation

Oracle: frozen TypeScript at 1780bb39. This note covers only the implemented
cloak and profile. It is **not** a completed codec literal/coercion audit.

| Frozen literal / rule | Rust location | Differential coverage |
| --- | --- | --- |
| `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$` | `antigravity/cloak.rs::valid` | `antigravity_cloak`, legal punctuation, initial digits/dots/dashes, 128/129 lengths |
| `[^A-Za-z0-9_.-]+`, initial `[A-Za-z_]` | `cloak.rs::alias` | Unicode, repeated refused characters, empty name |
| `_`, `_tool`, 128 ceiling, six-character suffix, truncation to 122 | `cloak.rs::alias` | empty/Unicode-only, oversized and colliding names |
| xxHash64 UTF-8, `0xffffff`, lowercase hex padded to six | existing `omni_crypto::cloak::antigravity_suffix` | aliases compared with Bun for all 132 rows |
| portable tools, history tool calls, unmatched result ids, explicit tool choice | `cloak.rs::ToolCloak::build` | all six corpus source modes; result calls may appear later |
| stable insertion order; reserved valid names claim first; suffix every collision | `cloak.rs::ToolCloak::build` | forward/reversed combined names, duplicate names, `read file` / `read/file` / `read_file` |
| `OMNI_ANTIGRAVITY_IDE_VERSION`, `2.12.2` | `profile.rs::headers` | profile vectors |
| `OMNI_UA_ANTIGRAVITY`, `antigravity/ide/`, `darwin/arm64` | `profile.rs::headers` | exact frozen codec header pairs |
| `User-Agent`, `Content-Type: application/json`, `Accept: text/event-stream` | `profile.rs::headers` | exact pairs, casing, order |
| `OMNI_ORDER_ANTIGRAVITY`; Host, Content-Type, Authorization, User-Agent, X-Goog-Api-Client, Accept, Accept-Encoding, Content-Length | `profile.rs::headers` | default and reordered headers; absent names skipped; duplicates consumed once |
| shared header SAFE `[\x20-\x7E]{1,200}` | `profile.rs::safe` | empty, 200/201 bytes, Unicode, control characters, space |
| comma splitting, JS trim, reject invalid entries, default if empty | `profile.rs::headers`, existing `omni_ir::js::trim` | whitespace/BOM/NBSP, duplicates, unknown names |
| import-time environment capture | `profile.rs::initialize` + OnceLock | TS mutation after import; Rust capture ignores a second source |

No arbitrary JSON is cloned or dropped by these components; the cloak only
borrows typed IR names. No JS String/Number coercion sites occur in these two
frozen modules (hash input is already a typed string). Lone-surrogate names are
not covered: the existing Rust IR cannot represent them. No new X1 tests were
added in this partial slice.

Pending literal and coercion audits: all of `codec.ts`, `wire.ts`, `decode.ts`,
model-dependent limits and the envelope body-order array in `profile.ts`.
No 40,000-level depth experiment has been run for this provider yet.

## Turn 2: schema pruning slice

`schema.rs` now ports `pruneSchema` and `scalarValue` from wire.ts. The statement
above about no depth experiment is superseded for tool schemas only.

| Frozen rule | Rust | Test |
| --- | --- | --- |
| MAX_SCHEMA_DEPTH 24; refuse non-record subschemas | `schema::sub` | 23/24/25/40 hops and 40,000 hops on 2 MiB thread |
| PRUNED = `antigravity:tool-schema-pruned`, deduplicated | `schema::prune` | all 574 rows compare degradation list |
| SCHEMA_TYPES string/number/integer/boolean/array/object/null/type_unspecified | `TYPES`, `walk` | scalar and union type rows, case handling |
| SCHEMA_FIELDS: six walked, four text, three texts, six int, two double, three free fields | `walk` match arms | every field crossed with 21 values |
| const string → enum unless own enum; unknown fields dropped | `walk` | initial four rows, unknown/$ref rows |
| integer spelling `^-?\d+$`; finite whole numbers | numeric match arm | decimal, fractional, exponent, hex, whitespace |
| double strings trim nonempty then Number finite | `js::trim`, `js::try_to_number` | string numeric neighbours |
| tuple items first; arrays of schema arms; empty property key dropped | `walk` | field/type shape matrix |
| structural inference uses original declared type for both agree calls | post-walk repair | inferred versus contradictory types |
| required/propertyOrdering filter to own known property names | post-walk repair | missing-name rows |
| lowercase `array` without items loses type; uppercase preserved | final repair | ARRAY/array rows |

Coercion audit of this slice: Number only receives strings, because scalarValue
checks typeof before calling it. Thus an object owning toString is dropped without
invoking coercion; no throwing coercion row applies here. `.trim()` likewise only
receives strings. Free fields are deep-cloned without coercion. Full request-side
coercion audit, JSON stringify edge cases and prototype-special keys remain pending.

Observed contradiction to task: frozen wire.ts clamps **every** model to the
global MAX_OUTPUT_TOKENS 65,536; models.ts advertises 65,535 on Pro. Future wire
implementation must preserve the global constant, not apply per-model ceilings.
No request implementation or test of that ceiling has landed yet.

## Turn 3: request assembly

The preceding pending-request statements are superseded here. `antigravity_wire`
compares 338 complete envelope byte strings and ordered degradation lists;
`antigravity_codec` compares 108 URL/method/ordered-header/body/error results.
`AntigravityCodec::build_request` is inherent: the trait requires a real decoder.

| Frozen literal / rule | Rust location | Pinning rows |
| --- | --- | --- |
| project, requestId, model, userAgent, requestType, request; `antigravity`, `agent` | `wire::to_wire` | every wire row |
| user/model; merge same roles; empty opening, single-space closing | `wire::to_wire` | blocks/roles/result rows |
| `skip_thought_signature_validator`; functionCall/functionResponse/inlineData | `wire::to_wire` | input, result, image and file rows |
| cache-control/system-turn/thinking/provider-native/unmatched/error-flag/files-inlined degradation suffixes | `wire::to_wire` | cache, blocks, result, file rows; first-occurrence ordering compared |
| exact agent preamble; billing prefix; CRLF paragraph split and JS trim | `wire::fingerprints`, existing anthropic/crypto constants | system rows |
| max 65,536 for ALL models; temperature 0..2; first five stops | `wire::to_wire` | max/temperature/stops, including Pro ceiling |
| budget -1..65,535; budget+1 ceiling repair and late insertion position | `wire::to_wire` | budget cross-product; NaN/Infinity/-0 rows |
| betweenTools/off/adaptive display and effort notes | `wire::to_wire` | reasoning/adaptive rows |
| portable tools; first duplicate wins; cloak note before schema pruning | `wire::to_wire` | tools rows |
| AUTO/ANY/NONE; allowedFunctionNames | `wire::to_wire` | choice rows |
| response-format-translated / response-schema-too-deep | shared reader + `schema::prune` | format rows; 40,000-hop schema on 2 MiB stack |
| Object.assign overwrite position, index enumeration, __proto__ setter | `js::object_assign` + jsjson | vendor object/string/array/scalar/null rows |
| daily-cloudcode-pa streaming URL, POST, Authorization Bearer | `codec::build_request` | all successful codec rows |
| AUTH missing-token and missing-project messages | `codec::build_request` | invalid-token/project cross-product |
| `omni-antigravity-req`, SHA256 UUID slices, version 4, variant mask 3/or 8 | `codec::build_request` | derived versus explicit/empty/space ids |

Coercion audit: wire fingerprint `.trim()` receives joined text strings;
generation arithmetic (including budget + 1) receives f64 fields, including
nonfinite values exercised by explicit transport overrides. Schema `Number()`
and `.trim()` have string guards (turn 2). Codec project `.trim()` has an explicit
typeof-string guard. Seed, namespace, UUID and Authorization templates receive
typed strings; parseInt receives one SHA256 hex character. Thus none of these
sites receives an arbitrary nonprimitive through Rust IR. JSON.stringify is a
separate failure boundary: cycles/getters/BigInt/functions are not JSON IR values.
An object-valued format name with toString:null is retained in the corpus without
coercion. Tool result content is String and cannot nest.

**Unresolved depth boundary:** frozen JSON.stringify throws
`RangeError: Maximum call stack size exceeded.` for 40,000 nested `items` in tool
input and vendor.extra. Rust's input path overflowed a 2 MiB stack; retained-red
ignored test `retained_red_deep_tool_input_serialization` records this gap. Vendor
Rust depth parity remains unverified. No shared helper change was made. The
response-schema case is green because the reader drops it before serialization.
X1 lone-surrogate text (`"\ud800"`) remains ignored and unnormalized. Non-BMP
vendor strings also need X1 coverage: Object.assign splits UTF-16 code units.
Decode, full depth parity and independent review remain pending; B4 is incomplete.

## Turn 4: request depth boundary

The retained ignored depth test is replaced by five active 2 MiB-thread tests
through `AntigravityCodec::build_request`: tool input, vendor.extra, tool schema,
and response schema at 39,990 levels compare body length and SHA-256 with frozen
Bun; tool input at 39,996 asserts successful serialization. All five pass.
`build_request` now encloses encoding, serialization and body disposal in
`deep::scope`, consistent with the sibling codecs. The wire path already uses
deep clone/insert/drop for client Values.

Documented difference: Rust grows its stack rather than emulating JSC's stringify
stack threshold. Controller measurements place the first frozen tool-input failure
at 39,994 nested levels and vendor.extra failure at 39,999; successful Rust
serialization in this narrow band is intentional. Ingress still rejects JSON
beyond MAX_DEPTH. These tests build IR iteratively and do not extend ingress.

Important contrary evidence: the valid 39,990 input test also passes at baseline
and with the added scope removed (mutation log `turn4/depth-mutation.log`). Thus
this session does **not** establish that missing scope caused the predecessor's
abort, nor identify a product line that overflows. An initial test-fixture attempt
using an ordinary recursive serde deserializer inside a 16 MiB scope SIGSEGV'd;
the replacement builds the nested Value iteratively. That fixture failure is not
evidence of a codec defect. The scope is defensive hardening, not a demonstrated
crash fix. No product red commit is justified by these measurements.

## Decoder port (turn5, frozen 1780bb39)

1,020 SSE-byte corpus rows compare complete events and whether the generator throws;
five additional depth rows compare tool JSON bytes, on a 2 MiB Rust thread.
The oracle imports the frozen decoder and `parseSse`. Throw diagnostics are retained
in the oracle; `DecodeError::Throw` delegates client-facing classification to the
existing adapter (`antigravity codec decode threw`). No brief/code behavioral
contradiction was found in the decoder reading.

### Literal and branch audit

Locations below are in `crates/omni-providers/src/antigravity/decode.rs`;
pinning rows are named by `tests/antigravity_decode-reference.ts`.

| Frozen lines / literals | Rust location | Pinning row |
|---|---|---|
| 40 STOP → endTurn | `inner`, reason match | `stop/STOP` |
| 41 MAX_TOKENS → maxTokens | reason match | `stop/MAX_TOKENS` |
| 42–46 SAFETY, PROHIBITED_CONTENT, SPII, BLOCKLIST, RECITATION → contentFilter | reason match | corresponding `stop/*` |
| 51 RESOURCE_EXHAUSTED → RATE_LIMIT | status match | `error-code/RESOURCE_EXHAUSTED` |
| 52–53 UNAUTHENTICATED, PERMISSION_DENIED → AUTH | status match | corresponding `error-code/*` and `wrapped-code/*` |
| 54–55 INVALID_ARGUMENT, FAILED_PRECONDITION → BAD_REQUEST | status match | corresponding `error-code/*` |
| 56–57 UNAVAILABLE, INTERNAL → UPSTREAM | status match default | corresponding `error-code/*` |
| 58 DEADLINE_EXCEEDED → TIMEOUT | status match | `error-code/DEADLINE_EXCEEDED` |
| 99–105 JSON object/array acceptance | bounded parse, frame shape guard | `frame/*`, `invalid` |
| 108–126 finite numeric counts, zero fallback, prompt/cache subtraction | `usage` | `count-*/*`, `nonfinal-usage` |
| 136–145 false flags, zero indices, open block closure | decoder state, `close` | `alternation`, `empty` |
| 149 `[DONE]` | `inner` early return | `done` |
| 159–172 nullish error precedence, empty status, `upstream error`, RETRYABLE | failure branch | `error/*`, `wrapped-error/*`, `failure-*/*` |
| 175–189 absent response, blockReason, empty id/model, contentFilter | response/blocked branches | `response/*`, `blocked/*` |
| 192–199 start id/model | start branch | `responseId/*`, `modelVersion/*` |
| 201–217 zero/default candidates, multiple-candidate literal, retryable false | length check | `candidates/17`, `candidates/12` |
| 220–224 candidate/content/parts nullish chain; iteration; null call throws | candidate/parts loop | `candidate/*`, `content/*`, `parts/*`, `part/*`, `functionCall/*` |
| 225–255 toolUse, nonempty upstream id, `fc_`, toolJson, `{}`, blockEnd | tool branch | `alternation`, `id/*`, `args/*`, `raw-args/*`, `cloak` |
| 258–277 string-only text, strict thought true, text/thinking blocks and deltas | text branch | `text/*`, `thought/*`, `alternation` |
| 280–286 nullish finish, close before coercion | finish branch | `finishReason/*` |
| 288–295 MALFORMED_FUNCTION_CALL, BAD_REQUEST, `the model emitted a malformed function call`, false | reason match | `stop/MALFORMED_FUNCTION_CALL` |
| 298–307 unknown/prototype reason, UPSTREAM, `unrecognized Antigravity finish reason`, false | reason match default | `stop/unknown`, `stop/toString`, `stop/__proto__`, `stop/constructor`, `stop/hasOwnProperty` |
| 309–318 toolUse outranks mapped finish; final-frame usage | end branch | `tool-stop/*`, `nonfinal-usage` |
| 321–328 UPSTREAM, `upstream stream ended before the response finished`, true | `finish` | `empty`, `done`, `response/*` |

### Throwing coercion sites

| Frozen line | Rust site (line at audit) | Throwing row |
|---|---|---|
| 163 failure.status | `inner` status / 116 | `failure-status/18` |
| 169 failure.message | `inner` message / 124 | `failure-message/18` |
| 196 responseId | `inner` id / 160 | `responseId/18` |
| 197 modelVersion | `inner` model / 161 | `modelVersion/18` |
| 286 finishReason | `inner` raw / 258 | `finishReason/18` |

All call `string` → `omni_ir::js::try_to_string`; already-yielded events remain
queued on a throw. Null error/response/part/functionCall and noniterable parts
also return `DecodeError::Throw`. Candidate length additionally uses JS numeric
coercion for `> 1` and string coercion for the diagnostic.

### Depth and retained differences

Frozen Bun succeeded at args nesting 100, 1,000, 5,000, 10,000 and 39,990;
Rust produced the same five-event sequence and identical tool JSON at every
depth on a 2 MiB thread. Evidence: `/tmp/opencode/b4/turn5/depth.json` and
`trait.log`. No stack-limit divergence was observed on this runtime.

Retained-red X1 inputs: text `"\\ud800"`; functionCall args `"\\ud800"`;
responseId numeric literal `1e309`. Separate ignored tests retain each case.
Non-numeric usage is counted as zero here, so the ordinary corpus covers it
without the shared nonnumeric-carrier gap.

The inherent request entry point remains as a trait-forwarding compatibility
shim: existing `antigravity_depth.rs` calls it without importing ProviderCodec,
and that file is outside this task's edit scope. Request construction is unchanged.
Gateway registration, profile initialize capture, OAuth and gateway e2e remain
next work, after independent decode-side review.
