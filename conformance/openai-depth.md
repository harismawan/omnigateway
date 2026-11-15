# OpenAI request depth evidence (A1)

## D OAuth/lite ownership inventory (source at 31db790c)

Paths below are relative to `crates/omni-providers/src/`. This inventory includes
arbitrary values reachable through provider-native items, not only normal
message shapes. D is in progress; a listed path is not a depth-safety claim.

| Carrier / ownership operation | Source file:line |
|---|---|
| Vendor text/reasoning per-field merge | openai/wire.rs:321–337 |
| Vendor scalar/array replacement and arbitrary extension | openai/wire.rs:337 |
| Client metadata ignored, generated replacement | openai/wire.rs:323–325,402 |
| Vendor input overwritten by assembled lite history | openai/wire.rs:337,394 |
| Vendor stream overridden; ordered body owned/written/dropped | openai/mod.rs:90–118 |
| Tool schema clone, OAuth strict:false, lite tools owner | openai/wire.rs:234–253; openai/lite.rs:14,22–29,56–61 |
| Tool input borrowed → argument string; results string/media; native result ignored | openai/wire.rs:107–115 |
| Native fields cloned except id; foreign native ignored | openai/wire.rs:117 |
| Intermediate input/repaired vector; orphan repair | openai/wire.rs:79–89,135–155,202 |
| Cache fallback first-item copy | openai/wire.rs:175–187 |
| Response-format schema and text replacement | openai/wire.rs:370; response_format.rs (shared helper) |
| Lite message content clone; assistant annotations replaced | openai/lite.rs:139–154 |
| Lite function call/output fields (native input can carry arbitrary values) | openai/lite.rs:157–161 |
| Native reasoning clone / old passthrough removal | openai/lite.rs:163–171 |
| Unknown native item passthrough clone | openai/lite.rs:173 |
| LiteArgs input/tools iterative drop; returned input clone | openai/lite.rs:22–29,184; openai/wire.rs:394 |
| Credential provider_data borrowed, secrets/account string selection | openai/identity.rs:30–40; openai/oauth.rs:53–58; openai/mod.rs:136 |
| Generated turn/client metadata | openai/oauth.rs:63–75 (turnId generated string, startedAt number) |
| System/provider tools ignored arbitrary native payloads | openai/wire.rs:158,234–253 (shared system helper; portable tools only) |

Response-format helper and shared system/tool-file helper line-level inventory
still needs expansion in the next D set. Generated metadata/provenance is
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

Remaining D: tool schemas/strict and lite tool prefix ownership, borrowed tool
inputs/results/native result payload, native reasoning and passthrough replacement,
native message/function/unknown shapes, response-format schema/text replacement,
cache fallback and credential arbitrary fields; expand shared helper inventory.

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
