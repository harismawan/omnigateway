# Malformed upstream fields: item 2 checkpoint

## Request-side representation boundary: null numeric options

The frozen OpenAI builder treats explicit `maxTokens: null` and
`temperature: null` as present: OAuth records `openai:max-tokens-dropped` and
`openai:temperature-dropped`; API-key mode carries null numeric fields. Rust's
canonical `Option<f64>` collapses null and absence. This is outside the port's
gateway-reachable contract, not a codec behaviour exception: ingress rejects
null with HTTP 400 before either gateway calls a codec. The frozen schemas in
`apps/gateway/src/ingress/openai.ts:118–120`, `anthropic.ts:268–269`, and
`responses.ts:46–47` require optional numbers; assignments at
`openai.ts:297–299`, `anthropic.ts:682–683`, and `responses.ts:519–520` occur only
for values other than undefined. Plugin-produced canonical requests are out of
scope.

Reviewer label `null-bound/null` documents all three excluded inputs: the
API-key twin was omitted from `openai-review-inputs.json` previously; the two
OAuth rows (gpt-6-astra and gpt-5.5, formerly comparison rows 436–437) remain in
that file and are skipped by label in the reference loader. Thus 158 of the
original 161 reviewer inputs run, with three excluded for this single reason.
Every included row still compares the complete request, notes and decode state.

## Decoder checkpoint

Controller disposition: the eight non-numeric count rows are now **parked under
roadmap X1 (non-numeric upstream usage counts)**. No shared Usage change here.
Rust reports a number (2, 0, 1) or no numeric value (NaN renders null) where TS
forwards raw data; client usage bytes and the logged count differ for that
request. Historical unresolved wording below records the original checkpoint.

61 rows added before implementation changes: indexes 9, delta 9, terminal
response 9, usage 27, missing/item/type 7. Values are absent, null, string "2",
2.5, -1, 1e100, object, array, true. Every row compares events and three buffered
JSON answers at whole/one-byte/seven-byte chunking. No production changes.

Initial RED: `/tmp/opencode/b3/coercion-first-red.log`.
An oracle issue also surfaced: collecting JSON-round-tripped expected events
converted NaN into null. The oracle now collects original TS events, as the
gateway does. That removed the input_tokens={} buffered mismatch (row 130).

Eight genuine usage rows remain RED (`coercion-usage-red.log`):

| Row | Field/value | TS event value | Rust event value |
|---|---|---|---|
|107|output_tokens="2"|"2"|2|
|108|cached_tokens="2"|"2"|2|
|131|output_tokens={}|{}|null (NaN)|
|132|cached_tokens={}|{}|null (NaN)|
|137|output_tokens=[]|[]|0|
|138|cached_tokens=[]|[]|0|
|143|output_tokens=true|true|1|
|144|cached_tokens=true|true|1|

These affect buffered usage too: JS addition can concatenate strings or coerce
objects, while Rust performs numeric arithmetic. The shared public `Usage`
fields are f64 (documented existing exception in omni-ir/src/stream.rs).
They cannot carry TS's original string/object/array/boolean. Fixing just this
provider without changing the public IR cannot produce equal events and client
bytes. No such surface change was made. This is NOT X1 and has NOT been accepted
as a parked exception by the controller.

`malformed_usage_matches_ts` is ignored with an explicit unresolved reason;
run it with `--ignored --nocapture` for RED. The default comparator filters ONLY
rows whose expected output/cache usage is nonnumeric/non-null, not the entire
usage category. Thus 144 rows pass (91 prior + 53 new): 432 event comparisons
and 1296 buffered comparisons. The eight RED rows supply 24 further event and
72 buffered comparisons. Numbers denote attempts, not all buffers necessarily
fail. Decoder item 2 is incomplete pending the shared representation decision;
items 3–5 are not advanced in this checkpoint.
