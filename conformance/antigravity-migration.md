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
