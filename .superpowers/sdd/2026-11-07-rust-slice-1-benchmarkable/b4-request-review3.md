# B4 request review, round 3 — 998eab1c

**Verdict: APPROVE (request side only).** All three outstanding substantive items are closed. No new product finding. This approval incorporates the preceding two rounds' request review and is conditional on the explicitly parked differences below; it does not approve the decoder, registration, OAuth, or e2e integration.

## Dispositions

### 1. Raw overflow-number X1 retained reds — closed

The three added oracle cases use hand-built raw request text containing literal `1e309`. The enclosing JSON serializes that text as a string, not as a parsed numeric value. Rust first parses the oracle transport, then `serde_json::from_str(row["input"])` parses the untouched request. All three fail at this second parse with **number out of range**. No `null`/Infinity substitution occurs in the committed test. Frozen separately calls JSON.parse(raw), obtaining Infinity, then its actual codec.

Independent Bun oracle execution (`oracle.json`) gives:

| Raw carrier | Frozen result |
|---|---|
| toolUse.input = 1e309 | functionCall.args = null |
| toolUse.input = {"x":1e309} | functionCall.args = {"x":null} |
| inputSchema = {"type":"object","default":1e309} | parameters = {"type":"object","default":null} |

Frozen wire.ts scalarValue's free arm retains default verbatim; it does not finite-check it. Final codec JSON.stringify emits null. Thus the schema case's expected body is correct. Rust test comparison uses exact frozen body text, not a reparsed/normalized expected object.

An additional direct frozen-code probe (`schema-default.json`) confirms empty degradation notes for this schema: retaining the nonfinite free value is not itself a schema prune. Source references: frozen wire.ts:327–328, 580–584; codec.ts:146; Rust schema.rs:178, tests/antigravity_x1-reference.ts:16–23 and antigravity_x1.rs:20–23.

**Positive control:** a temporary copy of the test replaced raw `1e309` with representable `null` only on the Rust input side, leaving the actual frozen expectation untouched. All three numeric comparisons passed. This establishes the comparison path can turn green and is not inherently failing due to a second fixture error. The control was preserved as evidence and removed from the checkout. It is not a product fix or a change to retained reds.

Additional vendor-bag, tool-option and raw generation-field overflow fixtures are **optional representative coverage**, not additional required fixes for this narrow closure: they hit the same raw JSON parser rejection already pinned. Vendor passthrough and schema free fields exercise equivalent serialized opaque values; tool options are ignored by this provider. Typed generation NaN/±Infinity arithmetic is separately tested by in-process overrides. These cases remain within parked X1; approval does not claim raw 1e309 now works anywhere. Other free schema fields and array elements are analogous optional expansions.

### 2. Whole-error compatibility/adapter equality — closed

`antigravity_build_throw.rs::compatibility_throw_equals_adapter_all_fields_for_two_rows` compares complete GatewayError values (derived PartialEq covers all fields), then explicitly checks code, message, provider, gateway_authored, retryable, empty degradations, absent upstream_status and retry_after_ms. Both plain and degradation-producing/renamed-tool requests are checked. NoHttp prevents a failed build from making HTTP calls.

The test invokes the trait build_request implementation; the inherent compatibility entry point forwards directly to it, unchanged. The second row executes system-turn/thinking notes and cloak rename before null-schema throw. Local notes/counter never escape. Six independent mapping mutations, including adapter-side drift, were tested below. All were killed specifically by the new equality test, then sources restored and the three build_throw tests rerun green.

Coverage limitation: this test pins the forwarding target, not arbitrary future changes to the one-line inherent shim. No current mismatch exists; directly calling the inherent shim as a third comparison would be optional future coverage, not a remaining failure of the mapping tests requested here.

### 3. Audit corrections — closed, with editorial caveats

Request table now uses try_prune, removes the nonexistent null pre-scan, enumerates all schema fields, quotes both AUTH messages, names all eight depth tests and documents cloak-before-request-ID ordering. The overflow paragraph now expressly says the original cause is unidentified. This matches the established safety evidence, rather than claiming the old product failure was disproven by one fixture diagnosis. Both cloak build and ID derivation have no recoverable failure on representable inputs; allocation failure is outside that statement's ordinary operational meaning.

Remaining nonblocking editorial imprecision: the opening “independent re-review remains pending” is historical workflow text (this report completes it); the phrase “two independent reviews (11 ... × normal and error paths)” compresses the history—round one ran the normal matrix, round two ran both. “Not reproduced on any committed code” must be read as unmutated baseline codec execution: intentional deep-drop mutations do abort, and assertion-failure unwind in a raw deep test fixture can abort. These do not contradict the statement that the original cause remains unknown. No remaining stale code symbol or removed pre-scan reference found in the request section.

Decoder section, from `## Decoder port` through EOF, is **byte-identical** to 8bf97821 (direct byte comparison; `decoder-identical.txt`). It was not re-reviewed.

## Scope and unchanged corpora

`git diff --stat 8bf97821..998eab1c` lists exactly four files: antigravity_x1.rs, antigravity_x1-reference.ts, antigravity_build_throw.rs, conformance/antigravity-migration.md. `git diff ... -- 'crates/*/src'` is empty. No product change since round two. Independent oracle counts: cloak **132**, schema **593**, wire **352**, codec **118**. Unchanged profile test still enumerates **9** subprocess environment vectors and passed in the gate. Full source/file diff evidence is retained.

## Approval boundaries and parked differences

* **X1**: lone UTF-16 code units and raw numbers beyond double range remain shared JSON/IR gaps. Eleven ignored paired request tests plus the existing lone-surrogate text test retain those failures. Non-BMP vendor strings still split into lone surrogates in frozen and replacement characters in Rust. No normalization is approved as parity.
* **Depth band:** successful Rust serialization inside its bound where frozen JSC stringify throws is intentional. Controller thresholds remain 39,994 input / 39,999 vendor-extra levels. Prior independent 39,990-level normal/error-path matrices passed; no unconditional scope is needed, and shallow builds must not grow. These exact thresholds were not remeasured this round.
* **Frozen-code ceiling:** every model follows wire.ts global 65,536, including catalog rows advertising 65,535. This is adherence to the oracle, not a new limit policy.
* **Profile:** environment capture happens once; gateway initialization wiring remains separate integration work.
* **Internal order:** Rust cloak construction precedes ID derivation, unlike frozen; documented, with no demonstrated observable effect on representable inputs.
* Shared BuildError/try_build_request guard semantics remain as reviewed in round two: ordinary build throw becomes gateway-authored retryable UPSTREAM, classified AUTH is rebound. Approval relies on this established contract.

No new fuzz or universal safety proof was attempted in this deliberately narrow tests/docs round. Round-two evidence remains 40,000 requests, 39,894 equal, 106 parked X1 body differences; 11 positions passed normal/error cleanup and 10,000 shallow builds grew zero times. Decoder bounded-parser/counter policies are not part of this request approval.

## Mutation results

| Mutation | Site | Exit | New equality test |
|---|---|---|---|
|1: `.with_provider("antigravity")` → `.with_provider("wrong")`|antigravity/codec.rs|101|DETECTED|
|2: `.gateway_authored()` → ``|antigravity/codec.rs|101|DETECTED|
|3: `"antigravity codec buildRequest threw"` → `"wrong message"`|antigravity/codec.rs|101|DETECTED|
|4: `ErrorCode::Upstream, "antigravity codec buildRequest threw"` → `ErrorCode::Auth, "antigravity codec buildRequest threw"`|antigravity/codec.rs|101|DETECTED|
|5: `.gateway_authored()` → `.gateway_authored().with_degradations(vec!["unexpected".into()])`|antigravity/codec.rs|101|DETECTED|
|6: `codec_failure(id, "buildRequest", "threw")` → `codec_failure(id, "decode", "threw")`|adapter.rs|101|DETECTED|

**6/6 detected, 0 survivors, 0 invalid.** Mutations 1/2 repeat prior survivors 15/16. Other mutations change message, code, add a degradation, or change adapter hook labeling.

## Gates and explicit retained-red run

`cargo clippy --offline -p omni-providers -p omni-ir -p omni-crypto --all-targets -- -D warnings : exit=0`

`cargo fmt --all -- --check : exit=0`

`bun --no-env-file test packages/providers/test/antigravityWire.test.ts packages/providers/test/antigravityCodec.test.ts : exit=0`

`cargo test --offline -p omni-providers -p omni-ir -p omni-crypto : exit=0`

`cargo test --offline -p omni-providers --test antigravity_build_throw compatibility_throw_equals_adapter_all_fields_for_two_rows -- --exact : exit=101`

`cargo test --offline -p omni-providers --test antigravity_build_throw compatibility_throw_equals_adapter_all_fields_for_two_rows -- --exact : exit=101`

`cargo test --offline -p omni-providers --test antigravity_build_throw compatibility_throw_equals_adapter_all_fields_for_two_rows -- --exact : exit=101`

`cargo test --offline -p omni-providers --test antigravity_build_throw compatibility_throw_equals_adapter_all_fields_for_two_rows -- --exact : exit=101`

`cargo test --offline -p omni-providers --test antigravity_build_throw compatibility_throw_equals_adapter_all_fields_for_two_rows -- --exact : exit=101`

`cargo test --offline -p omni-providers --test antigravity_build_throw compatibility_throw_equals_adapter_all_fields_for_two_rows -- --exact : exit=101`

`cargo test --offline -p omni-providers --test antigravity_build_throw : exit=0`

`cargo test --offline -p omni-providers --test b4_x1_control x1_overflow -- --ignored : exit=0`

`cargo test --offline -p omni-providers --test antigravity_x1 -- --ignored : exit=101`

| Log | FAILED/panicked/^error matches | stack overflow/SIGSEGV/SIGABRT matches |
|---|---|---|
|clippy.log|0|0|
|fmt.log|0|0|
|frozen-tests.log|0|0|
|gate.log|0|0|
|mutation-1.log|4|0|
|mutation-2.log|4|0|
|mutation-3.log|4|0|
|mutation-4.log|4|0|
|mutation-5.log|4|0|
|mutation-6.log|4|0|
|restored-equality.log|0|0|
|x1-positive-control.log|0|0|
|x1.log|24|0|

Package gate: 62 summaries; totals [248, 0, 23] (passed/failed/ignored, including nested subprocess summaries).

Ignored X1 run intentionally exits 101: **11 failures**, comprising seven surrogate parse failures, three number-out-of-range parse failures, one vendor byte mismatch. Positive control: **3 passed**. Restored build_throw suite: **3 passed**. Clippy and fmt exit 0. The intentional failures do not count as a green parity claim; their raw inputs and actual frozen bytes are preserved.

Additional frozen Bun request tests: **97 passed, 0 failed**, 311 assertions; antigravityWire.test.ts and antigravityCodec.test.ts. No provider calls.

The load-sensitive drain test **passed** in this gate; the conditional twenty-run investigation was not triggered. No claim is made that this test is flake-free. Its code is unchanged by this range.

## Restoration proof
```text
HEAD 998eab1c1eadb5a31f43d37f4476a2b876bdf957
git status --porcelain: ''
git diff --exit-code: 0
Filesystem             Size  Used Avail Use% Mounted on
/dev/mapper/rhel-root  116G  102G   14G  89% /
```
No commits, retained product edits, subagents, or provider traffic. Evidence is confined to this directory; original review evidence preserved.
