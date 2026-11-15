# B4 request rereview — 8bf97821

**Verdict: REQUEST CHANGES.** Request implementation substantially improved; remaining required X1 retained-red coverage is incomplete. No new baseline byte/error mismatch outside X1 was identified by the experiments below. Decoder review excluded.

## Earlier findings

| Finding | Disposition | Independent evidence |
|---|---|---|
| I1 root schema errors/notes | Closed | Actual adapter error differential, extended random root shapes, committed 593 schema/118 codec corpus and build_throw test |
| I2 X1 retained reds | **Not closed** | Eight new ignored tests verified red, but no request-side out-of-double-range retained regression |
| I3 unconditional scope | Closed | Removed; 10,000-build grows probe and 11-position no-scope matrix |
| M1 audit inventory | Partially closed | Consolidated table contains formerly omitted literals; stale symbols/count/causality statements remain |
| M2 linear lookup | Closed for built cloaks | name_index maps original names to stable Vec offsets; 132 differential cloak rows and both fuzz seeds |
| M3 shallow growth test | Closed | Committed shallow_builds_do_not_grow_stack; reintroducing scope mutation |
| M4 descriptions | Closed | Nonempty/mixed rows; empty-description mutation rerun |
| M5 last-wins IDs | Closed | New last-wins row; first-wins mutation rerun |

## Important: request overflow-number X1 regression still missing

Frozen `packages/providers/src/antigravity/wire.ts:723` carries tool input, `codec.ts:146` JSON.stringify converts Infinity to null. Rust `ChatRequest` tool input is serde_json::Value; parsing 1e309 rejects before provider build. `tests/antigravity_x1.rs` contains eight UTF-16-only rows and no overflow-number row. Migration document explicitly declines adding one because Number cannot carry it; that inability is precisely the retained-red boundary the ruling requires, not a reason to omit it.

Minimal raw input:
```json
{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"toolUse","id":"i","name":"t","input":1e309}]}]}
```
With token t, project p, model m, request ID r, frozen succeeds and emits args:null (`overflow-frozen.log`). Rust cannot construct that request through serde JSON (number out of range); no provider adapter result exists. Client ingress error mapping was not reviewed and is not claimed. Add an ignored X1 raw-input test preserving frozen expected output, without normalizing the input. This is a coverage finding, not a demand to resolve X1.

## Minor: request audit still has stale references and unsupported certainty

`conformance/antigravity-migration.md` references removed `schema::prune`, a removed “codec null-root check,” and “all seven depth tests” (eight now). “The prior overflow was a test-fixture artefact” is stronger than established evidence: one fixture failed, but the earlier report's root cause remained unproven. Table describes SCHEMA_FIELDS by counts rather than explicitly enumerating every literal; AUTH messages are named rather than quoted. TSV signatures for try_prune and Result-returning to_wire are accurate, including caller deep disposal.

## Shared contract assessment

BuildError is additive and payload-free on Throw. Default try_build_request calls the old build_request exactly once and wraps its error; adapter applies the same rebound as before to Gateway. Existing sibling overrides are absent. Antigravity's override returns Throw at the actual two pruning call sites; null response roots never reach pruning because the response reader guards them. Duplicate declaration filtering precedes pruning; first of a wire-name group is always retained, so “first dropped” within the group is impossible. A provider-owned tool may be dropped before portable filtering but is not that duplicate rule.

Adapter Throw maps to codec_failure, identical to frozen guard at codecAdapter.ts:173–193: UPSTREAM, provider antigravity, gatewayAuthored true, retryable true, no status/retryAfter/degradations. Inherent build_request forwards to the trait implementation; its literal construction equals codec_failure field-for-field for id antigravity. Classified AUTH remains rebound, gatewayAuthored false. No Throw payload or logging can expose input. Notes and cloak count are local until a successful build; returning Throw discards them. Inherent request callers are tests; gateway registration remains outside this scope.

One internal order deviation remains: codec.rs constructs cloak before deriving request ID (frozen derives ID first). Neither operation can throw on representable inputs except allocation failure; no observable wire/client difference demonstrated. Token then project validation precede both; extended corpus checks combined auth/null failures. Digest slicing is on generated 64-character ASCII hex, and expect cannot fail on that invariant. Index lookup is valid for ToolCloak::build outputs. Public mutable to_wire can invalidate private name_index if external library callers mutate it; production/decoder do not do that. Decoder uses original()/from_wire, unaffected by the index.

## Ownership/depth reasoning

On declaration failure request owns already emitted message/config values and is deep-dropped; prior declarations are wrapped in Value::Array and deep-dropped. Current declaration map contains only name/description. Config moved into request before tools; response temporary uses Owned. Borrowed request remains caller-owned with iterative IR Drop. No forgotten owner or leak found by ownership inspection; no allocator leak instrumentation used. Guarded response-schema error cleanup is unreachable for ordinary JSON objects but is deep-aware.

Independent 2 MiB probes at 39,990 nested arrays rerun input, schema_free, options, vendor, response_free, native, system_native, result_native, provider_tool, headers, citations. Error-path mode appends null schema after each and copies eight prior declarations where applicable: covers deep tool input, already-pruned response default, multiple deep defaults, and deep vendor bags. Results/logs below. No universal safety proof claimed.

## Experiment limitations

Successes compared direct codec output; **failures rerun through actual Rust adapter::send and frozen codecAdapter**, with NoHttp guards. Compare code/message/provider/gatewayAuthored/retryable, URL, ordered headers, body, notes and cloak count. Success-side adapter's 16-note bound is not applied to codec notes. First seed exactly repeats prior generator; second seed extends roots/nested schemas, provider tools, response spelling precedence, duplicate originals with odd/null schemas, in-process nonfinite overrides. Did not systematically construct hash suffix collisions between distinct originals. Random tests are not exhaustive. No release timing run; same debug timing harness as round one. Request-id/project surrogate ignored rows verify parse boundary, not ingress client-error presentation.

## Results

### compare1
```text
{
  "requests": 20000,
  "equal": 19922,
  "different": 78,
  "classes": {
    "body": 78
  }
}

```

### compare2
```text
{
  "requests": 20000,
  "equal": 19972,
  "different": 28,
  "classes": {
    "body": 28
  }
}

```

### minimal-compare
```text
{
  "requests": 30,
  "equal": 30,
  "different": 0,
  "classes": {}
}

```

### adversarial-cloak-compare
```text
{
  "requests": 100,
  "equal": 100,
  "different": 0,
  "classes": {}
}

```

### independent
```text
depth input: PASS build+serialize+drop
scope: grows=0 us/request=13.003046300000001
depth schema_free: PASS build+serialize+drop
depth options: PASS build+serialize+drop
depth vendor: PASS build+serialize+drop
depth response_free: PASS build+serialize+drop
depth native: PASS build+serialize+drop
depth system_native: PASS build+serialize+drop
depth result_native: PASS build+serialize+drop
depth provider_tool: PASS build+serialize+drop
depth headers: PASS build+serialize+drop
depth citations: PASS build+serialize+drop
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 34.07s
```

### error-path
```text
depth input: PASS build+serialize+drop
depth schema_free: PASS build+serialize+drop
depth options: PASS build+serialize+drop
depth vendor: PASS build+serialize+drop
depth response_free: PASS build+serialize+drop
depth native: PASS build+serialize+drop
depth system_native: PASS build+serialize+drop
depth result_native: PASS build+serialize+drop
depth provider_tool: PASS build+serialize+drop
depth headers: PASS build+serialize+drop
depth citations: PASS build+serialize+drop
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out; finished in 1.53s
```

### x1
```text
test x1_tool_name ... FAILED
test x1_tool_id ... FAILED
test x1_project_hash_and_body ... FAILED
test x1_opaque_key ... FAILED
test x1_opaque_value ... FAILED
test x1_system ... FAILED
test x1_request_id_body ... FAILED
test x1_vendor_non_bmp ... FAILED
test result: FAILED. 0 passed; 8 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
```

### dispatch
```text
     Running tests/dispatch_size.rs (target/debug/deps/dispatch_size-8d05f93f78252c32)
test dispatch_state_machine_size ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.25s
```

## Mutations

| ID | Mutation | Result / tests |
|---|---|---|
|1 antigravity/schema|`if node.is_null()` → `if node.is_boolean()`|DETECTED: test build_throw_and_classified_refusal ... FAILED; test null_schema_root_throws ... FAILED; test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s; test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s; test null_schema_throw_drops_partial_deep_body ... FAILED; test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 8.52s; test schema_matches_frozen_wire ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s|
|2 antigravity/schema|`!a.is_empty()` → `a.is_empty()`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s; test schema_matches_frozen_wire ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.12s|
|3 antigravity/schema|`!s.is_empty()` → `s.is_empty()`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s; test schema_matches_frozen_wire ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.11s|
|4 antigravity/schema|`*dropped = true;` → `*dropped = false;`|DETECTED: test schema_matches_frozen_wire ... FAILED|
|5 antigravity/wire|`if seen.contains(name)` → `if false && seen.contains(name)`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s; test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.10s|
|6 antigravity/wire|`deep::drop_map(request);` → `drop(request);`|DETECTED: |
|7 antigravity/wire|`deep::drop(Value::Array(declarations));` → `drop(declarations);`|DETECTED: |
|8 antigravity/cloak|`cloak.to_wire.len())` → `0)`|DETECTED: test cloak_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s|
|9 antigravity/cloak|`self.to_wire[*i].1.as_str()` → `self.to_wire[*i].0.as_str()`|DETECTED: test cloak_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s; test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s; test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.05s|
|10 adapter|`"buildRequest", "threw"` → `"decode", "threw"`|DETECTED: test build_throw_and_classified_refusal ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s|
|11 antigravity/codec|`self.build_request_scoped(input)` → `omni_ir::deep::scope(|| self.build_request_scoped(input))`|DETECTED: test shallow_builds_do_not_grow_stack ... FAILED; test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 6.77s|
|12 antigravity/wire|`"description", json!(d)` → `"description", json!("")`|DETECTED: test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.04s|
|13 antigravity/wire|`names.extend([(t.id.as_str(), t.name.as_str())]);` → `names.entry(t.id.as_str()).or_insert(t.name.as_str());`|DETECTED: test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.07s|
|14 antigravity/schema|`depth >= 24` → `depth >= 25`|DETECTED: test tool_schema_depth_matches_frozen ... FAILED; test result: FAILED. 7 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 6.68s; test schema_matches_frozen_wire ... FAILED|
|15 antigravity/codec|`.with_provider("antigravity")` → `.with_provider("wrong")`|SURVIVED: |
|16 antigravity/codec|`.gateway_authored()` → ``|SURVIVED: |
|17 antigravity/codec|`ErrorCode::Upstream, "antigravity codec buildRequest threw"` → `ErrorCode::Auth, "antigravity codec buildRequest threw"`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s|
|18 antigravity/schema|`node.is_null()` → `node.is_null() || node.is_array()`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s; test schema_matches_frozen_wire ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.08s|
|19 antigravity/schema|`node.is_null()` → `node.is_null() || node.is_string()`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s; test schema_matches_frozen_wire ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.13s|
|20 antigravity/wire|`if let Some(d) = &t.description` → `if let Some(d) = &t.description && !d.is_empty()`|DETECTED: test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.11s|
|21 antigravity/wire|`("project", project),` → `("project", "wrong"),`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s; test vendor_depth_matches_frozen ... FAILED; test tool_schema_depth_matches_frozen ... FAILED; test input_depth_matches_frozen ... FAILED; test response_schema_depth_matches_frozen ... FAILED; test result: FAILED. 4 passed; 4 failed; 0 ignored; 0 measured; 0 filtered out; finished in 12.16s; test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.06s|
|22 adapter|`crate::codec::BuildError::Gateway(e) => rebound(id, e),` → `crate::codec::BuildError::Gateway(e) => e,`|DETECTED: test build_throw_and_classified_refusal ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s|
|23 antigravity/schema|`node.is_null()` → `node.is_null() || node.is_number()`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s; test schema_matches_frozen_wire ... FAILED; test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s|
|24 antigravity/wire|`if seen.contains(name)` → `if seen.contains(name) && !t.input_schema.is_null()`|DETECTED: test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s|
|25 antigravity/cloak|`.extend([(name.into(), cloak.to_wire.len())]);` → `.extend([(alias.clone(), cloak.to_wire.len())]);`|DETECTED: test cloak_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s; test codec_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s; test wire_matches_frozen_ts ... FAILED; test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.06s|

Survivors are coverage gaps; mutation of only compatibility mapping does not exercise adapter override. See individual logs for assertion versus abort detection.

**25 mutations: 23 detected, 2 survived, 0 invalid.** Descriptions and duplicate-ID mutations that survived round one are now detected, as is reintroducing unconditional scope.

### Minor corpus gap: mutation 15 survives (antigravity/codec)

`.with_provider("antigravity")` → `.with_provider("wrong")` passes every committed request target. Frozen codecAdapter.ts:23–33 and Rust antigravity/codec.rs:22–24: minimal null-schema request above should yield provider antigravity and gatewayAuthored true. Mutated compatibility build_request instead yields provider wrong (15) or gatewayAuthored false (16). Actual adapter calls override and is unaffected. Add field-for-field equality between the compatibility error and adapter error; current codec corpus asserts only code/message. This is test coverage, not a baseline mismatch.

### Minor corpus gap: mutation 16 survives (antigravity/codec)

`.gateway_authored()` → `` passes every committed request target. Frozen codecAdapter.ts:23–33 and Rust antigravity/codec.rs:22–24: minimal null-schema request above should yield provider antigravity and gatewayAuthored true. Mutated compatibility build_request instead yields provider wrong (15) or gatewayAuthored false (16). Actual adapter calls override and is unaffected. Add field-for-field equality between the compatibility error and adapter error; current codec corpus asserts only code/message. This is test coverage, not a baseline mismatch.

## Commands/exits and log scans

`b4_review adversarial-cloak : exit=0`

`cargo clippy --offline -p omni-providers -p omni-ir -p omni-crypto --all-targets -- -D warnings : exit=0`

`python /tmp/opencode/b4-request-rereview/compare.py : exit=0`

`python /tmp/opencode/b4-request-rereview/compare.py : exit=0`

`cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture : exit=0`

`cargo test --offline -p omni-providers --test b4_error_fields : exit=0`

`cargo test --offline -p omni-providers --test b4_review depth_positions -- --nocapture : exit=0`

`python /tmp/opencode/b4-request-rereview/extend.py : exit=0`

`cargo fmt --all -- --check : exit=0`

`cargo test --offline -p omni-providers -p omni-ir -p omni-crypto : exit=0`

`cargo test --offline -p omni-providers --test b4_review -- --nocapture : exit=0`

`b4_review --exact independent : exit=0`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=0`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=0`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`cargo test --offline -p omni-providers --test antigravity_schema --test antigravity_wire --test antigravity_codec --test antigravity_cloak --test antigravity_depth --test antigravity_build_throw --no-fail-fast : exit=101`

`python /tmp/opencode/b4-request-rereview/mutate.py : exit=0`

`bun --no-env-file /tmp/opencode/b4-request-rereview/oracle.ts : exit=0`

`b4_review --exact independent raw-1e309 : exit=101`

`cargo test --offline -p omni-providers --test b4_review independent -- --nocapture : exit=0`

`cargo test --offline -p omni-providers --test antigravity_x1 -- --ignored : exit=101`

| Log | FAILED/panicked/^error | stack overflow/SIGSEGV/SIGABRT |
|---|---|---|
|adversarial-cloak-compare.log|0|0|
|adversarial-cloak.log|0|0|
|clippy.log|0|0|
|compare1.log|0|0|
|compare2.log|0|0|
|dispatch.log|0|0|
|error-fields.log|0|0|
|error-path.log|0|0|
|extend.log|0|0|
|fmt.log|0|0|
|gate.log|0|0|
|independent.log|0|0|
|minimal-compare.log|0|0|
|minimal.log|0|0|
|mutation-01.log|20|0|
|mutation-02.log|9|0|
|mutation-03.log|9|0|
|mutation-04.log|3|2|
|mutation-05.log|9|0|
|mutation-06.log|2|2|
|mutation-07.log|2|2|
|mutation-08.log|5|0|
|mutation-09.log|13|0|
|mutation-10.log|5|0|
|mutation-11.log|6|0|
|mutation-12.log|5|0|
|mutation-13.log|5|0|
|mutation-14.log|8|2|
|mutation-15.log|0|0|
|mutation-16.log|0|0|
|mutation-17.log|5|0|
|mutation-18.log|9|0|
|mutation-19.log|9|0|
|mutation-20.log|5|0|
|mutation-21.log|23|0|
|mutation-22.log|5|0|
|mutation-23.log|9|0|
|mutation-24.log|5|0|
|mutation-25.log|13|0|
|mutations.log|0|0|
|oracle2.log|0|0|
|overflow-frozen.log|0|0|
|overflow-rust.log|3|0|
|seed2.log|0|0|
|x1.log|18|0|

Mutation/X1 failures are intentional. Baseline gates are reported separately above.

## Restoration
```text
8bf97821615ea2e01cd6ae99af1149ef6a54c0b2
status porcelain: ''
Filesystem             Size  Used Avail Use% Mounted on
/dev/mapper/rhel-root  116G  102G   15G  88% /
```

Baseline gate: **62 summaries, 247 passed, 0 failed, 20 ignored**; sibling anthropic/openai API key/openai OAuth/custom corpora, adapter_e2e, decoder_errors, http_client/http_limits/http_zstd all ran. No observable sibling behaviour change found.

Fuzz classification: seed 756332 has 12,719 AUTH failures; seed 88342 has 12,814 AUTH and 1,242 UPSTREAM build throws. All client-facing error fields agree. All 78/28 differing rows have vendor.antigravity="🙂" and only X1 body differences. Total **40,000 requests / 39,894 equal / 106 parked X1 differences**.

Timing: debug 10,000 shallow builds **0 grows, 13.0030463 µs/request** versus first review scoped 41.8787601 and unscoped 10.7292245 µs/request. Shared-host load prevents treating the latency delta as a controlled performance benchmark; grows count is exact.

Depth matrix: every one of the 11 named positions passed both ordinary build/serialize/drop and null-schema error-path build/drop on 2 MiB, 39,990 levels. In error mode schema_free has nine prior deep declarations. response_free reaches responseSchema with a deep default before tool failure; vendor remains borrowed/unmerged because failure precedes final Object.assign.

| Position | No-scope success build/serialize/drop | Null-schema error cleanup |
|---|---|---|
|input|PASS|PASS|
|schema_free|PASS|PASS|
|options|PASS|PASS|
|vendor|PASS|PASS|
|response_free|PASS|PASS|
|native|PASS|PASS|
|system_native|PASS|PASS|
|result_native|PASS|PASS|
|provider_tool|PASS|PASS|
|headers|PASS|PASS|
|citations|PASS|PASS|

Minimal I1 rerun: request {"model":"m","stream":true,"messages":[],"tools":[{"kind":"portable","name":"t","inputSchema":null}]} with token t/project p gives both adapters {"code":"UPSTREAM","message":"antigravity codec buildRequest threw","provider":"antigravity","gatewayAuthored":true,"retryable":true}. Missing token instead gives AUTH/no-access-token/false; missing project gives AUTH/no-Cloud-Code-project/false, before schema evaluation. Root [1], [[1]], "x", "🙂" give parameters {} and pruning note; [], "", numbers/booleans give {} and no prune note. Kept valid t followed by null duplicate t succeeds; reversed order throws.

Additional minimal matrix: **30/30 equal**; independent cloak adversarial whole-request matrix **100/100 equal**, including contested read_file bases, reversed duplicates, empty/Unicode-only names, and 128/129/130-character names. Baseline built cloak iteration order matches frozen; private index changes only lookup strategy, not to_wire insertion or from_wire last-writer policy.

Extended seed coverage: 20,000 requests contain provider-owned tools; 10,000 have simultaneous Chat/Responses/Anthropic format candidates; 5,000 inject special numeric fields in-process (1,600 NaN, 1,641 +Infinity, 1,759 -Infinity). Auth failures short-circuit some generated cases, faithfully on both sides; counts are generation counts, not branch-hit counts. No raw ordinary error text is compared in place of client-facing adapter output.

Panic audit: wire fingerprint slices use newline-delimiter offsets or final string length, never UTF-8 interiors; stop slice uses min(len,5). Schema first()/strip_prefix fallbacks are non-panicking. Cloak claims indexing follows insertion for every base; name index follows Vec append. No client/credential-reachable indexing panic identified in built cloaks. Normal error data is discarded, not formatted into Throw.

Error-cleanup mutations 6/7 (replace deep-drop of partial request / prior declarations with ordinary drop) each abort in committed antigravity_depth: the tests detect these real deep-ownership regressions. Mutations 4/14 abort in schema fixture after expected assertion mismatch unwinds its raw deep node; those are test failure-path artifacts. No baseline depth abort occurred.

Corpus sizes independently queried from Bun: schema 593, wire 352, codec 118; cloak 132 enforced in passing test; profile 9 subprocess vectors in passing gate. The eight ignored request X1 rows each failed when explicitly run: seven serde surrogate parse failures and one vendor-body byte comparison, no unrelated failure reasons. Existing ignored lone-surrogate text remains parked.

Final gate exits: package tests **0**, clippy **0**, workspace fmt check **0**, dispatch_size **0**. Dispatch state machine **5,496 bytes**, ceiling 5,500. Each corresponding .exit file above records the full command and exit on the same line. All four gate logs have **0 failure-pattern matches / 0 crash-pattern matches**. Disk remained above 5 GiB; final available 15 GiB. Temporary mutation changes and harness removed; no product edits or commits retained.

Independent exact_error_fields test passed: compatibility build_request GatewayError equals adapter-produced GatewayError by derived PartialEq (every field), even after local degradation-producing system blocks and renamed tools; degradations empty, retryable true, gatewayAuthored true, provider antigravity. Evidence error-fields.log and b4_error_fields.rs. The two surviving mutations therefore identify missing **committed** coverage, not a baseline field mismatch.
