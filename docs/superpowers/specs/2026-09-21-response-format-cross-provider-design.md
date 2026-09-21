# Carrying a response schema to every provider

## Problem

A structured-output request kept its schema only when the client's ingress surface and the routed
provider happened to speak the same dialect. Of the 27 (spelling × encoder) pairs, 5 worked: 17
dropped the schema silently and 5 sent it in a spelling the backend rejects outright.

The cause is that the vendor bag is named after the **ingress surface**, not the target provider.
`/v1/chat/completions` writes `vendor.openai.response_format`, `/v1/responses` writes
`vendor.openai.text.format`, `/v1/messages` writes `vendor.anthropic.output_config.format`. An
encoder merging `vendor.openai` therefore sees the schema only when the client used one of the two
OpenAI surfaces, and sees it in whichever of those two spellings the client happened to use.

## Design

One reader in `packages/providers/src/responseFormat.ts`, reading all three spellings at their own
depth in a fixed precedence, and one mover for the Responses-shaped family. Every encoder emits the
spelling its own backend accepts:

| target | spelling |
|---|---|
| openai, muse, grok, custom (responses) | `text.format` |
| kimi, kilo, custom (chat) | `response_format` with `strict: true` |
| anthropic | `output_config.format`, schema closed |
| antigravity | `generationConfig.responseSchema` via `pruneSchema` |

### Measured backend behaviour

Probed against live credentials on 2026-09-21. These are the facts the design is built on; they are
not derivable from the code.

| backend | finding |
|---|---|
| Anthropic `/v1/messages` | `output_config.format` works, **no beta header needed**. `response_format` → 400 `Extra inputs are not permitted`. `output_format` → 400, deprecated. |
| Anthropic schema rules | Refuses any object node without explicit `additionalProperties: false`, at every depth — including one the client set to `true`. Rejects tuple-form `items` and `patternProperties` outright. |
| Codex `/v1/responses` | `text.format` works. `response_format` → 400 `Unsupported parameter`. |
| Cloud Code `v1internal` | `responseSchema` works; `responseJsonSchema` is ignored silently; `response_format` → 400 `Unknown name`. |

Because Anthropic's rule binds at every depth, the translation closes the schema **after** the
vendor merge — a client's own `additionalProperties: true` is overwritten, deliberately, since the
alternative is a 400.

## History

Five adversarial review rounds, 31 findings. The ones worth keeping:

**The depth cap must bind the reader and the walker in the same unit.** `closeObjects` walks schema
levels; an earlier `tooDeepToSerialize` walked raw object levels with a `MAX_DEPTH * 2` budget. That
multiplier fits only positions that cross a container before the child — `properties`, `$defs`,
`anyOf`. A chain of `items`, `propertyNames`, `contains` or `unevaluatedItems` crosses **one**
object level per schema level, so such a schema was accepted by the reader at twice the depth the
walker would close, and went to Anthropic half-closed — the exact 400 the closing exists to prevent.
The fix removes the conversion: both walk the same `SUBSCHEMA` position tables, one schema level per
step.

The first round to measure this rejected it. A mutant flipping the reader's bound survived, was
measured on `properties`-shaped schemas only, found identical, and dismissed as "a change with no
effect". It was a change with no effect *for that shape*. Round 5 built an `items` chain and the two
bounds diverged. **Measuring a mutant on one shape of input proves nothing about the others.**

**A schema past the cap is refused, not truncated.** Every codec serializes with `JSON.stringify`,
which recurses as deep as the schema — a half-closed body would throw in the codec instead. The
refusal lives in `fromSpec`, the single gate all three spellings pass.

**A refusal must not be silent.** Past the cap the reader returns nothing, which at an encoder is
indistinguishable from a request that never asked. A boolean predicate beside the reader is not
enough: it re-walks the same three spellings, drifts from the reader the moment either changes, and
cannot say *why* the read came back empty — so it reported a misspelled discriminator, an empty
object and a schemaless `json_object` all as `response-schema-too-deep`. `readResponseFormatResult`
returns a tagged result (`absent` / `malformed` / `tooDeep` / `readable`) and only the depth refusal
is reported.

**A native spelling outranks the translation only when this gateway can send it.** Structural
readability (`readableFormat`: record, `json_schema` or absent discriminator, record schema) is
necessary but not sufficient — a structurally valid schema past the depth cap is one the codec
cannot render, so it is removed and reported like any other refusal.

**Sharing is not nesting.** Neither walk tracked object identity, so one node reachable from several
positions was expanded once per path: 21 levels of `{a: child, b: child}` — 22 distinct nodes — took
1.3s to read and 1.9s to close, growing exponentially. JSON cannot express sharing, but plugins
build IR in-process. Both walks now remember visited nodes; the walker's memo is keyed on **depth as
well as identity**, because the same node reached lower down has less budget left and reusing the
shallow result would report `truncated: false` for a schema the reader refuses.

**The Anthropic vendor bag is merged whole.** Anything the encoder wrote to `output_config` — the
translation, and the reasoning path's `effort` — must be carried into the object that replaces it,
without outranking the client's own members. With nothing to rescue, the bag passes through
untouched: an unreadable value the client sent is the backend's to refuse, not ours to rewrite.

**The IR is shared across dispatch retries.** `moveToResponsesText` deleted `format` from
`req.vendor.openai.text` through a shallow merge alias, changing what later attempts read and
throwing outright on a frozen request.
