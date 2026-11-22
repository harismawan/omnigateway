# Wire RTK into dispatch; remove ponytail

Status: draft, 2026-11-22. Builder-checked: nothing open.

## Why

In 1.x, two operator "request handling" settings are stored, editable, and shown in the console
as if they work. Neither does anything:

- `rtkEnabled` is supposed to compress historical shell tool results. `crates/omni-rtk` is a
  complete, tested port of the 0.x filters, but nothing calls it.
- `ponytailMode` is supposed to append a coding-style ruleset of about 1,240 tokens to every
  system prompt. It has no implementation in Rust.

Settings that silently do nothing mislead operators. The operator's decision:

- **RTK:** implement it, by wiring the existing crate the way 0.x did.
- **Ponytail:** remove it everywhere.

Everything else about RTK is already designed and approved:

- `2026-08-10-rtk-tool-result-compression-design.md` sets out eligibility, filters, the
  acceptance guard, the report, the request-log fields and the privacy boundary.
- `2026-08-10-rtk-filter-expansion-design.md` describes the filter catalog.

This document covers only what changes in the Rust tree: where the call goes, what it records,
and what ponytail's removal touches. Where this document and the 2026-08-10 spec disagree about
the Rust tree, this one wins. The 2026-08-10 spec still governs RTK's semantics.

## Goals

- When `rtkEnabled` is true, every dispatched inference request passes through
  `omni_rtk::transform_request` exactly once. The resulting request is the one that gets routed
  and sent on every attempt.
- Every row a dispatched request completes carries that request's RTK report in the existing
  `request_logs.rtk_*` columns.
- `ponytailMode` disappears from the settings schema, the API, the CLI, the console and the docs.
  Any stored value is inert and invisible.
- The CLAUDE.md, ARCHITECTURE.md and README statements that "RTK and ponytail do not run" become
  true statements about the new behaviour.

## Non-goals

- No change to RTK semantics: no new filters, eligibility rules or report fields. `omni-rtk` is
  used as it is. If wiring it exposes a bug in the crate, fixing that bug is in scope. Anything
  beyond that needs a new spec.
- No new database migration. `request_logs` already has every `rtk_*` column on SQLite and
  Postgres, and the writer already persists `RequestLog.rtk_*`.
- No new operational log (stdout) fields. `FIELD_ORDER` in `omni-gateway/src/logging.rs` is
  unchanged: the privacy boundary of the 2026-08-10 spec holds.
- No RTK in `POST /v1/messages/count_tokens`. 0.x never applied RTK there. The estimate stays an
  over-count of what is sent, never an under-count, which is the safe direction for a client
  pacing its compaction.
- No change to the five unserved providers (kimi, kilo, grok, muse, qoder): the operator chose to
  leave them as they are.

## Anti-goals

These are failures even if everything else works:

- RTK applied per attempt, or differently between failover attempts.
- RTK applied to guardrail or smart-router classifier calls. Those set
  `DispatchOptions::request_transforms: false` and must still receive the request untouched.
- A transformed request leaking into the **client** half of body capture. The client body is what
  the client sent. The wire bodies are what went to the provider, which is post-RTK.
- Any prompt text, command, tool name, tool-use id or path reaching a log line or a new column.
- A settings `PUT` from an older console or CLI that still sends `ponytailMode` starting to fail.

## Constraints

From CLAUDE.md and existing code:

- **`omni-rtk` stays pure.** It does no I/O, reads no clock and does no `tracing`. The call site
  owns side effects.
- **Dispatch is `crates/omni-gateway/src/dispatch.rs` `dispatch_with_options`.** It owns
  retries, deadlines, failover and the commit point. The placeholder comment that already marks
  the spot ("RTK and ponytail would run here") is immediately before `resolve_model` /
  `local_only_model`.
- **The router ranks on the transformed request.** `rank(&RankInput { request: &req.request, … })`
  must see the same `ChatRequest` that is sent. Capability filters are not expected to change
  under RTK, which only shortens tool-result text, but there must be one request, not two.
- **Every completion path records the report exactly once.** That covers success, pre-commit
  failure, post-commit in-stream error, client cancellation (499 from `Finisher`) and deadline.
  The report lives on the shared `RequestLog` behind `log: Arc<Mutex<RequestLog>>`, which every
  path already finishes from. `fin.outcome` is that same `Arc`; `screen_first` copies the inner
  log into its own; the `Finisher`'s 499 and deadline paths read `outcome`. Set the report on
  `base` before `resolve_model`, and every path carries it.
- **Pre-dispatch failures keep the zero report.** These are auth, parse, limits, screening
  refusal (`refused`) and writer overload. `RequestLog::new` already zeroes it.
- **Settings strictness.** `omni-control/src/settings.rs` `parse_patch` walks the keys of
  `default_settings_json()`, so a key absent from the defaults is ignored, never refused.
  Removing `ponytailMode` from the defaults therefore makes older clients' writes pass silently,
  which is the intended behaviour. Verify it with a test, not by inspection.
- **Stored settings are read back through `decode` (`omni-control/src/settings_value.rs`)**, the
  path behind `GET /api/settings` and the CLI on both backends. `decode` deliberately copies every
  stored key back out, unknown ones included, and its `extra` test pins that. So removing the
  default alone would still echo a stored `ponytailMode`. Strip that **one** key in `decode`; do
  not start dropping unknown keys in general. Whether the blob also loses it on the next write is
  the builder's call. Either way it must be invisible and inert.
- **The CLI after removal.** `omni settings set ponytailMode …` answers "no setting" (exit 2),
  like any other unknown name. That is expected, not a regression.
- **Console boundary.** `apps/dashboard` talks to `/api/*` only. `src/api/types.ts` mirrors the
  settings shape. `rustMirrors.test.ts` holds the constants copied from Rust.

## How it works

### RTK call site

In `dispatch_with_options`, after the snapshot is loaded and before model resolution:

```text
let rtk_on = options.request_transforms && settings.rtk_enabled;
let transformed = omni_rtk::transform_request(&req.request, &RtkConfig { enabled: rtk_on });
copy transformed.report into the shared RequestLog's rtk_* fields
replace the request used from here on with transformed.request
  (Cow::Borrowed when nothing changed, so no clone in the common case)
then resolve_model / local_only_model / rank / attempts exactly as today
```

The deadline check that 0.x performed before and after the transform falls out of the existing
structure. The Rust dispatch deadline is a `tokio::time::Instant` enforced around attempts. The
transform is synchronous and bounded (2026-08-10 spec, "Error Handling and Resource Bounds"), so
no new check is required. If the builder finds a place where a long transform could overrun an
already-expired deadline unnoticed, they add the check there.

Report-to-row mapping (`RtkReport` → `RequestLog`):

| report | row | conversion |
|---|---|---|
| `applied` | `rtk_applied` | as is |
| `filter_hits` | `rtk_filter_hits` | `u64` → `i64`, saturating |
| `original_code_units` | `rtk_original_code_units` | same |
| `compressed_code_units` | `rtk_compressed_code_units` | same |
| `estimated_tokens_saved` | `rtk_estimated_tokens_saved` | `f64` → `i64` through the writer's existing `int()`; exact, because both estimates are sums of whole numbers (`omni-ir/src/tokens.rs` uses `div_ceil`), so the saving is a whole number ≥ 0 |
| `filters` | `rtk_filters` | `RtkFilterId::as_str`, first-application order |

`skipped_internal_errors` is not persisted, as in the 2026-08-10 spec.

### What sees which request

- **Router, adapters, wire body capture:** the transformed request.
- **Client body capture:** the request as received. `Collector::request` takes the raw body in
  `server.rs` before parsing. The wire half comes from `wrap_for` on the HTTP client, so it
  records exactly what was sent, after RTK. Pin both with a test.
- **Guardrail and smart-router classifiers:** `request_transforms: false`, so RTK is off for the
  classifier dispatch itself. They also judge the parent request as received: `screen_first`
  (`screening.rs`) judges `req` before it calls `dispatch_with_options` for the parent, which has
  default options and therefore RTK on. Keep that order.
- **`count_tokens`:** as received (see Non-goals).

### Ponytail removal

Remove from:

- **`omni-store/src/settings.rs`:**
  - the `ponytailMode` default;
  - the normalisation `set("ponytailMode", …)`;
  - `PonytailMode`;
  - `Settings.ponytail_mode`.
- **`omni-control/src/settings.rs`** (the `ponytailMode` validation branch) and
  **`settings_value.rs`** (the key list, plus the one-key strip in `decode`).
- **`omni-gateway`:**
  - the ponytail half of the `dispatch.rs` comment;
  - the `server.rs` `count_tokens` comment;
  - the `DispatchOptions::request_transforms` doc, which becomes "whether RTK may run".
- **`omni-cli`:** any help text naming it (`registry.rs`).
- **`apps/dashboard`:**
  - `PonytailMode` and the field in `api/types.ts`;
  - `PONYTAIL_LEVELS` and the "Lazy senior dev mode" control in `SettingsBoard.tsx`;
  - the draft and patch plumbing;
  - the ponytail test in `test/features/settings.test.tsx`;
  - fixtures.
- **Docs:**
  - `README.md` (the feature bullet and the settings list);
  - `ARCHITECTURE.md`;
  - `CLAUDE.md`, where the "RTK and ponytail do not run" bullet becomes a short RTK rule that
    names its pins.

Specs and plans under `docs/superpowers/` are history and stay as written.

The RTK switch's console copy ("Compresses recognized historical tool results…") stays, because
it becomes true. The module meta "applied before dispatch" stays too.

## Testing

Synthetic credentials and local fake upstreams only, as everywhere in this repo.

- **Dispatch** (`crates/omni-gateway/tests/dispatch.rs`, or a new `tests/rtk.rs` that uses the
  same harness):
  - RTK off: the upstream receives the tool result unchanged, and the row has the zero report.
  - RTK on, with an eligible historical shell tool result (a fixture the `omni-rtk` suite already
    compresses): the upstream receives the compressed text, and the row carries `applied = true`,
    hits ≥ 1, `compressed < original` and the filter ids. Cover this on both the streaming and
    the non-streaming paths.
  - **Failover:** the first attempt fails pre-commit and the second succeeds. Both attempts'
    upstream bodies carry the same compressed text, and the report is recorded once.
  - **Post-commit in-stream error and client cancellation (499):** the row still carries the
    report.
  - **`request_transforms: false`:** the request goes untouched even with RTK on.
- **Route:**
  - With RTK and body capture on, the client body is the original and the attempt body is
    compressed.
  - `count_tokens` is unchanged by RTK.
  - A guardrail key with RTK on: the classifier receives the original text.
- **Settings:**
  - A store test (both backends, `contract.rs` if it touches the store) and a control test: a
    stored blob containing `ponytailMode` reads back without it, and a `PUT` carrying
    `ponytailMode` succeeds and ignores it.
  - The console settings test no longer offers a ponytail control.
  - `rustMirrors.test.ts` stays green.
- **Gates:** every check in `.github/workflows/ci.yml` (`rust` and `verify` jobs), including the
  new rustdoc step.

## Left to the builder

- Whether the RTK call and the report copy live inline in `dispatch_with_options` or in a small
  helper beside it.
- Whether a stored `ponytailMode` is stripped on the next write or merely never surfaced.
- Test file layout.

## Rollout

The change is additive for data, so no migration is needed. It keeps the standing rolling-update
policy, and old and new replicas can serve side by side:

- An old replica ignores `rtkEnabled`.
- A new one applies it.
- Both write the same columns.

`rtkEnabled` defaults to `false`, so nothing changes for an install that never turned it on. An
install that did turn it on starts compressing at deploy. The release notes should say so.
