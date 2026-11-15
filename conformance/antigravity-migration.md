# Antigravity codec migration — partial foundation

Oracle: frozen TypeScript at 1780bb39. This note covers only the implemented
cloak and profile. It is **not** a completed codec literal/coercion audit.

| Frozen literal / rule | Rust location | Differential coverage |
| --- | --- | --- |
| `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$` | `antigravity/cloak.rs::valid` | `antigravity_cloak`, legal punctuation, initial digits/dots/dashes, 128/129 lengths |
| `[^A-Za-z0-9_.-]+`, initial `[A-Za-z_]` | `cloak.rs::alias` | Unicode, repeated refused characters, empty name |
| `_`, `_tool`, 128 ceiling, six-character suffix, truncation to 122 | `cloak.rs::alias` | empty/Unicode-only, oversized and colliding names |
| xxHash64 UTF-8, `0xffffff`, lowercase hex padded to six | existing `omni_crypto::cloak::antigravity_suffix` | aliases compared with Bun for all 132 rows |
| portable tools, history tool calls, unmatched result ids, explicit tool choice | `cloak.rs::ToolCloak::build` | all six corpus source modes; result calls may appear later |
| stable insertion order; reserved valid names claim first; suffix every collision | `cloak.rs::ToolCloak::build` | forward/reversed combined names, duplicate names, `read file` / `read/file` / `read_file` |
| `OMNI_ANTIGRAVITY_IDE_VERSION`, `2.12.2` | `profile.rs::headers` | profile vectors |
| `OMNI_UA_ANTIGRAVITY`, `antigravity/ide/`, `darwin/arm64` | `profile.rs::headers` | exact frozen codec header pairs |
| `User-Agent`, `Content-Type: application/json`, `Accept: text/event-stream` | `profile.rs::headers` | exact pairs, casing, order |
| `OMNI_ORDER_ANTIGRAVITY`; Host, Content-Type, Authorization, User-Agent, X-Goog-Api-Client, Accept, Accept-Encoding, Content-Length | `profile.rs::headers` | default and reordered headers; absent names skipped; duplicates consumed once |
| shared header SAFE `[\x20-\x7E]{1,200}` | `profile.rs::safe` | empty, 200/201 bytes, Unicode, control characters, space |
| comma splitting, JS trim, reject invalid entries, default if empty | `profile.rs::headers`, existing `omni_ir::js::trim` | whitespace/BOM/NBSP, duplicates, unknown names |
| import-time environment capture | `profile.rs::initialize` + OnceLock | TS mutation after import; Rust capture ignores a second source |

No arbitrary JSON is cloned or dropped by these components; the cloak only
borrows typed IR names. No JS String/Number coercion sites occur in these two
frozen modules (hash input is already a typed string). Lone-surrogate names are
not covered: the existing Rust IR cannot represent them. No new X1 tests were
added in this partial slice.

Pending literal and coercion audits: all of `codec.ts`, `wire.ts`, `decode.ts`,
model-dependent limits and the envelope body-order array in `profile.ts`.
No 40,000-level depth experiment has been run for this provider yet.

## Turn 2: schema pruning slice

`schema.rs` now ports `pruneSchema` and `scalarValue` from wire.ts. The statement
above about no depth experiment is superseded for tool schemas only.

| Frozen rule | Rust | Test |
| --- | --- | --- |
| MAX_SCHEMA_DEPTH 24; refuse non-record subschemas | `schema::sub` | 23/24/25/40 hops and 40,000 hops on 2 MiB thread |
| PRUNED = `antigravity:tool-schema-pruned`, deduplicated | `schema::prune` | all 574 rows compare degradation list |
| SCHEMA_TYPES string/number/integer/boolean/array/object/null/type_unspecified | `TYPES`, `walk` | scalar and union type rows, case handling |
| SCHEMA_FIELDS: six walked, four text, three texts, six int, two double, three free fields | `walk` match arms | every field crossed with 21 values |
| const string → enum unless own enum; unknown fields dropped | `walk` | initial four rows, unknown/$ref rows |
| integer spelling `^-?\d+$`; finite whole numbers | numeric match arm | decimal, fractional, exponent, hex, whitespace |
| double strings trim nonempty then Number finite | `js::trim`, `js::try_to_number` | string numeric neighbours |
| tuple items first; arrays of schema arms; empty property key dropped | `walk` | field/type shape matrix |
| structural inference uses original declared type for both agree calls | post-walk repair | inferred versus contradictory types |
| required/propertyOrdering filter to own known property names | post-walk repair | missing-name rows |
| lowercase `array` without items loses type; uppercase preserved | final repair | ARRAY/array rows |

Coercion audit of this slice: Number only receives strings, because scalarValue
checks typeof before calling it. Thus an object owning toString is dropped without
invoking coercion; no throwing coercion row applies here. `.trim()` likewise only
receives strings. Free fields are deep-cloned without coercion. Full request-side
coercion audit, JSON stringify edge cases and prototype-special keys remain pending.

Observed contradiction to task: frozen wire.ts clamps **every** model to the
global MAX_OUTPUT_TOKENS 65,536; models.ts advertises 65,535 on Pro. Future wire
implementation must preserve the global constant, not apply per-model ceilings.
No request implementation or test of that ceiling has landed yet.
