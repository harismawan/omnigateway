# Antigravity request-side audit — frozen 1780bb39

One current request inventory; independent re-review remains pending.

| Literal / limit / regex / note | Rust location | Pinning test row |
|---|---|---|
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
| MAX_SCHEMA_DEPTH 24; refuse non-record subschemas | `schema::sub` | 23/24/25/40 hops and 40,000 hops on 2 MiB thread |
| PRUNED = `antigravity:tool-schema-pruned`, deduplicated | `schema::prune` | all 593 rows compare degradation list |
| SCHEMA_TYPES string/number/integer/boolean/array/object/null/type_unspecified | `TYPES`, `walk` | scalar and union type rows, case handling |
| SCHEMA_FIELDS: six walked, four text, three texts, six int, two double, three free fields | `walk` match arms | every field crossed with 21 values |
| const string → enum unless own enum; unknown fields dropped | `walk` | initial four rows, unknown/$ref rows |
| integer spelling `^-?\d+$`; finite whole numbers | numeric match arm | decimal, fractional, exponent, hex, whitespace |
| double strings trim nonempty then Number finite | `js::trim`, `js::try_to_number` | string numeric neighbours |
| tuple items first; arrays of schema arms; empty property key dropped | `walk` | field/type shape matrix |
| structural inference uses original declared type for both agree calls | post-walk repair | inferred versus contradictory types |
| required/propertyOrdering filter to own known property names | post-walk repair | missing-name rows |
| lowercase `array` without items loses type; uppercase preserved | final repair | ARRAY/array rows |
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
| `antigravity:system-{image,thinking,toolUse,toolResult,providerNative}-dropped` | `system::system_text` | wire `system-drop:image/thinking/toolUse/toolResult/providerNative` |
| response reader depth 64; items/additionalItems/additionalProperties/contains/contentSchema/if/then/else/not/propertyNames/unevaluatedItems/unevaluatedProperties; lists anyOf/allOf/oneOf/prefixItems/items; maps properties/patternProperties/$defs/definitions/dependentSchemas/dependencies | `response_format` | shared response-format corpus; wire `format:*`, depth response schema |
| text/*, +json, +xml; application/json, x-ndjson, xml, yaml, x-yaml, toml, javascript, typescript, sql, x-sh; message/rfc822 | `tool_result_files::is_textual` | wire `file:*`, `file:application/x-yaml` |
| `\n\n` joins nonempty content/files; lenient base64, UTF-8 replacement | `tool_result_files::{with_file_text,file_text}` | wire `file:*` empty/hello/invalid UTF-8/invalid base64 |
| `You are a Claude agent, built on Anthropic's Claude Agent SDK.`; `x-anthropic-billing-header:`; `/(?:\r?\n){2,}/` | `wire::fingerprints` | wire `system:*` exact, quoted, CRLF, multiple paragraphs |
| Object.entries root null throws; populated arrays/strings prune index keys; empty arrays/strings, numbers/bools yield {} without note; nested schemas guarded by isSchema | `schema::{try_prune,walk,sub}`, codec null-root check | schema 593 rows, codec 118 rows, `antigravity_build_throw` |
| UPSTREAM / `antigravity codec buildRequest threw`, gatewayAuthored; classified AUTH rebound | `BuildError`, `ProviderCodec::try_build_request`, `adapter::send` | `antigravity_build_throw`; codec null row uses raw frozen TypeError plus adapter classification test |
| nonempty descriptions preserved; duplicate call IDs last name wins | `wire::to_wire` | `description:nonempty`, `description:mixed`, `duplicate-call-id:last-wins`; mutations 29/30 killed |
| `antigravity:agent-preamble-dropped` | `wire::to_wire` / fingerprints | wire `system:*` |
| `antigravity:billing-header-dropped` | `wire::to_wire` / fingerprints | wire `system:*` |
| `antigravity:system-turn-as-user` | `wire::to_wire` / fingerprints | wire `blocks:system:*` |
| `antigravity:cache-control-dropped` | `wire::to_wire` / fingerprints | wire `cache:*` |
| `antigravity:thinking-dropped` | `wire::to_wire` / fingerprints | wire `blocks:user:*thinking*` |
| `antigravity:provider-native-block-dropped` | `wire::to_wire` / fingerprints | wire `blocks:user:*providerNative*` |
| `antigravity:tool-result-unmatched` | `wire::to_wire` / fingerprints | wire `result:false:*` |
| `antigravity:tool-result-error-flag-dropped` | `wire::to_wire` / fingerprints | wire `result:*:true:*` |
| `antigravity:tool-result-files-inlined` | `wire::to_wire` / fingerprints | wire `file:*` |
| `antigravity:opening-turn-added` | `wire::to_wire` / fingerprints | wire `blocks:assistant:*` |
| `antigravity:closing-turn-added` | `wire::to_wire` / fingerprints | wire `blocks:assistant:*` |
| `antigravity:max-tokens-dropped` | `wire::to_wire` / fingerprints | wire `max:*:0 / number:maxTokens:NaN` |
| `antigravity:temperature-clamped` | `wire::to_wire` / fingerprints | wire `temperature:-1 / temperature:2.0000001` |
| `antigravity:stop-sequences-dropped` | `wire::to_wire` / fingerprints | wire `stops:6 / stops:8` |
| `antigravity:reasoning-between-tools-as-off` | `wire::to_wire` / fingerprints | wire `reasoning:betweenTools` |
| `antigravity:thinking-budget-clamped` | `wire::to_wire` / fingerprints | wire `budget:-2:* / budget:65536:*` |
| `antigravity:reasoning-effort-dropped` | `wire::to_wire` / fingerprints | wire `adaptive:*:minimal / adaptive:*:max` |
| `antigravity:response-format-translated` | `wire::to_wire` / fingerprints | wire `format:*` |
| `antigravity:response-schema-too-deep` | `wire::to_wire` / fingerprints | wire `format:*64* / depth response_schema_depth_matches_frozen` |
| `antigravity:max-tokens-clamped` | `wire::to_wire` / fingerprints | wire `max:*:65537 / max:*:1e+21` |
| `antigravity:provider-tool-dropped` | `wire::to_wire` / fingerprints | wire `tools:*provider*` |
| `antigravity:duplicate-tool-dropped` | `wire::to_wire` / fingerprints | wire `tools:*read file*read file*` |
| `antigravity:tool-name-renamed` | `wire::to_wire` / fingerprints | wire `tools:*read file*` |

Depth: all seven depth tests pass without an unconditional scope on 2 MiB threads, including nine extra opaque positions at 39,990 levels. 1,000 shallow builds add zero stack grows. Frozen first throws at 39,994 toolUse.input levels and 39,999 vendor.antigravity.extra levels; Rust serializes in that band (documented engine-limit difference). The prior overflow was a test-fixture artefact.

X1 retained-red: text plus eight paired frozen tests cover non-BMP vendor UTF-16 splitting, lone-surrogate tool name/id, opaque value/key, system, project hashing/body and request-id body. Seven fail at serde surrogate parsing, vendor fails byte comparison. A JSON number beyond double range (1e309) cannot be carried by serde_json::Value/Number without arbitrary_precision (not enabled); no fake input test added. No normalization or shared IR fix.

Coercions: numeric schema conversion is string-guarded; project trim is string-guarded; arithmetic uses typed f64. JSON-only IR excludes cycles/getters/BigInt. Null tool-schema roots are ordinary throws, unlike guarded response-schema roots.

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
