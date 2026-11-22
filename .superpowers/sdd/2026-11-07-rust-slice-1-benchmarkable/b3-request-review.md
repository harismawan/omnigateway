# B3 request review — f35643f0

**Verdict: request changes.** No Critical finding; two Important mismatches and one Minor framing mismatch.
Reviewed request-side files against frozen TS; decode implementation excluded. All experiments used the detached scratch checkout and specified shared target/offline flags.

## Important
1. **OAuth vendor `__proto__` changes body bytes and routing headers** — `crates/omni-providers/src/openai/wire.rs:337` (also `mod.rs:75`).
   Exact request: `{"model":"pool","stream":false,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}],"vendor":{"openai":{"__proto__":{"service_tier":"priority","reasoning":{"effort":"high"}}}}}`; parse the JSON so `__proto__` is an own key.
   Options: model `gpt-6-astra` or `gpt-5.5`, requestId `review`, startedAt `1794000000123`; credentials `{apiKey:null,accessToken:"token-review",providerData:{accountId:"",installationId:"FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",idSalt:"b".repeat(64),extra:7}}`.
   Frozen: no serialized `__proto__`; `x-codex-routing-hint: model=gpt-6-astra;tier=priority`. Rust: emits `"__proto__":{"service_tier":"priority","reasoning":{"effort":"high"}}`; routing hint `model=gpt-6-astra` (likewise 5.5).
   Frozen assignment invokes the prototype setter; Rust inserts an ordinary map entry. Merely dropping the key would still miss inherited tier lookup. Four own rows differ, including numeric-key/constructor combination; numeric key ordering itself agrees.
2. **Missing native history fields become explicit null** — `crates/omni-providers/src/openai/lite.rs:147,161,169,177`.
   Exact request: `{"model":"pool","stream":false,"messages":[{"role":"assistant","content":[{"type":"providerNative","provider":"openai","blockType":"function_call","data":{}}]}]}`; same options/credentials as #1.
   Frozen function-call item omits `name`, `arguments`, `call_id`; Rust adds `"name":null,"arguments":null,"call_id":null`.
   Change only blockType to `function_call_output`: frozen omits call_id/output; Rust adds both as null. Change to `message`: frozen omits content; Rust adds `"content":null`.
   Six own rows differ (three kinds × lite/non-lite). Native data is an arbitrary map; preserve absence with `get`, rather than indexing to Null. Explicit null must remain distinct.

## Minor
3. **Rust whitespace trimming accepts an encoding the frozen adapter refuses** — `crates/omni-providers/src/http/mod.rs:265`.
   Exact transport input: POST, body `"x"`, body_encoding Zstd, headers `[["content-encoding","\u0085zstd\u0085"]]` (plus X-First/X-Last/Host fixture headers).
   Frozen `codecAdapter.ts:73` framingAgrees returns false: no upstream request. Rust transmits latin1 `content-encoding: \x85zstd\x85` and a compressed body to the raw TCP listener.
   Rust `str::trim` and JS `String.trim` differ. Use the existing JS-compatible trim helper. Ordinary `" ZsTd "` agrees. U+FEFF also differs at validation (TS accepts), though HTTP later rejects that non-latin1 value.

## Independent evidence
- **161 own whole requests, 11 differing**: ten covered by #1/#2; one API-key `maxTokens:null,temperature:null` row emits null fields in TS but omits them in Rust. The latter is outside the typed canonical number contract (`Option<f64>`), recorded as a representation boundary, not a provider finding.
- Corpus includes empty/whitespace/control/non-BMP/U+2028/U+2029/100k strings; empty messages/consecutive roles; multipart system/cache markers; duplicate tools, empty/$ref/$defs/strict/additionalProperties/escaped/unicode schemas; scalar/null/array/invalid-JSON-text tool inputs; mixed image/file/tool/thinking/native histories; response formats; numeric boundaries; vendor collisions and integer keys.
- Fourteen additional identity rows within those 161 cover missing/null/numeric/empty/malformed credentials, valid uppercase UUID, salt rejection, supplied session/conversation identity, missing/empty requestId. Same explicit millisecond instant on both sides; no wall-clock race. All matched.
- Five own raw-TCP zstd bodies: 1, 131072, 131073, 8388608 repeating bytes, and 2097152 high-entropy printable bytes. Frozen/Rust ordered heads, Content-Length, decompressed source all match; compressed bytes also happened to match (10/22/23/274/1742144 bytes).
- Own duplicate/exact-case/different-case/numeric header capture matches frozen. Existing refusal/empty-body/OAuth transport tests rerun; NEL probe independently reaches the wire. Empty encoded refusal accepted: codec always serializes an object containing stream=true, hence cannot produce an empty body.
- 16 own `encode`/`encode_owned` equivalence cases cover POST/GET × empty/nonempty × default/chunked/Expect/duplicate headers. Refactor compared with pre-change source: head split and body placement preserve unencoded arithmetic; existing frozen HTTP wire tests also ran.
- Five 39990-level/2 MiB public-codec build/drop probes pass: native annotations, response schema default, credential extension (including clone), structurally-safe ignored provider tool, and **unlisted native-message role coercion**. Ownership grep retained in `carrier-audit.txt`; no new crash found.
- Credentials clone copies all three fields and was independently checked; its exhaustive `Self { ... }` initializer already makes adding a field a compile error. Default/drop and deep clone pass. Public credential/input/request/result Debug and missing-token error expose none of four sentinel secrets. Private Secrets derives Debug but is not formatted on these paths.
- Lone-surrogate request probe: frozen writes `\ud800`; direct Rust IR deserialization rejects it. This is a shared UTF-8 representation boundary (existing conformance documents describe ingress replacement), not a decode-side finding. Negative zero is normalized by the JSON oracle; no claim of an independently preserved -0 carrier.

## Reading versus execution / limits
- All 24 inventory decisions read against frozen sources; existing whole-request gate exercises their documented witnesses. Own rows additionally cover mode/lite/defaults/merge/identity/history decisions; explicit tool-choice and between-tools degradation spelling rely on existing tests plus reading. Detailed per-decision notes: `/tmp/opencode/b3-review/branch-audit.md`.
- Fingerprint names/case/order were compared in every own OAuth row; profile environment override behavior was read and its existing oracle test run. No new URL-image ingress or array-of-parts tool-result ingress cases were authored; existing ingress comparisons cover those shapes. Arbitrary binary incompressibility is unavailable through String transport; the 2 MiB probe used deterministic high-entropy ASCII.
- Identity/lite/literal/compression/depth documents inspected as claims, not proof; several retain superseded checkpoint prose. No objection to the accepted compression/error/empty-body differences or deferred registration/refresh/catalog scope.

## Gates and artifacts
- Pristine tracked f35643f0: `cargo test --offline -p omni-providers -p omni-ir -p omni-dialects` → **53 `test result: ok` summaries, 235 passed, 4 ignored (including nested summaries), no FAILED line**. Last: `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s`.
- `cargo clippy --offline -p omni-providers -p omni-ir -p omni-dialects --all-targets -- -D warnings` → `Finished dev profile [unoptimized] target(s) in 1.71s` (exit 0).
- Initial gate attempts lacked scratch JS workspace links/zod; locally resolved without editing existing checkouts. Final pristine gate logs: `/tmp/opencode/b3-review/{gate-pristine,clippy-pristine}.log`.
- Reproducers, exact inputs and full differing requests: `/tmp/opencode/b3-review/probes/`, `own-inputs.json`, `own-differences.json`; transport/depth/boundary logs beside them. Scratch checkout removed after review; existing checkouts unchanged except this requested report.
