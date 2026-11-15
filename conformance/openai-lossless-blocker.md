# Step 3 item 1: public IR blocker

Controller disposition: parked as roadmap **X1 (lossless UTF-16 stream text)**.
No public IR change in this provider increment. The retained ignored oracle is
X1's corpus, not an active prerequisite to the remaining provider work.

Observed client consequences in the retained RED run: text delta is lost and
the later valid completion succeeds with empty text; tool-argument delta is
lost and the completion succeeds with empty tool input; native done is lost
and completion succeeds with an empty native block. These three fixtures do
NOT end in an error. The fourth fixture's surrogate-bearing upstream error is
dropped, then finish emits a retryable premature-completion error. Buffered
collector/egress fixtures ignore error events and render empty content; this
is a library comparison, not a gateway HTTP error-path observation. Thus a
dropped terminal error still fails this stream, while dropped content followed
by a valid completion can silently succeed. No behavior was changed.

The frozen decoder accepts escaped unpaired UTF-16 units. `jsjson::parse_js`
and `JsValue::String(Vec<u16>)` can represent them, and `text::Text` is available.
They are not wired into the public stream/collected-request carriers at this
checkout. `Delta::{Text,Thinking,ToolJson}`, `StreamEvent::Error.message` use
Rust String; native deltas use `Map<String, serde_json::Value>`. Collected
`TextBlock.text` is String, `ToolUseBlock.input` is Value, and native data is a
serde map. A literal backslash-u string is not the same as a surrogate unit.
These public types cannot express the oracle's values. No approximation or
production change was made; stop requested by the controller applies here.

## Observed oracle cases

`tests/openai-lossless-reference.ts` runs six byte-stream fixtures with whole,
one-byte and seven-byte chunking (18 rows). JSON results travel in strings so
the Rust test harness does not itself reject surrogate-bearing expected values.

| Case | TS event payload | Buffered TS outputs |
|---|---|---|
| surrogate-text | text delta `"\ud83d"` | All three preserve `\ud83d` in text |
| surrogate-arguments | toolJson partial `"{\"x\":\"\ud83d\"}"` | Messages input object contains surrogate; Chat/Responses arguments string contains escaped JSON `{"x":"\ud83d"}` |
| surrogate-reasoning | native merge contains summary text and encrypted_content `"\ud83d"` | Messages/Responses preserve both fields; Chat emits empty text |
| surrogate-error | UPSTREAM message `"\ud83d"`, retryable true | Collector/egress do not render error as content; empty content in all three |
| invalid-utf8 | raw FF C0 AF inside delta becomes three U+FFFD characters | All three preserve those replacement characters; Rust matches |
| truncated-utf8 | EOF after F0 9F inside unfinished delta JSON; no delta, retryable premature-completion error | Empty text block; Rust matches |

Current Rust skips each surrogate-bearing JSON event. For text and arguments
that loses the delta; native done is lost including its block end; surrogate
error is lost and replaced at finish by premature-completion error. Expected
and actual exact event/client JSON strings for every chunking are logged in
`/tmp/opencode/b3/lossless-public-ir-red.log`. Full TS outputs:
`/tmp/opencode/b3/lossless-ts-outputs.json`.

`lone_surrogates_match_ts` is deliberately ignored in default gates with the
blocker reason, and explicitly fails when run with `--ignored`. This is a
retained RED, not a passing conformance claim. `raw_utf8_matches_ts` passes:
6 event comparisons plus 18 buffered-response comparisons. All four surrogate
cases fail event comparison in all three chunkings; Messages/Chat/Responses
buffered failures differ because Chat suppresses native reasoning and all
buffered collectors ignore error content.

To proceed requires approval for public IR changes: lossless text/argument/error
carriers, arbitrary JSON native/tool-input carriers, collector and all egress
writers. Parsing into JsValue alone cannot close the event and buffered-byte
contract. Update source boundary inventories and deep ownership checks with
that change. Items 2–5 remain pending; no codec registration or OAuth work.
