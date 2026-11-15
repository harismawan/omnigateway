# A15 fix-5 — authoritative connect rebuild (awaiting independent review)

Evidence: `/tmp/opencode/a15/fix-5/`. A15 is not declared complete. Report remains uncommitted.

## Commits and implementation

- RED `2b9a5d75`: 377 rows, 12 failures, exactly 18 expected divergences (provider-list 12, unported-provider 6).
- Fix `38971476`: remove the credential upsert; connect awaits `rebuild_from` after successful save for fresh/reconnected credentials, preserving warning-and-success on publication failure.
- GREEN `6ffc2501`: empty evidence commit, no source changes.
- Final binary `rust-final`, built after fix commit; SHA-256 `3c0ab923901db5a17faebfd829aec9fec5f51e0103c07b3681f281b6c77d9c3c`. Full source commit recorded in `binary.commit`.

`rebuild_from` tracks a publication job on spawn_blocking and calls the existing `rebuild_read`: W, authoritative read, P, store, generation increment. SQLite locks the store and uses `read_snapshot`; Postgres uses runtime.block_on(snapshot_reads). Private `snapshot_from` factors conversion without changing warn/debug messages. Generation invalidates negative-key lookups.

Restored contiguous `patch_credential`, `patch_credential_at_publish`, and `refresh_credential` region is byte-identical to 7ad389ce: `refresh-identity.diff` is empty; `refresh-identity.txt` records the assertion. `base.diff` records all changes against that base. All base tests remain. Removed both `connect_upsert_*` tests, `connect_replacement_order_matches_store_rebuild`, `patch_credential_changed_label_keeps_old_position_unchanged_behavior`, and `refresh_absent_stays_absent_but_connect_publishes`. Added full-rebuild insertion/store-order, changed-to-equal older-rowid order (plain SQL expectation), deletion, exact generation increment, failed-read Arc identity/generation coverage. Adapted the existing both-orders gated test to invoke rebuild_from behind patch_credential and assert completion blocks while W is held; no lost administrative update.

## Driver evidence

T1 priority and roundRobin, T2 invalid UTF-8: both providers × finish/poll, twelve plain-equality rows. Existing four changed-label rows now explicitly assert each side's bearer against its database-selected credential. Every result includes status, answer, bearer and validity, checked independently before equality. Unique upstream model names avoid prior health/recent state: frozen first-request roundRobin has equal spent/load/idle, so stable sorting retains SQLite arrival order, the same first enabled provider credential as the SQL priority expectation.

RED `red-2`: 377 rows / 12 failed / 18 divergences. GREEN `green`: 377 / 0 / 18. Ten-trial `green-10`: 665 / 0 / 18. No frozen-contract contradiction observed. Initial `red` attempt failed during subsequent fixture setup because the hand-written invalid UTF-8 label remained present; driver restores that label after recording each result. Both failed attempts are retained.

`bearer-summary.txt` lists actual vs expected bearer per side/cell for RED and GREEN; raw routable JSON preserves wire/status/answer. Changed-label expects and receives `Bearer <provider>-new-access` on both sides. T1/T2 expect `Bearer <provider>-order-access-<route>-0`: frozen and GREEN Rust use that token; RED Rust uses the neighbour token. Both status and fixture answer are compared. Full evidence carries exact values without normalization.

Ten-trial first-request counts: **10/10 on TS and 10/10 on Rust in every cell**, for each of anthropic/openai × finish/poll × fresh-first/reconnect-first/changed-label/equal-priority/equal-roundRobin/invalid-utf8 (24 cells per side, 240/240 per side). `first-counts.txt` enumerates all 48 side/cell counts. No retries.

## Gates (exit codes read from corresponding .exit files)

- `red.exit=1`, `red-2.exit=1` (retained intentional/fixture failures).
- `snapshot.exit=0`, `snapshot-2.exit=0`; `build.exit=0`; `connect.exit=0`.
- `green.exit=0`, `green-10.exit=0`; `core.exit=0`.
- `race-1.exit` through `race-20.exit`: all **0** (entire snapshot suite, including remaining gated tests, each run).
- `workspace.exit=0` on first run, no flaky rerun needed.
- `clippy.exit=0`; `fmt-red.exit=0`, `fmt-red-2.exit=0`, `fmt-fix.exit=0`, `fmt-green.exit=0` (checks before commits).
- `dispatch-size.exit=0`: **5,496 bytes**, ceiling unchanged at 5,500.

`scan.json` records counts for `FAILED|panicked|^error`: red.log 1, red-2.log 12; every other gate log 0. Commands wrote their exit file on the same command line. Offline cargo, jobs=2, incremental/debug disabled, warm lent target; no release build. Disk remained 13 GiB free at finish.

Unverified: Postgres rebuild_from branch is compiled and unit-reachable through Store, but no live Postgres gateway exists yet and this task did not execute it against a live database. Admin-routes driver reserved for controller, not run here. Independent final review remains pending. No provider network traffic, push, merge, dependency changes, or inventory changes.

# A15 fix-4 — S1 changed-key connect replacement

Evidence: `/tmp/opencode/a15/fix-4/`. Awaiting independent re-review; A15 is not declared complete. This report remains uncommitted; reviewer files/evidence were untouched.

## Commits and binary

- `ef94b1c9`: RED plain-equality driver rows, 365 rows / 4 failed / 18 expected divergences against `/tmp/opencode/a15/fix-3/rust-final-2` (SHA-256 `7a19eef36b1bb99160c474f63a9c0903df99991d71c31458747edf51f3198a82`).
- `47ca0b1669bf3c46d4ab406cdae62b4e8e73c506`: implementation and snapshot tests.
- `3b1b09d2`: empty evidence commit recording GREEN gates.
- Final binary `/tmp/opencode/a15/fix-4/rust-final`, built after committing `47ca0b16`, SHA-256 `424db636d8c7d788697521f0e6be5b3bd558448a871580617da972b0b7f60b40`. Evidence commit changes no source.
- Frozen binary SHA-256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`; checked frozen `1780bb39` store ordering and reconnect metadata preservation. No oracle contradiction.

## Change and tests

Only changed-key UPSERT replacements remove/reinsert using the existing tier/byte-label insertion comparator, after equal keys. Equal-key replacements retain position. `insert_missing == false` short-circuits movement: existing entries replace in place, absent entries remain absent. Refresh callers and all pre-existing refresh tests are byte-for-byte unchanged. W-then-P, single authoritative read, publication store, removal/error paths are unchanged.

Non-test `git diff 753ba820 HEAD -- crates/omni-gateway-core/src/snapshot.rs` (complete production hunk; full diff also in `fix.diff`):

```diff
@@ -383,9 +383,18 @@ impl SnapshotHolder {
         let cur = self.current.load_full();
         let mut next = GatewaySnapshot::clone(&cur);
         if let Some(row) = &row {
-            if let Some(current) = next.routing.credentials.iter_mut().find(|c| c.id == id) {
-                *current = row.clone();
+            let current = next.routing.credentials.iter().position(|c| c.id == id);
+            let move_row = insert_missing
+                && current.is_some_and(|i| {
+                    let held = &next.routing.credentials[i];
+                    held.tier != row.tier || held.label.as_bytes() != row.label.as_bytes()
+                });
+            if let Some(i) = current.filter(|_| !move_row) {
+                next.routing.credentials[i] = row.clone();
             } else if insert_missing {
+                if let Some(i) = current {
+                    next.routing.credentials.remove(i);
+                }
                 // Match the store's ORDER BY tier, label; ties follow existing rows.
                 let position = next
                     .routing
```

Corrected the existing replacement assertion by sorting the expected list. Added five-case replacement table (later/earlier label, fractional tier crossing, unchanged equal-key neighbours, changed key equal to a neighbour), comparing published IDs with actual database rebuild IDs. Unchanged-key case additionally compares original IDs. Added `patch_credential_changed_label_keeps_old_position_unchanged_behavior`. Snapshot suite: 13 passed. Both existing connect/rebuild race and gated credential/health/rebuild race passed 20 runs each.

## Driver RED → GREEN

New plain-equality rows: both providers × finish/poll, unpinned pre-existing model/key, enabled equal-tier/weight `a`/`b`, 650 ms settle, admin PATCH `a` → `z`, immediate reconnect, immediate single inference, no retry. Rows compare status, answer content, and actual upstream bearer; raw response/wires retained per request. Exact divergence allowance remains 18 (provider-list 12, unported-provider 6).

| Run | Rows | Failed | Expected divergences | Changed-label equal |
|---|---:|---:|---:|---:|
| RED | 365 | 4 | 18 | 0/4 |
| GREEN | 365 | 0 | 18 | 4/4 |
| GREEN trials=10 | 545 | 0 | 18 | 40/40 |

All changed-label requests returned 200 / `fixture answer`. RED frozen selected `Bearer anthropic-new-access` / `Bearer openai-new-access` from the other (`b`, `*-missing`) credential; Rust selected `Bearer <provider>-order-access-<finish|poll>-0` from `z`. GREEN both select the other credential's `<provider>-new-access`, including all 40 repeated cases (10 per provider/route). The literal frozen token differs from reviewer's `old-access` because earlier full-driver success rows reconnect `*-missing`; selection semantics agree. `expectedBearer` in raw evidence records that credential's decrypted fixture token.

## Gates (quoted from `.exit` files)

All cargo commands used offline mode, jobs=2, incremental=0, dev/test debug=0, lent target directory; executed serially. Workspace timeout was 1,200,000 ms. No flaky gate failure or rerun.

```text
red.exit: bash conformance/e2e/connect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a15/fix-3/rust-final-2 /tmp/opencode/a15/fix-4/red => 1
snapshot.exit: cargo test --offline -p omni-gateway-core --lib snapshot => 0
build.exit: cargo build --offline -p omni-gateway => 0
green.exit: bash conformance/e2e/connect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a15/fix-4/rust-final /tmp/opencode/a15/fix-4/green => 0
trials.exit: A15_VISIBILITY_TRIALS=10 bash conformance/e2e/connect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a15/fix-4/rust-final /tmp/opencode/a15/fix-4/trials => 0
core.exit: cargo test --offline -p omni-gateway-core => 0
workspace.exit: cargo test --offline --workspace => 0
clippy.exit: cargo clippy --offline --workspace --all-targets -- -D warnings => 0
fmt.exit: cargo fmt --all -- --check => 0
dispatch.exit: cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture => 0
```

Each of `race-1.exit` through `race-20.exit` individually contains:
```text
cargo test --offline -p omni-gateway-core --lib snapshot::publication_tests::connect_upsert_serializes_with_rebuild_without_resurrection_or_duplicates => 0
```
Each of `gated-1.exit` through `gated-20.exit` individually contains:
```text
cargo test --offline -p omni-gateway-core --lib snapshot::publication_tests::gated_credential_update_bounds_health_and_queued_rebuild => 0
```

Scanned all 50 top-level gate logs for `FAILED|panicked|^error`: RED 4 matches; each of the other 49 logs 0. Dispatch measured **5,496 bytes**, ceiling **5,500** unchanged. RED evidence retained. Every Bun invocation used `--no-env-file` via the namespace wrapper.

Unverified: controller's isolated admin-routes wall-clock gates (intentionally not run), final independent review, broader storage-type/collation fuzzing. No push/merge performed.

---

# A15 fix-3 — R1 publication and R2 harness remediation

Evidence: `/tmp/opencode/a15/fix-3/`; reviewer evidence untouched. Awaiting independent re-review; no A15 completion claim.

## Commits and design

- `fd07b341`: RED driver and R2 ID validation. 361 rows / 8 failed / 18 expected divergences against fix-2 binary. Frozen first requests 8/8; Rust 0/8: fresh and immediate reconnect, both providers, finish and poll.
- `314219f3`: connect awaits upsert publication after every successful save. `publish_credential` shares the tracked blocking publication job and authoritative backend read with refresh. W is acquired before starting the fresh read, P before loading/cloning/storing the current snapshot. Existing refresh continues replace-or-remove only. Upsert inserts absent rows by numeric tier then byte-order label, after equal entries; present IDs replace in place. None removes; errors return before any snapshot store. Health/quota/models, generation and rebuild policy unchanged.
- `753ba820`: remove needless test fixture path borrow identified by clippy.

Three added snapshot tests cover insertion before/between/after three existing credentials, tier precedence and equal-key ordering; in-place replacement without duplication; removal; malformed metadata reads leaving the identical snapshot Arc untouched (including absent malformed rows); async refresh not inserting an absent ID while connect does; and both ordering directions of concurrent rebuild/upsert, with deletion and with an already-present row. Snapshot suite: 11 passed. No TSV tripwire required a new row.

## Driver results and R2 proof

Final full run `green-2`: 361 rows / 0 failed / 18 expected. Final opt-in `trials-2`: 505 / 0 / 18. Only divergence classes: provider-list 12, unported-provider 6. No visibility-lag class or inference retries. Models and keys preexist, models are unpinned, all other provider credentials disabled before the 650 ms wait. Reconnect's second exchange uses a different token and the first inference must show that token at the stub.

First-request successes in the final 10-trial run (each cell TS / Rust):

| Provider | Fresh finish | Fresh poll | Reconnect finish | Reconnect poll |
|---|---|---|---|---|
| Anthropic | 10/10 / 10/10 | 10/10 / 10/10 | 10/10 / 10/10 | 10/10 / 10/10 |
| OpenAI | 10/10 / 10/10 | 10/10 / 10/10 | 10/10 / 10/10 | 10/10 / 10/10 |

The ordinary final run passes 1/1 in every cell on each side. Red was frozen 1/1 and Rust 0/1 in every cell. Per-request evidence and FIRST lines are retained.

R2 validates string/v4 UUID syntax and queries that exact ID in that side's database, requiring exactly one row with the expected label before masking. A temporary local `r.body = { id: "broken" }` mutation fails `anthropic/shape/email/{}/finish` with `invalid saved credential id`; `shape-negative.log`, exit 1. Mutation restored; final drivers run afterward against the restored committed source.

## Binary and gates

Final binary: `/tmp/opencode/a15/fix-3/rust-final-2`, built after commit `753ba820cb9a5c4838407dfe1263d52e6f73ff25`.
SHA256: `7a19eef36b1bb99160c474f63a9c0903df99991d71c31458747edf51f3198a82` (identical to the preceding product commit binary).

Every command has a log and `.exit`; `summary.txt` records scan counts for `FAILED|panicked|^error`.
- Snapshot tests (`snapshot-2`), connect unit tests, build/build-2: exit 0, scan 0.
- Full workspace: exit 0, scan 0; no flaky-test rerun needed.
- Clippy initial: exit 101, scan 2 (needless fixture path borrow); retained. Corrected `clippy-2`: exit 0, scan 0.
- Format checks: exit 0, scan 0.
- Dispatch-size: exit 0, scan 0; **5,496 bytes**, ceiling unchanged at 5,500.
- Final full driver and 10-trial driver: exit 0, scan 0.
- Expected negative controls: RED exit 1 / scan 8; shape mutation exit 1 / scan 3 (source excerpt and error diagnostic count).

Workspace and size gates preceded the final test-only borrow cleanup; final clippy, format, rebuild and both driver runs followed it. Unverified here: other e2e drivers (controller-owned), PostgreSQL live connect publication, independent re-review. No frozen-code contradiction observed in the paired oracle runs.

---

# A15 fix-2 — I2, I3, M1 remediation for re-review

Evidence: `/tmp/opencode/a15/fix-2/`. No A15 completion claim. Product changes are committed; this handoff is uncommitted. Review evidence remained read-only.

## Commits and red/green

- `04002a60`: I2 driver RED, 233 rows / 20 failed / 20 expected. `d7164e69`: pass the snapshot holder through finish and poll workers; after successful reconnect storage, await refresh_credential; warn and retain success on publication failure. GREEN: 233 / 0 / 20.
- `b8d741da`: I3 matrix RED, 353 / 10 / 20. `67a396fb`: sanitize email binding failures to generic INTERNAL; validate non-string refresh secrets at the connect host boundary. GREEN: 353 / 0 / 20. Frozen `packages/control/src/oauth/pluginFlow.ts:316–318` validates returned flow secrets: the extra four Anthropic refresh-token failures are host validation, not a token_result change. Shared provider code and refresh.rs untouched.
- `f093608a`: M1 counted baseline RED, 353 rows / 349 failed / 0 expected, including three class-count failures. Adds route-missing guards and exact exception classes. `8f52d05b`: require successful first-request rows even if both implementations fail identically; retain isolated email debug logs and reject token/detail leakage. GREEN: 353 / 0 / 20. Procedural caveat: baseline guards and class assertions landed together in the RED driver commit; follow-up is a separate tightening commit, not a production route fix.
- `7ad389ce`: correct test-only snapshot construction to use a SQLite reader. Initial unit/workspace/clippy attempts failed compilation (Store versus SqliteStore); retained logs, then reran all gates successfully.

## Visibility

Opt-in loop: `A15_VISIBILITY_TRIALS=10`. Both providers, separately: frozen 10/10 reconnect first-request successes before and after; Rust 0/10 before, 10/10 after. Model is pinned before reconnect; disable followed by 650 ms publication wait; first inference has no retry and validates the new bearer token. Final opt-in run `final-driver`: 389 / 0 / 20, again 10/10 per provider per side. Final post-test-fix binary full run `final-driver-2`: 353 / 0 / 20.

Fresh connect is explicit `visibility-lag`, never equality and never requires Rust's first request to fail. Final opt-in observations (Anthropic/OpenAI): frozen first 200/200, routable 10/8 ms; Rust first 503/503, routable 311/209 ms. Raw first responses, attempts, timestamps and upstream headers are in each side's `*-routable.json`. These fresh observations include newly pinned model publication, as did the previous eventual-inference rows. Bound checked at 1,000 ms with 50 ms retry steps. New-credential publication remains the accepted 500 ms polling difference.

## Token shapes and logging

`token-shape-matrix.json` records all 52 cases with both HTTP bodies and credential email rows. All agree after the fix:

| Field / shapes | Anthropic | OpenAI |
|---|---|---|
| email `{}`, `[]`, `[1]`, finish AND poll | 500 INTERNAL `internal error`, zero credentials | 200; non-string ID-token email ignored, NULL email |
| expires_in `{}`, `[]`, `1`, `true`, null | 200 | 200 |
| refresh_token `{}`, `[]`, `1`, `true` | 502 UPSTREAM `anthropic oauth exchange returned something the host cannot use` | 200 |
| refresh_token null | 200 | 200 |
| access_token `{}`, `[]`, `1`, `true`, null | 401 AUTH `token endpoint returned no access_token` | same |
| id_token `{}`, `[]`, `1`, `true`, null | 200 | 200 |

Every shape has a consumed-flow row. No shared-code difference required stopping. Per-email isolated debug logs in `final-driver-2/{ts,rust}/*email*.log`: both emit only upstream HTTP metadata (status=200, provider, duration, host, path) for Anthropic failures; neither logs binding details, generic INTERNAL text, or token text. Timestamps/durations differ. Success-shape matrix checks status/body and email persistence, not full decrypted token/expiry persistence for each malformed shape.

## Exact divergence classes / negative control

Enforced counts: `provider-list=12`, `unported-provider=6`, `visibility-lag=2`, total 20. Error exceptions check status/code/message on both sides. Frozen kimi/kilo/muse = 502 UPSTREAM `<provider> oauth begin threw`; grok = 502 UPSTREAM `grok oauth start threw`. Antigravity/qoder = 200 with flow and authorize URL, absent error (hence absent error code/message). Rust all six = 400 BAD_REQUEST `provider must be one of anthropic, openai`. Baseline executable `/tmp/opencode/a15/rust-baseline` exists; driver now writes both full tables and counted red summary instead of validation crash (`m1-red`, exit 1).

## Final binary and gates

Binary `/tmp/opencode/a15/fix-2/rust-final-2`, built after commit `7ad389cedb6020aa55d9a4da3f32caa2e657cdf7`; SHA256 `3131d187c14aec77fd51bb3d78164df2ddf06f2b55eb56c52c8806adcb5c8b96`.

All logs have adjacent `.exit` files. Final exits: build-2 0; connect-unit-2 0; workspace-test-2 0; clippy-2 0; fmt-2 0; dispatch-size-2 0; final-driver-2 0. Dispatch state machine **5,496 bytes**, below unchanged 5,500 ceiling. No flaky-test rerun needed. Initial connect-unit/workspace/clippy exits 101 were compilation failures corrected by `7ad389ce`, not flaky failures. `scan.json` counts `FAILED|panicked|^error` across all top-level logs: all final logs 0; initial compile failures 3 each; intentional I2/I3/baseline red logs 20/10/349 respectively.

Not measured: optional poll-versus-finish held-request race and SIGTERM mid-exchange. Re-review remains required.

# A15 fix-1 — partial review remediation (I1 + I4)

Stopping at completed findings and clean product commits; I2, I3, M1 remain for the next implementer. A15 is not complete; re-review required. Evidence: `/tmp/opencode/a15/fix-1/`. Review evidence was read-only. Report remains uncommitted.

Commits:
- `bfd49fbc` I1 RED driver: 193 rows / 2 failed / 18 expected divergences (exit 1).
- `a89f9b27` I1 fix: pending deletion belongs to detached poll exchange, after completion/failed peek and before flight removal/result publication. Waiters only read. Added cancellation unit coverage alongside existing finish/shared-poll tests.
- `e8da8b96` I4 RED checkpoint (empty commit: existing inventory tests already reproduce): 3 passed / 2 failed, exit 101.
- `01826108` I4 fix: pinned OpenAI start reexport and string-only function boundary; 5 passed / 0 failed, exit 0. No additional public items introduced.

I1 driver adds disconnected poll cases for both providers (500 ms response delay, abort at 100 ms), observes token/credential counts, then finishes the consumed flow and observes counts again. RED failed exactly the two reused-flow rows. GREEN and final: **193 rows / 0 failed / 18 expected divergences**. Existing shared-poll behavior remains covered. Unit cancellation test gates exchange release until waiter abort, then requires pending key absence and exactly one saved credential. `i1-unit.log`, `i1-build.log`: exit 0.

Final binary: `/tmp/opencode/a15/fix-1/rust-final`, SHA256 `08b19dd8ecbf8c2a3c3ab3745be10baeacc88a707f8234f606a4432dcd246b0a`. Final checkout commit `01826108`; executable built at `a89f9b27` (subsequent changes only inventory TSVs). Per-binary SHA/commit files retained.

Final gates (each `.log` + `.exit` in evidence): connect-final 0; workspace-test 0; clippy 0; fmt 0; dispatch-size 0. Dispatch state machine **5496 bytes**, ceiling 5500 unchanged. No flaky reruns needed. `scan-summary.txt` counts `FAILED|panicked|^error`: final gates all zero; retained I1 RED 2 matches; I4 RED 6 matches.

Remaining/unverified: I2 reconnect snapshot publication and first-request driver, fresh-connect explicit counted visibility-lag class and observed delays; I3 malformed email/token-binding shape matrix, sanitization and log/secret checks; M1 strict divergence counts/status/code/message and counted baseline negative control. Deterministic poll/finish race and SIGTERM exchange persistence measurements not attempted. Other e2e drivers remain controller-owned. No new visibility-delay, race or shutdown conclusions claimed.

---

# A15 verify-3 — G2, G6, G3 differential verification

Evidence: `/tmp/opencode/a15/verify-3/`. Independent review still required; this does not declare A15 complete.

Commits (tests only; Rust unchanged):
- `9edaaf90`: G2 +28 rows; initial differential 171 rows / 0 failed / 18 expected divergences.
- `70a11f99`: G6 +12 rows; differential 183 / 0 / 18.
- `0e4a07f9`: G3 +4 rows; differential 187 / 0 / 18.
No product mismatch was found, so no fabricated red failure or Rust fix commit was made. Each group was run against the original cf3f9600 binary before committing.

## G2 reconnect

Identical SQL inserts on the stopped seed DB, then copies to each side. Frozen encryption helpers encrypt/decrypt both DBs. Old rows disabled, reason `fixture disabled`, disabled_at=1500, label `old label`, tier=3, weight=2.5, created_at=1000, updated_at=2000, token_version=7. Full and missing-token cases use separate rows. Padded valid ids succeed. Existing validation rows cover missing id, number, null, empty and whitespace; new rows cover object, other provider, apiKey, deleted-after-start and consumed second finish. All agree, including deleted finish `credential not found` then `unknown or expired authorization`.

Before/after table (each cell is independently observed on both sides; full decrypted rows and request time bounds in `final/{ts,rust}/{provider}-{full,missing}.raw.json`):

| Field | TS before → after | Rust before → after |
|---|---|---|
| enabled | 0 → 1 | 0 → 1 |
| disabled_reason / disabled_at | fixture disabled / 1500 → null / null | same |
| label / tier / weight | old label / 3 / 2.5 → unchanged | same |
| created_at | 1000 → 1000 | 1000 → 1000 |
| token_version | 7 → 8 (delta +1) | 7 → 8 (delta +1) |
| access_token | old-access → provider-new-access | same |
| refresh_token, full / missing | old-refresh → provider-new-refresh / null | same |
| id_token, Anthropic / OpenAI full / OpenAI missing | old-id → null / fixture JWT / null | same |
| account_email, full / missing | old@example.test → fixture@example.test / null | same |
| expires_at | 4102444800000 → exchange time + 3600000 | same |
| updated_at, Anthropic full / missing | 2000 → 1794738926516 / 1794738926520 | 2000 → 1794738934516 / 1794738934522 |
| updated_at, OpenAI full / missing | 2000 → 1794738926529 / 1794738926533 | 2000 → 1794738934536 / 1794738934541 |

Provider_data compared as exact bytes, without reconnect masks: old JSON has installationId, idSalt, accountId=old-account, old=true. Anthropic replaces it with `{}`. OpenAI replaces it with ordered keys accountId, installationId, idSalt; accountId becomes fixture-account (full) or null (missing); installationId and idSalt retain their exact old bytes; old=true is removed. Missing refresh/id tokens clear stored values on both sides.

## G6 concurrent HTTP polls

500ms token delay; both requests sent together. For TS and Rust, for each provider and each refusal/success case, exactly **one** token request. Both refusal responses assert 401 AUTH `token endpoint rejected the request: fixture_refusal`; both success responses assert 200 complete with the same validated UUID and exactly one persisted credential containing the expected decrypted access token. Third poll is consumed on both. Responses sorted before comparison.

First harness attempt incorrectly asserted 502 UPSTREAM for the refusal fixture; corrected to the frozen 401 AUTH response. Failed attempt retained (`g6-red.log/.exit`), then labelled rerun passed.

## G3 inference without restart

Fresh connect, identical admin PUT model pinned to returned credential and POST key, then chat completions through TLS recording stub. Both providers return `fixture answer`; exactly one upstream inference request with `Authorization: Bearer provider-inference-access` on each side. Bounded 50ms retry, 5s cap; successful measured delay includes model/key creation and request round trip:

| Provider | TS | Rust |
|---|---:|---:|
| Anthropic | 14ms | 109ms |
| OpenAI | 8ms | 467ms |

Raw inference wires, answers and delays: `final/{ts,rust}/{provider}-routable.json`. No snapshot/design edits. Harness failures retained: first missing model body id; second Anthropic stub returned JSON although gateway requests SSE, causing upstream failure then breaker opening (not a snapshot issue). Corrected stub to native SSE; labelled rerun2 passed.

## Masks, final gate, remaining scope

Existing validated flow/PKCE/state/content-length and success UUID/random Codex identity masks retained. Reconnect IDs and provider_data are unmasked; created_at explicitly must remain unchanged. Expiry/updated_at checked against request bounds ±2s before masking. Concurrent success ids masked only after UUID, equal-id, status and persisted-row relation checks. Inference row records asserted answer/auth/count rather than dynamic response IDs; full unmasked response/wire retained separately. Routability delay is evidence, not an equality mask.

Final driver: `final.log/.exit`, **187 rows / 0 failed / 18 explicit expected divergences**, exit 0. Rust unchanged, so conditional cargo gates/build were not run. Final copied binary `/tmp/opencode/a15/verify-3/rust-final`, source commit `cf3f9600a224a6e3ce321ad54212d46ffbe011c7`, SHA256 `910c6f05ec12c68d25ebb19f29be611338c8b97ad8c537f00c79f6f3bb9160b6`. Frozen binary SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.

Log scan `FAILED|panicked|^error`: g2-red=0; g6-red=1; g6-red-rerun=0; g3-red=1; g3-red-rerun=1; g3-red-rerun2=0; final=0. Counts saved in `scan-counts.json`; all attempts retain `.exit`.

Remaining unverified optional groups: HTTP callback-URL matrix; restart flow loss; 40,000-level nested JSON on all routes. G2/G6/G3 completed; no Rust edits. Report left uncommitted.

# A15 verify-2 — G4 and G5 fixed; partial handoff

Evidence: `/tmp/opencode/a15/verify-2/`. Independent review required; A15 is
not complete. Stopping at a completed group boundary for context budget.
Remaining ordered groups: **G2 reconnect, G6 concurrent HTTP polls, G3 inference
without restart**, then optional cases. Routable delay was not measured.

Commits (append-only):
- `ef416ad3`: G4 red driver, +24 rows; 137 total / 8 failed / 18 expected divergences.
- `0758d4f8`: G4 transport classification fix; 137 / 0 / 18.
- `0ca8b0d9`: G5 red driver, +6 rows; 143 total / 2 failed / 18 expected divergences.
- `cf3f9600`: G5 detached finish exchange and cancellation/persistence unit test;
  final full driver 143 / 0 / 18 (`g5-green`).

G4 frozen answers, both finish and poll, both no-response close and truncated
response body: HTTP **502**, code **UPSTREAM**, message exactly
`anthropic oauth exchange threw` or `openai oauth exchange threw`.
The subsequent request is HTTP 400 / BAD_REQUEST /
`unknown or expired authorization` on both sides. Rust previously returned
NETWORK / `token request failed`. The frozen exchange generators delegate to
postToken without catching transport errors; pluginFlow raises errors into the
generator and rethrow labels them with step `exchange`. Rust now uses that
classification for send/body errors and its 30-second timeout. Timeout was not
run. The partial-body fixture sends headers plus an incomplete JSON body then
closes with advertised length 1000; an explicit TCP RST remains unverified.

G5: 1000ms upstream delay; abort admin fetch at 200ms, inspect after another
2000ms. Before fix, both providers: TS one token request, one credential with
expected decrypted access token; Rust one request, zero credentials. Both
consumed the flow. After fix both persist one credential and reject second
finish as unknown/expired. Finish now spawns an owned exchange task, joining it
for connected callers; disconnect drops only the join waiter. Unit test gates
the transport with Notify, cancels waiter, releases response, and verifies
persisted label/token. Two compilation attempts used incorrect store API/field
names; retained logs, corrected rerun passes.

Masks: new transport rows validate verifier shape and SHA256 challenge relation,
state equality, and original Content-Length before replacing those values.
Start masks retain existing flow/state/challenge shape validation. Disconnect
summary has no random masks: exact request count, credential count and decrypted
token are compared. Existing rows and expected-divergence classification remain.

Final binary `/tmp/opencode/a15/verify-2/rust-final`, source `cf3f9600`:
SHA256 `910c6f05ec12c68d25ebb19f29be611338c8b97ad8c537f00c79f6f3bb9160b6`.
Built before committing identical source. Full driver, gateway tests, clippy
(gateway + providers all-targets, deny warnings), fmt check, dispatch size all
exit 0. Gate logs and `.exit` files are in the evidence directory; `scan.txt`
records counts for `FAILED|panicked|^error` (all final gates zero; red/failed
attempts retained). Dispatch size **5496 bytes**, ceiling unchanged at 5500.

Unverified: G2/G6/G3; restart/deep JSON/callback extras; opt-in timeout;
explicit TCP reset rather than truncated orderly close. No push or merge.
Report prepended and left uncommitted; older report retained below.

---

# A15 verify-1 — success path exercised; partial handoff

Stopped after completed group 1 for context budget. Independent review still
required; this is not an A15 completion claim. This report remains uncommitted.

Commit: `ac6d66ef` — successful OAuth finish/persistence differential rows.
No Rust difference exposed and no implementation fix made.

## Group 1 evidence

`/tmp/opencode/a15/verify-1/group1.log`: **113 rows, 0 failed, 18 expected
divergences**, exit 0. Added six rows: start, finish and decrypted persistence
for each of Anthropic/OpenAI; red count 0. Existing 107 rows retained.
Both finish responses contain valid v4 UUID IDs. Both stores persist matching
full rows (including token_version, disabled fields, tier, weight, enabled,
auth_type, account email, label and plaintext access/refresh/id/API-key fields).
The same frozen `packages/store/src/encryption.ts` deriveKey/decrypt functions
read both SQLite databases. No product TS changes.

Frozen-code clarification: OpenAI decodeClaims rejects an empty JWT signature
segment despite doing no signature verification. The unsigned fixture therefore
uses a nonempty `unsigned` marker, with alg=none; payload includes email,
chatgpt_account_id and organizations. Frozen currently reads email/account ID,
not organizations. Anthropic reads account.email_address.

Masks validate first: response/persisted credential ID is UUIDv4 and matches;
PKCE verifier is 43 URL-safe chars and hashes to the start challenge; state
matches the start; content-length equals actual original body bytes. Expiry is
within [request-start+3600000-2000, request-end+3600000+2000] milliseconds;
created/updated timestamps use the same 2000ms tolerance with zero offset.
OpenAI installationId is UUIDv4 and idSalt is 64 lowercase hex characters.
Provider-data masks replace only those validated substrings, preserving JSON
key ordering/spacing bytes. Raw decrypted values and request time bounds are
saved as `group1/{ts,rust}/{anthropic,openai}-success.raw.json`; comparison rows
and token wires are in `group1/{ts,rust}.rows.json`.

## Build and gates

All Rust sources touched before the offline build. Binary copied outside the
checkout: `/tmp/opencode/a15/verify-1/rust`, source `4fa5f1e6`, SHA256
`42858cc52ee950b9f48443b65ec6279e77263da57574a9753cdb2708766b5e5f`.
The first copy used the package name instead of the binary name and failed;
`binary.txt` retains that attempt's commit-only output. Corrected copy/hash in
`binary-rerun.txt`; cargo build itself passed. Driver commit changes no Rust.

Evidence directory `/tmp/opencode/a15/verify-1/`: build, full current driver,
gateway package tests, clippy gateway/providers all-targets -D warnings, fmt
check, and dispatch_size each have `.log` and `.exit`, all exit 0.
Dispatch state machine **5496 bytes**, ceiling 5500 unchanged.
`log-scan.txt` records counts for `FAILED|panicked|^error`: all 12 logs/err
files have zero matches. Gateway tests used a 1,200,000ms command timeout.

## Remaining work (groups 2–7 not started)

Reconnect before/after and invalid/deleted reconnects; new-credential inference
and bounded routability delays (neither side measured); transport close/reset/
timeout oracle (no new evidence, current mapping still unverified); client
disconnect persistence (unverified, no spawn change); HTTP concurrent polls;
optional interleaving/restart/deep-body/callback URL rows. No snapshot design
change. Controller still owns workspace-wide gates and other e2e drivers.

---

# A15 routes implemented — controller follow-up

Review still required; not declaring A15 complete.

Commits: `b1bc9e3b` pending/start/router; `98ea9cab` finish/exchange/persistence;
`c99e89bf` poll sharing/consumption and tests; `4fa5f1e6` unported-provider rows.
Implementation is in new gateway `connect.rs`; shared-file plumbing is minimal.
Existing refresh conversion helpers are now crate-visible. Added only existing
workspace crate omni-coord: lockfile gains one dependency edge, no packages;
`cargo metadata --offline --locked` exit 0.

## Evidence: /tmp/opencode/a15/routes-1/

| Attempt | Rows | Failed | Expected divergences | Exit |
|---|---:|---:|---:|---:|
| step1 | 103 | 14 | 14 | 1 |
| step2 | 103 | 2 | 14 | 1 |
| step3 | 103 | 2 | 14 | 1 |
| step3-rerun | 103 | 0 | 14 | 0 |
| final | 103 | 0 | 14 | 0 |
| refusals | harness error | — | — | 1 |
| refusals-rerun | 107 | 2 | 16 | 1 |
| refusals-final | 107 | 0 | 18 | 0 |

Step3's two failures were inherited poll-wire randomness left unmasked, not
response differences. Added validation of empty code, 43-character verifier,
S256 relationship, state equality and actual content-length before masking.
State masks for the implemented providers now require exactly 43 characters.
Unported start successes are explicit divergence rows with raw responses kept;
they are not masked with implemented-provider assumptions (Qoder differs).

Short gates: package gateway tests exit 0 (initial and final rerun); targeted
connect tests exit 0; clippy initial exit 101 (two lints), rerun exit 0;
fmt check exit 0; dispatch_size exit 0, **5496 bytes**, ceiling unchanged.
All builds exit 0. Logs and corresponding `.exit` files retained. Log scan
`FAILED|panicked|^error`: step1=14, step2=2, step3=2, clippy=4,
refusals=1, refusals-rerun=2; every other scanned log/err=0 (25 total).
Full per-file counts in `log-scan.txt`. Long gates intentionally deferred.

## Mapping and observed differences

- All three POST routes reuse require_admin then bounded read_json. GET keeps
  existing fallthrough; all three GET rows pass. Provider/type/reconnect checks
  precede start. Pending JSON uses lossless JsValue label and exact field order,
  coord key prefix and 600000ms TTL. Memory coordinator loses state on restart.
- Finish type-checks then takes before callback normalization. OpenAI validates
  origin/path, first code/state query values and state; Anthropic passes input.
  Existing exchange_request/token_result handle HTTP 400/401/429/500, malformed
  successful JSON and missing access token. These token rows are all green.
  Backend::save_oauth is the only persistence path; data_version is the intended
  snapshot path. No additional publication path added.
- Poll peeks then exchanges empty code. Frozen and Rust both return 401 AUTH
  `token endpoint rejected the request: fixture_refusal`, then unknown/expired
  on the next poll. Both wires show empty code and valid PKCE. A counting fake
  HTTP unit test proves concurrent Rust polls share one exchange and both see
  its error; consumption follows. Work is spawned independently of requests.
- Frozen refusal text: `provider must be one of anthropic, openai, kimi, kilo,
  grok, antigravity, muse, qoder`; Rust: `provider must be one of anthropic,
  openai`. Driver asserts both. In isolated networking frozen kimi/kilo/muse
  give 502 `UPSTREAM` with `<provider> oauth begin threw`, grok gives
  `grok oauth start threw`; Rust gives the same supported-only 400 refusal.
  Antigravity/Qoder start successfully in frozen and are explicitly refused here.
- Controller design otherwise followed. Generated catalog is reachable as
  omni_control::catalog::DATA; a unit test pins the table callback against it.
  Unit tests also cover callback parsing (including abc:def), TTL/take/peek and
  lone-surrogate pending JSON. No pending 202 outcome is produced or represented
  yet: device providers need that extension.

## Binary provenance and limits

Final binary `/tmp/opencode/a15/routes-1/final-rust`, built from `c99e89bf`:
SHA256 `42858cc52ee950b9f48443b65ec6279e77263da57574a9753cdb2708766b5e5f`.
Later commit changes only driver. Debug size 41815536 -> 42772560 bytes
(+957024). TS commit `1780bb39`, SHA256
`f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.
Intermediate binary hashes in hashes.txt: step1 source b1bc9e3b, step2
98ea9cab, step3 pre-final-clippy version of c99e89bf (not exact committed tree).

Unverified: successful token fixture/decrypted persisted rows, valid reconnect,
inference and snapshot delay on either side, transport failure oracle (current
texts copied from refresh), restart end-to-end, expiry end-to-end, deep body
rows, TS concurrent poll count, disconnect cancellation test. Persistence label
currently uses from_utf16_lossy at the Store API boundary; lone-surrogate label
persistence parity is not established. No success snapshot claim is made.
Provider table currently holds id/callback; start/exchange/token dispatch still
branches on OpenAI versus Anthropic, so adding Antigravity needs function entries
or explicit dispatch, plus multi-request exchange sequencing for userinfo and
loadCodeAssist/onboardUser. Current exchange executor handles only one request.

---

# A15 continuation — OpenAI start primitive only

Stopped at a clean partial commit; A15 is not complete. The route implementation
and all remaining steps still need an implementer. Predecessor content follows
unchanged below.

## New commit and mapping

- `ca3ccdde`: `feat(oauth): add OpenAI authorization start` (parent `a3057a1a`).
- New `crates/omni-providers/src/openai/oauth_start.rs`, exported through
  `openai::oauth::start`, ports frozen `openaiOAuthFlow.start`: identical query
  order, public client id, scopes, callback argument, PKCE/state arguments,
  organization/simplified-flow flags, originator and prompt.
- Originator reads the same captured profile/environment as existing HTTP
  requests, via a small shared accessor. No dependency additions.
- `/api/connect/start`, `/finish`, `/poll` remain missing. Thus no route or
  error mapping has changed, no pending coordinator is wired, and no credentials
  are persisted or snapshots published by connect.

## Fresh evidence

Evidence directory: `/tmp/opencode/a15/start-helper-1/`. Builds used jobs=2,
incremental=0, dev/test debug=0, offline and the prescribed shared target.

| Check | Exit | Result |
|---|---:|---|
| targeted provider start test | 0 | 1 passed; query/callback/PKCE binding |
| gateway debug build | 0 | binary copied outside checkout |
| connect differential, new attempt | 1 | 103 rows, 100 failed, 0 encoded expected divergences |
| cargo fmt --all -- --check | 0 | passed |

Each has `.log` and `.exit` in that directory. `log-scan.txt` lists every
`.log`/`.err` below `/tmp/opencode/a15`: regex `FAILED|panicked|^error` counts
are 100 each in `red-2.log`, `red-3.log`, `start-helper-1/connect.log`; every
other scanned log is zero (300 total). Prior red evidence is untouched.

Binary provenance:
- Frozen TS `/tmp/opencode/a8/ts`, controller commit `1780bb39`, SHA256
  `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.
- Rust `/tmp/opencode/a15/start-helper-1/rust`, source now committed as
  `ca3ccdde` (built immediately before committing), SHA256
  `f80efb976391851b43ceb6db1dfff08eefa1ec59300614dea391bef8bb17bb01`.

## Remaining verification / exact continuation

No driver edits or masks changed. The inherited broad state mask remains;
frozen `packages/control/src/oauth/pkce.ts` confirms 32 random bytes rendered
base64url (43 characters). No new successful-persistence or reconnect evidence.
The new differential repeats the inherited TS empty-code poll failure and
consumption observations; Rust still has no poll route, so concurrent sharing
is unimplemented and unverified.

Required documented refusal difference remains to implement and encode:
frozen `provider must be one of anthropic, openai, kimi, kilo, grok, antigravity, muse, qoder`
versus intended Rust `provider must be one of anthropic, openai`. Expected
divergences are not yet classified in the driver.

Still not run: workspace tests, workspace clippy, dispatch_size (number not
remeasured), openai-ns, run.ts, admin-routes. No A15 completion claim.
Continue at task step 1 using the new OpenAI primitive plus existing Anthropic
start. Implement coordinator pending storage/control module and gateway routes,
then steps 2–5 and all settled gates. No flow abstraction was introduced here;
Antigravity still needs PKCE kind plus a multi-request exchange host capable of
userinfo and loadCodeAssist/onboardUser after token exchange. A single-request
token executor alone would not suffice.

---

# A15 partial handoff — red driver only

A15 is not complete. No Rust implementation changes. Session stopped at the
permitted committed boundary; independent implementation/review still required.

## Commits

- Base: `665ca7e5cf95e884a3bc8541a0e3792f9e24b026`
- `a3057a1a5d730713965cc734cb4b1b4fc67d7c11`: initial red differential driver and namespace wrapper.
- This report intentionally uncommitted.

## Evidence / gates

All evidence under `/tmp/opencode/a15/`. Before building, touched every
`crates/**/*.rs` mtime. Offline debug build used the prescribed shared target,
jobs=3, incremental=0, dev/test debug=0. Disk check showed 24 GiB available.

| Command / attempt | Exit | Outcome |
|---|---:|---|
| cargo build --offline -p omni-gateway | 0 | build.log / build.exit |
| connect-ns.sh red-1 | 1 | harness error: CLI uses omnigateway.db, not omni.db; fixed |
| connect-ns.sh red-2 | 1 | 103 rows, 100 failed |
| connect-ns.sh red-3 | 1 | 103 rows, 100 failed; reset fixture status before each provider poll |

Run: `bash conformance/e2e/connect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a15/rust-baseline /tmp/opencode/a15/NEW-RUN`.
Each attempt retained its `.log` and `.exit`. Per-side JSON rows are in
`red-3/{ts,rust}.rows.json`; all gateway children have explicit environments,
isolated roots/databases and the same encryption key. CLI Bun child and namespace
Bun invocation use `--no-env-file`. Network namespace has only loopback; TLS stub
records ordered headers, request line and body at hardcoded provider hosts.

Not run: workspace tests, clippy, fmt check, dispatch_size, existing run.ts,
admin-routes.ts, openai-ns.sh. These remain mandatory after implementation.

## Binary provenance

- Frozen TS: `/tmp/opencode/a8/ts`, commit `1780bb39` (controller provenance),
  SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.
- Rust: `/tmp/opencode/a15/rust-baseline`, built from `665ca7e5` with only
  uncommitted conformance files present, SHA256
  `3aeca9c3e4ffd4fefe5bac0a66f2a3370a5489417360d10501a3ad4db15b39da`.

## Mapping / observations

Rust currently returns its missing-route response for connect POSTs. The three
GET rows agree. Exact observed status/content-type/body are preserved per row.

- start: TS validates admin first, then JSON record, provider, reconnect id;
  returns flowId/authorizeUrl/userCode/kind/supportsManualPaste/pollIntervalMs.
  Label absent/non-string/trimmed and invalid reconnect ids covered.
- finish: missing/non-string fields -> `flowId and code are required`;
  unknown/empty/consumed flow -> `unknown or expired authorization`.
  Token HTTP 400/401/429/500, malformed successful JSON and missing access token
  covered for both providers, with wire PKCE relationship checked.
- poll: missing/non-string id -> `flowId is required`; unknown ->
  `unknown or expired authorization`. **Both non-device providers exchange an
  empty code**, then consume the flow on failure; they do not refuse the kind.
  Fixture 400 yields 401 AUTH `token endpoint rejected the request: fixture_refusal`.
- all routes: missing session, bad cookie, invalid JSON, scalar/non-object JSON,
  missing body and wrong method included.

Frozen refusal list is `anthropic, openai, kimi, kilo, grok, antigravity, muse,
qoder`. Unknown, plugin-fixture, custom, qwen, xai, constructor, null and numeric
provider return 400 BAD_REQUEST `provider must be one of <that list>`.
Frozen kimi/kilo attempt device begin and return 502 UPSTREAM in this isolated
namespace (`kimi oauth begin threw` / `kilo oauth begin threw`). Rust currently
has no connect routes; eventual supported-only refusal list should derive from
its OAuth table (anthropic/openai), after registry existence validation. No
plugin is loaded in this fixture; registered plugin behavior remains untested.
Documented build-scope differences are **not yet encoded as driver expectations**.

## Masks / limits

- flowId checked as 43 base64url characters before masking.
- authorize challenge checked as 43 base64url, method S256; state checked as
  20–128 base64url before masking. Tighten state length to provider-specific
  frozen format in next pass.
- exchange verifier checked 43–128 base64url; SHA256(base64url) must equal the
  authorize challenge before masking. Any exchange state must equal authorize
  state before masking. Content-length checked against original body bytes
  before replacing with a validated marker.
- Request header order retained; response comparison currently only status,
  content-type and JSON/body. Other response headers remain to be added.
- Bodies are parsed for comparison; no persisted credential rows yet inspected.
- No random ids/timestamps from success persistence are masked yet.

## Precise continuation

1. Extend driver with successful token fixtures, decrypted row comparison,
   valid/wrong-provider/non-OAuth reconnect fixtures, raw code/full callback URL,
   wrong-state/callback errors, interleaved flows, restart/expiry, deep JSON and
   inference after snapshot publication. Existing lifecycle tests can supply
   identity expectations. The current missing-route branch deliberately omits
   dependent finish rows on Rust; those are reported red as missing rows.
2. Implement OpenAI start from frozen provider code; new control connect/pending
   module using coord KV JSON/TTL/key contract and `Store::save_oauth`; callback
   parser and TTL/take/peek unit tests. Add pooled HTTP execution and snapshot
   publication via a new gateway module, minimal router/server wiring.
3. Preserve frozen poll behavior above; no device machinery for unported
   providers. Cluster Redis wiring remains excluded. No coordinator wired by
   this change yet. Keep forbidden parallel-track files untouched.
4. Run every requested gate and record response mapping once implementation
   exists. dispatch future/ceiling untouched so far, but size unverified.

## Log scan

Exact `FAILED|panicked|^error` match counts across every `.log` and `.err`:
`red-2.log=100`, `red-3.log=100`; `build.log`, `red-1.log`, both seed logs/errors
in red-1, and all six seed/TS/Rust logs/errors in each of red-2 and red-3 = 0.
Total 200. The red-1 SQLiteError does not match that regex; it is explicitly
recorded above rather than hidden. No test panic observed.
