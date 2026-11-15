# B4 request-side independent review

**Verdict: REQUEST CHANGES.** Reviewed detached `1fd5fb8d8a9e28672676ab5efcdbb3e87c9dbf8e`, against frozen `1780bb39`. Frozen request sources in this checkout have no diff from that commit. Bun 1.4.4. No provider traffic, commits, subagents, or edits in the implementer's worktree.

## Important findings

### I1. Non-object tool schemas silently lose frozen errors and degradation notes

Frozen `packages/providers/src/antigravity/wire.ts:485` uses `Object.entries(node)` without a root schema guard. Rust `crates/omni-providers/src/antigravity/schema.rs:40–41` iterates `node.as_object().into_iter().flatten()`, treating every other value as an empty object. `CustomToolDef.input_schema` is a `Value`, so these values are representable in Rust; this is not X1. Although the TS static declaration says record, the supplied exact-behaviour contract includes all Rust IR carriers.

Minimal input (codec model `m`, access token `t`, project `p`, request ID `r`):

```json
{"model":"m","stream":true,"messages":[],"tools":[{"kind":"portable","name":"t","inputSchema":null}]}
```

Frozen throws **TypeError: Object.entries requires that input parameter not be null or undefined**. Rust succeeds with no notes and body:

```json
{"project":"p","requestId":"r","model":"m","userAgent":"antigravity","requestType":"agent","request":{"contents":[],"tools":[{"functionDeclarations":[{"name":"t","parameters":{}}]}]}}
```

Replace `null` with `[1]` or `"x"`: both emit that body, but frozen notes are `["antigravity:tool-schema-pruned"]` and Rust notes are `[]`. Empty array, number, and boolean controls agree. Exact paired URL/headers/body/error evidence: `minimal-differences.json`. Fix root Object.entries semantics and retain tests for these three shapes; do not classify this as a surrogate gap.

### I2. Required X1 retained-red coverage is incomplete

Frozen `wire.ts:953`, Rust `wire.rs:341`, shared `omni-ir/src/js.rs:372`. Minimal request:

```json
{"model":"m","stream":true,"messages":[],"vendor":{"antigravity":"🙂"}}
```

Frozen request object bytes: `{"0":"\ud83d","1":"\ude42","contents":[]}`. Rust: `{"0":"�","1":"�","contents":[]}`. Other envelope fields and notes agree. All **78** independent fuzz differences were this class. This is the parked X1 representation gap, not a request to resolve the shared IR now; the required ignored, unnormalised regression is missing. Only Antigravity's lone-surrogate *text* ignored test exists. Also missing provider-specific retained cases for lone-surrogate tool names/IDs, nested opaque JSON strings/keys, system strings, credential project/request ID hashing, and out-of-double-range JSON values. The handoff explicitly acknowledges some of these omissions. No unrelated difference was hidden behind X1 in the tests reviewed.

### I3. Every shallow codec request allocates a stack segment unnecessarily

Rust `codec.rs:18` unconditionally calls `deep::scope`; frozen `codec.ts:104–151` has no corresponding operation. Minimal empty request as above without tools: output bytes equal, but on a 2 MiB thread 10,000 builds produce **10,000 grows** versus **zero** with the scope removed. Debug timings: **41.8787601 µs/request scoped**, **10.7292245 µs/request unscoped** (10,000 iterations each, fixed explicit request ID, includes build and result drop). These are unoptimized measurements, not production latency claims; no release build used. The exact growth count and passing no-scope deep probes establish the unnecessary common-path work independently of optimization. Gate it as sibling codecs do, or remove after auditing all ownership paths. The earlier fixture abort does not establish a product need for this scope.

## Minor findings

### M4. Committed tests do not detect destruction of non-empty descriptions

Frozen `wire.ts:939–942`, Rust `wire.rs:310–312`. Mutation 29 replaces every present description with `""` and **survives all six committed targets**. Minimal request: `{"model":"m","stream":true,"messages":[],"tools":[{"kind":"portable","name":"t","description":"d","inputSchema":{}}]}`. Frozen and baseline Rust declaration: `{"name":"t","description":"d","parameters":{}}`; mutated Rust: `{"name":"t","description":"","parameters":{}}`. Add the frozen non-empty-description fixture. This is a corpus gap, not a baseline mismatch.

### M5. Committed tests do not pin last-wins duplicate tool IDs

Frozen `wire.ts:106`, Rust `wire.rs:81`. Mutation 30 changes last-write-wins to first-write-wins and **survives all six committed targets**. Minimal request: `{"model":"m","stream":true,"messages":[{"role":"assistant","content":[{"type":"toolUse","id":"i","name":"a","input":{}},{"type":"toolUse","id":"i","name":"b","input":{}}]},{"role":"user","content":[{"type":"toolResult","toolUseId":"i","content":"ok"}]}]}`. Frozen and baseline Rust functionResponse name: `"b"`; mutated Rust: `"a"`. Add this paired regression. The independent random run includes duplicate IDs, but the committed tests do not enforce this rule.

### M2. Renamed-tool lookup regresses from Map lookup to linear scan

Frozen `cloak.ts:151–152` uses `cloak?.toWire.get(name)`; Rust `cloak.rs:113–117` searches a Vec. A request with N distinct invalid names (`"tool 0"` through `"tool N-1"`) and N declarations produces the same bytes, but declaration lookup performs N(N+1)/2 comparisons in Rust instead of N map lookups in frozen. Minimal paired two-name input has names `"tool 0"`, `"tool 1"`, empty schemas; both produce `tool_0` and `tool_1`, while Rust scans 1+2 entries. Keep stable iteration storage and add a lookup index. This is a static complexity finding; no large-N timing was performed.

### M1. Literal inventory is incomplete and contains stale depth claims

`conformance/antigravity-migration.md` aggregates many rules but does not list every literal/note with a concrete pin. Missing explicit inventory includes shared system notes `antigravity:system-{image,thinking,toolUse,toolResult,providerNative}-dropped` (`system.ts:63`), response reader depth **64** and all subschema-position names, file textual MIME vocabulary (`application/x-yaml` is absent from the provider corpus), file `\n\n` concatenation/filtering and UTF-8/base64 semantics, complete fingerprint strings and the literal `/(?:\r?\n){2,}/`, plus exact strings for several clamping/duplicate/tool-name notes that are summarized only by category. The document's earlier pending/overflow assertions require following later supersession sections; TSV rows 175–176 still say “40000-level serialization unresolved.” Update the request audit to one current authoritative table.

## Independent differential experiment

`generate.py`: deterministic seed 756332; **20,000 requests, 19,922 equal, 78 different**, all body-only X1 vendor string splitting. URL, ordered headers, notes, cloak count and errors agree in the random run. `requests-fuzz.jsonl`, `ts-fuzz.jsonl`, `rust-fuzz.jsonl` preserve full inputs/results. `compare-rerun.log` holds counts. An initial comparison script incorrectly used Python `splitlines()` on literal Unicode line separators; corrected to split only LF, without changing inputs/results.

Coverage includes every top-level IR field, all content kinds, empty arrays, duplicate names/IDs, Unicode, numeric limits/fractions/-0, nested opaque values, randomized key order, schema keywords, options/citations/native payloads, ignored provider headers and betas, tool choice and response schema. Limitations: generator did not include provider-owned tool definitions (committed tests do), infinity/NaN transport overrides (audited committed tests do), very wide arrays, all response-format precedence combinations, or root non-object schemas (seven separate minimal probes added). Thus 20,000 is not a claim of exhaustive state-space coverage. Seven additional minimal probes: **3 equal, 4 different** (one error, two notes, one X1 body).

## Depth and ownership

`b4_review.rs` (preserved with evidence after cleanup) builds nested arrays iteratively at **39,990 levels**, inside explicit **2 MiB** threads. It builds/serializes the codec result and explicitly drops result (including cloak), request and credentials. Both configurations pass:

| Position | Scope | No scope |
|---|---|---|
| toolUse.input | PASS | PASS |
| inputSchema.default (opaque free value) | PASS | PASS |
| portable tool options | PASS | PASS |
| vendor.antigravity value | PASS | PASS |
| response-format schema.default | PASS | PASS |
| providerNative.data | PASS | PASS |
| system providerNative.data | PASS | PASS |
| toolResult.native[].data | PASS | PASS |
| provider tool wire | PASS | PASS |
| providerHeaders | PASS | PASS |
| text citations | PASS | PASS |

Committed four 39,990-level frozen SHA/length comparisons and the 39,996 band test also pass with scope removed (`no-scope.log`). Input/tool schemas and vendor use existing iterative/deep-aware helpers; prune recursion is capped at 24; response schema traversal is iterative. No product stack overflow reproduced. These experiments support stack safety on these carriers but cannot mathematically prove “every possible value”; public `to_wire`/`prune` return raw Values whose callers must deep-drop, as their API inventory states. Ordinary recursive serde fixture parsing remains unsafe and was intentionally not used. Tool result text/files/images are typed strings, not nested JSON carriers.

## Line-by-line behavioural and coercion audit

* `wire.ts:102–109` / Rust 78–83: duplicate IDs use last name; future calls are considered. Rust HashMap lookup reproduces JS Map here. Same-role merge preserves parts and empty turns disappear; result flips role before merge. Opening checks only first part; closing uses a single space. Files append after result images. Notes deduplicate in first-occurrence order.
* Fingerprints: exact preamble equality and case-sensitive billing-prefix match after JS whitespace trim; paragraph split accepts mixed CRLF/LF runs; untouched input returned verbatim; removal emits preamble note before billing note regardless of encounter order. Rust byte scanning slices only newline boundaries. No difference found.
* `wire.ts:316–345,474–647`: schema field kinds, depth 24, tuple first arm, const/enum own-presence, free values, original declared type for both structural repairs, own property-name filtering and lowercase-only final array deletion match. Root nonobjects are I1. Object property enumeration uses shared JS serializer ordering. Numeric schema Number conversion is string-guarded; throwing object coercion cannot reach it.
* `wire.ts:799–901`: f64 max, temperature and budget fields can carry NaN and infinities in-process. Committed oracle clones request, then assigns special values before encoding; Rust assigns the same f64 after deserialization. This mechanism is sound. NaN compares unequal, emits the appropriate note, and serde JSON null matches JSON.stringify null; infinities clamp or drop, -0 prints 0. Positive budget repair occurs after response schema and preserves an existing key's position, or appends a new key. Global output ceiling 65,536 confirmed for every model.
* Stop sequences are Vec<String>; slice length min(5) matches JS slice(0,5). Adaptive effort presence and updates/omitted visibility match. No arbitrary-value coercion at arithmetic sites.
* `wire.ts:905–953`: first duplicate declaration survives; cloak note precedes schema note; absent description omitted; explicit choice can name undeclared tools. Vendor Object.assign overwrites own existing keys without relocation, enumerates array/string indices, ignores scalars and uses __proto__ setter semantics through shared helper. Non-BMP string exception is I2.
* Cloak: all accepted names and all sanitized bases are ASCII, so byte versus UTF-16 length is equivalent *after* sanitization. Refused Unicode runs collapse identically; valid names reserve bases; forced aliases truncate to 122 then append six hex digits; collision suffixes and last reverse-map winner match. A collision can still exceed 128 if a contested base is already 128: this is also frozen behaviour, not a Rust regression. Rust linear `name()` search does introduce quadratic lookup work in the number of renamed tools, unlike frozen Map lookup; no stress benchmark quantified this.
* Codec String/template sites: namespace+model+project seed, UUID version/variant assembly and Bearer token all take typed strings. Project trim is type-guarded; null/nonstring/blank project rejects after token validation. Request ID length check accepts whitespace. Hex indexing is on a 64-character lowercase SHA256 ASCII digest, not client text; `from_str_radix(...).expect` cannot fail on that invariant. Version nibble 4 and variant `(n & 3)|8` match.
* Profile template receives validated ASCII strings. Header merge/order case-insensitive comparison is equivalent for actual codec ASCII names; exported Rust helper's arbitrary Unicode extra names are not covered by frozen codec inputs. Env SAFE length 1–200, comma split and JS trim, reject invalid items, defaults and initialize-once behaviour match under the ruling. Header order and casing are tested exactly.
* All `.length` uses in these modules operate on typed strings/arrays, generated hex or collections. Differences between UTF-8/UTF-16 length are immaterial where only emptiness is tested, or ASCII is already established. No direct `String()` or unary-plus arbitrary-object site exists. `Number()` is guarded; `parseInt` reads hex. JSON.stringify is the remaining arbitrary-JSON operation: functions/getters/cycles/BigInt are not Rust JSON carriers. No throwing JS primitive conversion on representable arbitrary objects was found; I1 is Object.entries, not String coercion.

## Resource and panic audit

No client-reachable panic identified in production request code. Claims-map indexing follows an unconditional insertion for every base; truncate acts on ASCII; stop slicing is bounded. Credentials, CodecInput, CodecHttpRequest and CodecRequest Debug implementations redact contents; ToolCloak/DecodeState have no derived Debug. No new logging of token/project observed. `cloaked_tools` casts usize to u32: theoretical truncation above 2^32-1 unique renamed names; infeasible in the supplied memory budget but unchecked. Same-role Rust merge is amortized linear, notes are a fixed small vocabulary, stops copy only five. Cloak linear name lookup can be quadratic (see above); huge arrays still consume memory proportional to input; no bounded-input guarantee beyond depth was established.

## Mining frozen tests / corpus independence

Corpora invoke actual frozen code; they are differential, not handwritten expected-output copies. However, most schema tests cross one field with a small value list rather than composing valid schema structures. Missing frozen fixture equivalents include the whole-allowlist composite (`antigravityWire.test.ts:579`), unknown keywords in every recursion position (`616`), multi-field valid property filtering (`935`), exact billing near-miss variants (`185`), non-empty description (`566`: committed wire only absent/empty descriptions), and mixed original images plus multiple carried and textual files. New independent random tests cover some compositions but do not repair committed regressions. Frozen request catalog assertions are outside this request-code scope. Mutation results below identify additional concrete gaps.

## Documented differences confirmed

X1 stays parked; lone surrogate text retained ignored, remaining coverage missing as I2. Rust successful serialization in JSC's narrow failure band is intentional; 39,996 input passes. Thresholds 39,994 input / 39,999 vendor are controller measurements, not remeasured here. Global 65,536 ceiling follows wire, not catalog. Profile initialization is once and not gateway wired. Inherent build_request without decoder/ProviderCodec remains appropriate to this scope.

## Verification and restoration

Final mutation table, log scan counts and restoration evidence follow below.

### Mutation results

31 single-site mutations; 28 detected; 3 survived; 0 invalid. All six committed Antigravity targets run for each mutation.

| ID/location | Mutation | Result / detecting test |
|---|---|---|
| 1 wire.rs | `max > 0.0` → `max >= 0.0` | DETECTED: wire_matches_frozen_ts |
| 2 wire.rs | `m > 65536.0` → `m > 65537.0` | DETECTED: wire_matches_frozen_ts |
| 3 wire.rs | `json!(65536)` → `json!(65535)` | DETECTED: wire_matches_frozen_ts |
| 4 wire.rs | `stops.len().min(5)` → `stops.len().min(4)` | DETECTED: wire_matches_frozen_ts |
| 5 wire.rs | `stops.len() > 5` → `stops.len() > 6` | DETECTED: wire_matches_frozen_ts |
| 6 wire.rs | `math_max(t, 0.0)` → `math_max(t, 1.0)` | DETECTED: wire_matches_frozen_ts |
| 7 wire.rs | `-1.0), 65535.0` → `0.0), 65535.0` | DETECTED: wire_matches_frozen_ts |
| 8 wire.rs | `b + 1.0` → `b + 2.0` | DETECTED: wire_matches_frozen_ts |
| 9 wire.rs | `m <= b` → `m < b` | DETECTED: wire_matches_frozen_ts |
| 10 wire.rs | `"skip_thought_signature_validator"` → `"skip_signature"` | DETECTED: input_depth_matches_frozen, wire_matches_frozen_ts |
| 11 wire.rs | `"text":" "` → `"text":""` | DETECTED: input_depth_matches_frozen, wire_matches_frozen_ts |
| 12 wire.rs | `"text":""` → `"text":" "` | DETECTED: input_depth_matches_frozen, wire_matches_frozen_ts |
| 13 wire.rs | `Role::System` → `Role::Assistant` | DETECTED: wire_matches_frozen_ts |
| 14 wire.rs | `if t.is_error == Some(true)` → `if t.is_error == Some(false)` | DETECTED: wire_matches_frozen_ts |
| 15 wire.rs | `if t.native.is_some()` → `if t.native.is_none()` | DETECTED: wire_matches_frozen_ts |
| 16 wire.rs | `("userAgent", "antigravity")` → `("userAgent", "other")` | DETECTED: codec_matches_frozen_ts, input_depth_matches_frozen, response_schema_depth_matches_frozen, tool_schema_depth_matches_frozen, vendor_depth_matches_frozen, wire_matches_frozen_ts |
| 17 wire.rs | `("requestType", "agent")` → `("requestType", "image_gen")` | DETECTED: codec_matches_frozen_ts, input_depth_matches_frozen, response_schema_depth_matches_frozen, tool_schema_depth_matches_frozen, vendor_depth_matches_frozen, wire_matches_frozen_ts |
| 18 schema.rs | `depth >= 24` → `depth >= 25` | DETECTED: schema_matches_frozen_wire, tool_schema_depth_matches_frozen |
| 19 schema.rs | `if name.is_empty()` → `if !name.is_empty()` | DETECTED: schema_matches_frozen_wire, wire_matches_frozen_ts |
| 20 schema.rs | `real.len() != 1` → `real.len() != 2` | DETECTED: schema_matches_frozen_wire |
| 21 schema.rs | `Some("array")` → `Some("ARRAY")` | DETECTED: schema_matches_frozen_wire |
| 22 cloak.rs | `name.len() <= 128` → `name.len() <= 127` | DETECTED: cloak_matches_frozen_ts |
| 23 cloak.rs | `base.truncate(122)` → `base.truncate(121)` | DETECTED: cloak_matches_frozen_ts |
| 24 profile.rs | `"2.12.2"` → `"2.12.3"` | DETECTED: codec_matches_frozen_ts, profile_matches_frozen_codec |
| 25 codec.rs | `& 3) &#124; 8` → `& 3) &#124; 9` | DETECTED: codec_matches_frozen_ts |
| 26 codec.rs | `omni_ir::deep::scope(&#124;&#124; self.build_request_scoped(input))` → `self.build_request_scoped(input)` | SURVIVED:  |
| 27 wire.rs | `"antigravity:thinking-dropped"` → `"antigravity:thought-dropped"` | DETECTED: wire_matches_frozen_ts |
| 28 wire.rs | `"description", json!(d)` → `"description", json!("changed")` | DETECTED: wire_matches_frozen_ts |
| 29 wire.rs | `"description", json!(d)` → `"description", json!("")` | SURVIVED:  |
| 30 wire.rs | `names.extend([(t.id.as_str(), t.name.as_str())]);` → `names.entry(t.id.as_str()).or_insert(t.name.as_str());` | SURVIVED:  |
| 31 wire.rs | `("project", project),         ("requestId", request_id),` → `("requestId", request_id),         ("project", project),` | DETECTED: codec_matches_frozen_ts, input_depth_matches_frozen, response_schema_depth_matches_frozen, tool_schema_depth_matches_frozen, vendor_depth_matches_frozen, wire_matches_frozen_ts |

**M3 (Minor): scope-performance regression is invisible to committed tests.** Mutation 26 survives all committed targets. This is a resource-observability corpus gap, not proof that removal changes wire semantics; add a shallow grows() assertion. It supports I3. No claim that scope removal should fail the deep tests.

### Gate and log scans

Baseline package gate: exit 0, 59 summaries / 237 passed / 0 failed / 9 ignored (nested subprocess summaries included). Initial full build took place before the review harness was compiled. Debug timings were used; release timing script was prepared but **not run**. Clippy/fmt independent rerun status below.

| Log | Exit | FAILED/panicked/^error | stack overflow/SIGSEGV/SIGABRT |
|---|---|---|---|
| clippy.log | 0 | 0 | 0 |
| compare-rerun.log | not recorded | 0 | 0 |
| compare.log | 1 | 0 | 0 |
| extra-mutations.log | not recorded | 0 | 0 |
| fmt.log | 0 | 0 | 0 |
| gate.log | 0 | 0 | 0 |
| independent.log | 0 | 0 | 0 |
| minimal-compare.log | not recorded | 0 | 0 |
| minimal.log | not recorded | 0 | 0 |
| mutation-01.log | 101 | 5 | 0 |
| mutation-02.log | 101 | 5 | 0 |
| mutation-03.log | 101 | 5 | 0 |
| mutation-04.log | 101 | 5 | 0 |
| mutation-05.log | 101 | 5 | 0 |
| mutation-06.log | 101 | 5 | 0 |
| mutation-07.log | 101 | 5 | 0 |
| mutation-08.log | 101 | 5 | 0 |
| mutation-09.log | 101 | 5 | 0 |
| mutation-10.log | 101 | 10 | 0 |
| mutation-11.log | 101 | 10 | 0 |
| mutation-12.log | 101 | 10 | 0 |
| mutation-13.log | 101 | 5 | 0 |
| mutation-14.log | 101 | 5 | 0 |
| mutation-15.log | 101 | 5 | 0 |
| mutation-16.log | 101 | 23 | 0 |
| mutation-17.log | 101 | 23 | 0 |
| mutation-18.log | 101 | 8 | 2 |
| mutation-19.log | 101 | 9 | 0 |
| mutation-20.log | 101 | 5 | 0 |
| mutation-21.log | 101 | 5 | 0 |
| mutation-22.log | 101 | 5 | 0 |
| mutation-23.log | 101 | 5 | 0 |
| mutation-24.log | 101 | 12 | 0 |
| mutation-25.log | 101 | 5 | 0 |
| mutation-26.log | 0 | 0 | 0 |
| mutation-27.log | 101 | 5 | 0 |
| mutation-28.log | 101 | 5 | 0 |
| mutation-29.log | 0 | 0 | 0 |
| mutation-30.log | 0 | 0 | 0 |
| mutation-31.log | 101 | 23 | 0 |
| mutations.log | 0 | 0 | 0 |
| no-scope.log | 0 | 0 | 0 |
| restoration.log | not recorded | 0 | 0 |
| root-schema-probe.log | not recorded | 0 | 0 |

Mutation failures are expected; mutation 18 causes an assertion mismatch before deep::drop(node) in antigravity_schema.rs:54–56; panic unwinding then recursively drops the 40,000-level raw node and aborts. This is a mutated-test failure path, not a baseline codec crash. Full artifacts remain under this report directory. No broad workspace or network build performed.

### Remaining limitations

No universal safety proof, full UTF-16 carrier inventory test implementation, release latency benchmark, exhaustive env permutation, adversarially wide request stress run, or literal-to-individual-row machine mapping. Frozen threshold first-throw points were not remeasured. Reviewer did not implement product fixes or retained-red tests. Report makes no approval claim for decoder/OAuth/registration/e2e.

### Restoration proof

```text
HEAD: 1fd5fb8d8a9e28672676ab5efcdbb3e87c9dbf8e
git status --porcelain=v1: ''
git diff --exit-code: clean
Filesystem             Size  Used Avail Use% Mounted on
/dev/mapper/rhel-root  116G   98G   19G  84% /
```
