# Custom decoder coercion review

Frozen `packages/providers/src/custom/decode.ts` → Rust
`crates/omni-providers/src/custom/decode/`. All throwing sites return Throw;
nullish defaults remain nonthrowing. Existing vector corpus is unchanged.

| Frozen line | Rust counterpart | Can throw | Already yielded in same event |
|---|---|---|---|
|156 id/model|chat.rs apply text/Start|yes|none|
|163 usage → ir/stream.ts:70|mod.rs usage_of|prompt/read/write yes; output forwarded|Start if identity present|
|226 fallback index template and id|chat.rs new tool id|yes|Start, reasoning/text, previous BlockEnd, earlier tools|
|227 name|chat.rs new tool name|yes|same as id|
|266 finish template|chat.rs finish_reason|no, string guard|earlier content|
|384 index template|responses.rs ir_index|yes|none|
|416 event template|responses.rs unknown event|no, SSE string|none|
|429–430 id/model|responses.rs Start|string yes|none|
|449 call_id/name|responses.rs tool BlockStart|yes, after index|none|
|470/478/486 deltas|responses.rs text/thinking/tool delta|yes, after index|none|
|537/539 reason/status|responses.rs terminal message|yes|none|
|549 usage → ir/stream.ts:70|mod.rs usage_of|input/cache yes|none|
|567 code/type|responses.rs raw|yes|none|
|574 message|responses.rs message|yes|none|

Map/Set identity keys never coerce. nextIndex++ acts on internal numbers.
reasoningText uses string guards; concatenation combines strings only. Strict
comparisons and nullish selection do not coerce. No other numeric comparisons
or imported coercions reach upstream objects. Output count representation is X1.

FastChunk fields consumed by apply are Value, not typed strings: shadow id is
accepted, then apply throws. serde skips unknown fields through IgnoredAny,
so ignored:1e309 succeeds without constructing a number; id:1e309 fails and
falls back to deep::parse, which skips the event. The path-selection unit test
pins all three. The reference shadow-id row pins the resulting Throw.

54 ordinary reference rows (27 shadow sites/branches and 27 null controls),
whole/1/7/64/4096-byte chunking; four overflow rows in two ignored tests under
roadmap X1 (upstream numbers beyond the double range). Overflow loses identity
or usage events; no parser workaround. Fast corpus baseline: 75 vectors,
large fast hits 1863/1866; unchanged after the fix.
