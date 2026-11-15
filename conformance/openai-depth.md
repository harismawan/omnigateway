# OpenAI request depth evidence (A1)

## D7 credential data (group 5)

| Carrier | Source | Evidence |
|---|---|---|
| Credential arbitrary provider data / owner drop | codec.rs:23–29,46–50; openai/mod.rs:132–138 | DEFECT: unmodified accountId case SIGABRT; iterative Drop fixes it; plain-drop mutation SIGABRT for accountId, installationId, idSalt, extension |
| Credential installationId/idSalt borrowed filtering | openai/identity.rs:30–46; openai/oauth.rs:53–58 | Structurally borrowed, type-filtered strings only; deep values retained solely by credential owner, destruction proven above |
| Credential clone | codec.rs:30–39 | DEFECT: adding clone/drop to fixed accountId case SIGABRT with derived Clone; manual deep clone fixes it |

Four cases now pass at 39,990 levels / 2 MiB, including credential clone/drop.
No credential JSON enters builder ownership. New Drop requires explicit fields
instead of struct-update Default in ten test fixtures; wire comparisons unchanged.
Logs `s4e-g5-baseline.log`, `s4e-g5-drop-credential_*.log`,
`s4e-g5-clone-first.log`, `s4e-g5-clone-fixed.log`. Drop mutations restored.
Derived PartialEq remains: not used on this codec path; no equality-depth claim.

## D6 ignored payloads (group 4)

| Carrier | Source | Evidence |
|---|---|---|
| Foreign-native data | openai/wire.rs:117 | Remove mod.rs:70 scope → PASS; structurally safe: borrowed identity check, no builder ownership; IR iterative drop |
| System native data | openai/wire.rs:158; system.rs:14–22 | Remove mod.rs:70 scope → PASS; structurally safe: borrowed discriminant only, no builder ownership; IR iterative drop |
| Provider-tool wire | openai/wire.rs:234–253 | Remove mod.rs:70 scope → PASS; structurally safe: only portable tools processed; IR iterative drop |

All three unmodified 39,990-level / 2 MiB subprocess cases pass, including
request destruction; no new defect. Scope mutations restored. Logs:
`s4e-g4-baseline.log`, `s4e-g4-noscope-{ignored_foreign,ignored_system,ignored_provider_tool}.log`.

## D3 ordinary tool carriers (s4e)

### D5 native annotations and aliases (group 3)

| Carrier | Source | Evidence |
|---|---|---|
| Assistant annotations | openai/lite.rs:147–151 | content deep clone → plain clone: SIGSEGV 11 |
| Function name | openai/lite.rs:169 | field deep clone → plain clone: SIGSEGV 11 |
| Function call_id | openai/lite.rs:169 | field deep clone → plain clone: SIGSEGV 11 |
| Function output call_id | openai/lite.rs:177 | field deep clone → plain clone: SIGSEGV 11 |

Four unmodified cases pass at 39,990 levels / 2 MiB. Annotations are nested
inside an assistant output_text part and discarded (small body asserted).
Mutation proves clone protection, not independently the subsequent replacement.
All three clone-site mutations applied together; cases isolate each field.
Restored; no product defect. Logs: `s4e-alias-baseline.log` and
`s4e-alias-clone-{native_annotations,native_name,native_call_id,native_output_id}.log`.

### D4 response format (group 2)

| Carrier | Source | Evidence |
|---|---|---|
| Response-format schema default | openai/wire.rs:370; response_format.rs:128–131,188,219–228 | Remove mod.rs:70 scope → stack overflow, SIGABRT 6 |
| Text format replacement | response_format.rs:199–215,227 | Remove mod.rs:70 scope → stack overflow, SIGABRT 6 |
| Malformed text removal | response_format.rs:190–193 | Remove mod.rs:70 scope → stack overflow, SIGABRT 6 |

All three unmodified cases passed at 39,990 levels / 2 MiB; no product
defect found. Scope protects recursive destruction of helper temporaries and
removed values. Mutations restored. Logs: `s4e-format-baseline.log` and
`s4e-format-noscope-{format_schema,format_replace,format_text_drop}.log`.

Clippy correction: c0875139 introduced three denied unwraps in
tests/openai_decode.rs; 6bf18cba replaces them with neighbouring-test-style
expect messages. `s4e-clippy-fixed.log` ends with Finished dev profile (0.59s).

| Carrier | Source | Evidence |
|---|---|---|
| Ordinary tool input | openai/wire.rs:107 | Remove mod.rs:70 scope: PASS; structurally safe, borrowed input written by stack-growing jsjson writer, retained as String in lite history |
| Tool result string | openai/wire.rs:111 | Remove mod.rs:70 scope: PASS; structurally safe, content is String, not arbitrary JSON |
| Tool result media | openai/wire.rs:110–115 | Remove mod.rs:70 scope: PASS; structurally safe, typed image/file fields are strings; moved parts are shallow |
| Ignored tool result native | openai/wire.rs:109 | Remove mod.rs:70 scope: PASS; structurally safe, presence check only, never copied; IR owner drops iteratively |

Four new subprocess cases pass unmodified at 39,990 levels / 2 MiB, bringing
the focused harness to 18 cases. String/media cases carry nested JSON text
and a deep ignored native owner; these are not claims of recursive portable
result fields. Scope removal independently passed all four cases. No product
defect found; no protection-removal crash claimed. Mutations restored.
Logs: `/tmp/opencode/b3/s4e-group1-baseline.log` and
`s4e-noscope-{ordinary_input,ordinary_result_native,ordinary_result_string,ordinary_result_media}.log`.

### D6 explicit non-lite control and helper inventory

`nonlite_schema` selects API-key mode (therefore the non-lite tools insertion
at wire.rs:253). All 33 cases pass at 39,990 levels / 2 MiB
(`s5a-depth-baseline.log`). Plain schema clone fails with SIGSEGV
(`s5a-nonlite-mutation.log`); repaired-vector plain clone likewise fails for
native_reasoning (`s5a-repaired-mutation.log`). No new product defect found.
Replacing both LiteArgs iterative drops with ordinary drop passes tool_schema
and native_reasoning: these drops occur inside the outer codec stack scope,
so that experiment does not independently prove the iterative release needed.
Logs: `s5a-args-drop-{tool_schema,native_reasoning}.log`. All restored.

The canonical inventory below includes each ownership stage once; evidence
tables elsewhere describe mutations of those stages, not additional owners.
Completeness checked against `grep -nE 'Value|Map|deep::|let (mut )?(raw|read|client_text|text|next|spec|parts|input|repaired|history|out|result)'`
over response_format.rs, system.rs, tool_result_files.rs, openai/wire.rs and
openai/lite.rs: **149 output lines**, saved as `s5a-inventory.log`.
Borrowed references and bounded generated objects are included explicitly.

Credentials: workspace Rust search (`grep -RInE 'Credentials|PartialEq|assert_eq!|==' crates --include='*.rs'`,
`s5a-comparisons.log`) found no non-test equality/container/bound use of this
type. Removed recursive PartialEq derive; `cargo check --offline --workspace
--all-targets` succeeds (`s5a-workspace-check.log`). Clone/drop remain deep.

## D OAuth/lite ownership inventory (source at 31db790c)

### D2 tools/native checkpoint — product defect found and fixed

**Unmodified tool-schema, native function-call arguments and native function
output cases failed with SIGSEGV.** The lite assembler's `json!` expression
serialization recursively walked arbitrary JSON even inside its 16 MiB scope.
Tool-prefix construction and final result wrapping both needed correction:
prefix-only correction still failed (`s4d-schema-prefix-only.log`); replacing
final wrapping with a move then passed. Function fields needed explicit deep
cloning rather than `json!` serialization. All replacements preserve key order.
New implementation uses deep clone/insert, Owned temporary, and moves input.
No scope sizing, public IR, dependency, HTTP, or tripwire exception changes.

Eight new cases join the six D1 cases: all 14 build/drop at 39,990 levels on
2 MiB subprocess threads. Native cases select conversationId to bypass cache
fallback; the separate cache case omits it. Retained/discarded sizes asserted.
Source locations below reflect the corrected lite.rs (wire.rs unchanged).

| Carrier/source | Scratch mutation after fix | Observed outcome |
|---|---|---|
| Tool schema strict:false, wire.rs:241–243; lite prefix lite.rs:59–69 | wire schema deep clone → plain clone | SIGSEGV 11 |
| Native reasoning payload, lite.rs:183 | item deep clone → plain clone | SIGSEGV 11 |
| Native reasoning old passthrough removal, lite.rs:183–189 | item deep clone → plain clone | SIGSEGV 11 |
| Native message content, lite.rs:147 | content deep clone → plain clone | SIGSEGV 11 |
| Native function-call arguments, lite.rs:169 | field deep clone → plain clone | SIGSEGV 11 |
| Native function output, lite.rs:177 | field deep clone → plain clone | SIGSEGV 11 |
| Unknown native item, lite.rs:192 | item deep clone → plain clone | SIGSEGV 11 |
| Cache first-item fallback, wire.rs:184 | deep clone → cloned() | SIGSEGV 11 |

All mutations restored. Lite clone-site mutations ran together; each named
case selects its relevant match branch. Cache/schema mutations ran together,
with depth only at the named site. Baseline failure log:
`/tmp/opencode/b3/s4d-native-baseline.log` (tool schema); native call/output
failures: `s4d-native-first-{native_call,native_output}.log`. Mutations:
`s4d-native-clone-{tool_schema,native_reasoning,native_metadata,native_message,native_call,native_output,native_unknown,cache_fallback}.log`.
Restored focused depth plus 289 request comparisons: `s4d-native-fixed.log`.

Historical D2 omissions were closed by subsequent groups and D6 above.

Paths below are relative to `crates/omni-providers/src/`. This inventory includes
arbitrary values reachable through provider-native items, not only normal
message shapes. Evidence is in the per-group mutation tables.

| Carrier / ownership operation | Source file:line |
|---|---|
| Vendor text/reasoning per-field merge | openai/wire.rs:321–337 |
| Vendor scalar/array replacement and arbitrary extension | openai/wire.rs:337 |
| Client metadata ignored, generated replacement | openai/wire.rs:323–325,402 |
| Vendor input overwritten by assembled lite history | openai/wire.rs:337,394 |
| Vendor stream overridden; ordered body owned/written/dropped | openai/mod.rs:90–118 |
| Tool schema map/vector; OAuth strict:false and explicit non-lite insertion | openai/wire.rs:234–253; nonlite_schema and tool_schema plain-clone SIGSEGV |
| Tool input borrowed → argument string; results string/media; native result ignored | openai/wire.rs:107–115 |
| Native fields cloned except id; foreign native ignored | openai/wire.rs:117 |
| Message parts/flush map → input → repaired; orphan repair | openai/wire.rs:77–89,135–155; parts are bounded text/media; native input moves without recursion; answered holds strings only |
| Repaired input copy into body | openai/wire.rs:202; native_reasoning plain-clone SIGSEGV |
| Cache fallback first-item copy | openai/wire.rs:175–187 |
| Response-format borrowed source/spec/schema and traversal vectors | response_format.rs:66–118,135–176; references only, breadth traversal |
| ResponseFormatRead/ResponseFormat schema owner | response_format.rs:19–30,128–131; deep clone, scoped drop; format_schema scope-removal SIGABRT (prior evidence) |
| Removed raw format/malformed text; client_text clone; text/copy/removed format | response_format.rs:188–209; scoped recursive drops; format_replace/format_text_drop evidence in earlier groups |
| Translated next/spec maps and moved schema | response_format.rs:210–237; deep insert/clone, values moved into body; format_schema exercises this stage |
| Lite message content clone; assistant annotations replaced | openai/lite.rs:139–154 |
| Lite function call/output fields (native input can carry arbitrary values) | openai/lite.rs:157–161 |
| Native reasoning clone / old passthrough removal | openai/lite.rs:163–171 |
| Unknown native item passthrough clone | openai/lite.rs:173 |
| LiteArgs input/tools owner | openai/lite.rs:13–14,22–29; ordinary-drop mutations pass within codec scope (structurally protected by scope) |
| Lite tool prefix, history/out/result owners | openai/lite.rs:56–69,200–206; bounded wrapper moves history, deep Owned release; arbitrary payload copies covered by D2 per-field cases |
| Returned lite input clone | openai/wire.rs:394; deep clone, vendor input replacement evidence D1 |
| Credential provider_data borrowed, secrets/account string selection | openai/identity.rs:30–40; openai/oauth.rs:53–58; openai/mod.rs:136 |
| Generated turn/client metadata | openai/oauth.rs:63–75 (turnId generated string, startedAt number) |
| System/provider tools ignored arbitrary native payloads | openai/wire.rs:158,234–253; system.rs:9–23 borrows blocks, retains only str references and joined String; ignored_system/provider_tool cases structurally safe |
| Tool-result file split/parts owner | tool_result_files.rs:93–115,145–169; borrowed FileBlock, String text; generated Value parts contain strings only; ordinary_result_media scope-removal passes |

Generated metadata/provenance is
bounded JSON made from strings/numbers/bools; arbitrary credential fields are
borrowed and filtered by type, not copied into metadata.

### D1 vendor checkpoint

`openai_oauth_depth::vendor_carriers_on_small_stack`: six subprocess cases,
39,990 nested arrays, 2 MiB thread, builds and drops request/result. Baseline
all pass; no defect found in this set. Retained/discarded body sizes asserted.
Mutation logs `/tmp/opencode/b3/s4d-depth-*.log`; all mutations restored.

| Carrier | Scratch mutation | Observed process outcome |
|---|---|---|
| text per-field merge | wire.rs:334 plain value.clone | SIGSEGV (11) |
| reasoning per-field merge | wire.rs:334 plain value.clone | SIGSEGV (11) |
| reasoning array replacing scalar/object slot | wire.rs:337 plain v.clone | SIGSEGV (11) |
| vendor input replaced by lite input | wire.rs:394 plain insert + remove mod.rs:70 scope | stack overflow / SIGABRT (6) |
| vendor stream overwritten by true | mod.rs:90 plain insert + remove mod.rs:70 scope | stack overflow / SIGABRT (6) |
| client_metadata ignored/replaced | same scope removal and plain inserts | Pass; arbitrary client metadata is borrowed then skipped at wire.rs:323, never copied/owned by builder; typed request releases iteratively. Replacement metadata contains only generated primitives. |

Clone mutations applied at both merge sites together; each case reaches its
specified site. Insert mutations applied to both input/stream together; each
case puts depth only in its named field. Metadata case uses the same mutation
and is structurally safe for the stated reason, not mutation-proven protection.
Logs: `s4d-depth-vendor-baseline.log`, `s4d-depth-clone-{text_merge,reasoning_merge,scalar}.log`,
`s4d-depth-insert-noscope-{input_replace,stream_replace,metadata}.log`.

D1/D2 evidence is retained as historical evidence.

## Decoder depth (step 3 item 3)

Four 39,990-level/2 MiB subprocess fixtures in `openai_decode::decoder_depth`
build events, collect and drop them. Native plain-clone mutation terminates
with SIGSEGV (`decode-native-clone-red.log`, prior checkpoint).
Scope removal alone passes arguments, unknown and error (`decode-noscope-
arguments.log`, `decode-noscope-unknown.log`, `decode-noscope-error.log`).
Mutation restored. These three are structurally safe without that outer scope:

- Function argument payload is a String, not a recursive JSON owner. Collector
  parse_tool_json supplies its own scope and stack-growing parser; ToolUseBlock
  releases the parsed input iteratively. Removing decoder scope cannot remove
  these independent collector protections. No clone of argument JSON occurs
  in the decoder. This is not a mutation-proven collector protection claim.
- Unknown output payload is ignored; parser grows its stack, parsed Owned
  releases iteratively, and decoder retains no payload. Removing outer scope
  leaves those helpers intact; no recursive decoder operation remains.
- Error-message coercion borrows parsed JSON; js::to_string guards array
  recursion with deep::grow. Result is String; parsed Owned releases iteratively.
  No retained arbitrary JSON and no recursive unguarded decoder drop.

No additional unsafe scratch ownership copies were introduced merely to force
failure. Passing removal results and helper-based structural reasoning are
reported separately from the native mutation's observed process failure.

`openai_depth.rs` constructs shallow typed IR, then moves in 39,990 nested
arrays. Each case builds and drops the result and request on a 2 MiB thread in
an isolated process. Payload size assertions distinguish retained from discarded
data. Response schema depth is in `default` data, not schema nesting subject to
the separate 64-level schema policy.

Logs: `/tmp/opencode/b3/a1-*.log`. Scratch mutations were restored; no product
change was needed. These are observed process outcomes, not inferred failures:

| Case | Scratch mutation | Outcome |
|---|---|---|
| vendor | Replace object_assign's deep copy with per-entry plain clone | SIGSEGV |
| vendor_replace | Plain insert at codec stream override | Pass |
| vendor_replace | Remove scope only | Pass |
| vendor_replace | Plain insert AND remove scope | stack overflow / SIGABRT |
| tool_input | Insert plain clone before borrowed argument writer | SIGSEGV |
| tool_schema | Replace deep schema clone with plain clone | SIGSEGV |
| native | Replace deep native-field clone with plain clone | SIGSEGV |
| native_drop | Remove scope | Pass: no encoder copy/walk/drop of borrowed data |
| format_schema | Remove scope | stack overflow / SIGABRT |
| format_drop | Remove scope | stack overflow / SIGABRT |

Scope removal alone also passed vendor, tool_input, tool_schema and native.
Those paths use iterative clone/release and stack-growing JSON writing. Tool
input is borrowed, never cloned by the real encoder; its clone mutation is an
introduced regression, not removal of an existing clone guard. Foreign native
payloads (including tool-result native data) and provider-tool wire payloads
are only inspected for presence/provider identity: no arbitrary JSON enters
encoder ownership there. IR owners release them iteratively. Message parts
are shallow strings/media; native fields move into input; input moves into the
body; ordering moves values, never clones them. Cache fallback uses deep clone
of the first item (the native case exercises this), owned release and the shared
writer. Vendor values can replace any of these positions through deep helpers.

The eight-case baseline and restored full suite pass. Full three-crate command:
45 successful test result summaries, 213 passes including nested subprocesses,
2 ignored, zero failures (`a1-tests.log`). All-target strict clippy, fmt check,
diff check and the three source tripwires pass. Builds disable incremental and
dev/test debug info. These tests do not establish gateway lifecycle coverage;
that remains step 5.
