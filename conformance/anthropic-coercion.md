# Anthropic decoder coercion review

Frozen `packages/providers/src/anthropic/decode.ts` → Rust
`crates/omni-providers/src/anthropic/decode.rs`:

| Frozen line | Rust counterpart | Can throw | Already yielded in same event |
|---|---|---|---|
|193 unknown event template|unknown event format|no, SSE string|none|
|205 id/model|Start name helper|yes, nullish defaults empty|none|
|226 tool id|tool_use id name helper|yes, before name|none|
|227 tool name/uncloakName|tool_use name then uncloak lookup|yes conversion; lookup no|none|
|244 unknown block type|block type protocol error/name|yes|none|
|317 unknown delta type|delta type protocol error/name|yes|none|
|345 stop reason template|message_delta protocol error|no, string guard|none|
|377 error type|error name(type)|yes, before message|none|
|378 error message|error name(message)|yes, nullish default|none|

No Number, Math or numeric comparisons coerce upstream fields here. Usage is
forwarded raw in frozen, not arithmetically coerced (representation remains X1).
Set keys are identity operations. Delta text helpers accept strings only.
Fingerprint and uncloak helpers receive already converted strings.
Sixteen new reference rows: eight shadow sites and eight null controls; existing
reference is message-based, so no added chunking. All prior rows stay intact.
Two overflow streams are explicitly ignored under roadmap X1 (upstream numbers
beyond the double range): numeric identity or ignored extension drops Start
in Rust, whereas frozen preserves it. No parser change.
