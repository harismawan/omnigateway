# OpenAI request depth evidence (A1)

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
