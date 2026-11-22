# A15 third independent review — REQUEST CHANGES

Reviewed `7ad389ce..753ba820`. Evidence `/tmp/opencode/a15-review3/`. No product edits, commits or subagents; previous reports/evidence untouched. Binary `/tmp/opencode/a15/fix-3/rust-final-2`, SHA256 `7a19eef36b1bb99160c474f63a9c0903df99991d71c31458747edf51f3198a82`. All gateway/CLI probes ran with explicit environments, private HOME, Bun `--no-env-file`, and loopback-only namespaces. Revised publication ruling accepted.

## Earlier findings

- **R1 missing snapshot entry: closed for the reported missing-entry defect.** New publication inserts absent credentials, and the HTTP first-request trial results below exercise fresh/immediate reconnect through finish and poll. New ordering defect below prevents overall approval.
- **R2 unvalidated ID mask: closed.** Driver checks string, UUIDv4 syntax, exactly one row by id, and expected label before masking. A wrong-but-valid UUID belonging to another existing credential is rejected by the label check. Independent mutation `mutant-valid.ts` seeds such an ID, substitutes it into the first successful shape result, and fails `invalid saved credential id` (`mutant-valid.exit=1`). Initial `mutant/` failed before the assertion because there was no other UUID fixture; retained, not counted as validation evidence. Committed scripts unchanged.
- Additional malformed-ID mutation `mutant-broken.exit=1` fails at the intended UUID/saved-row assertion too.

## Important — S1: Upsert replacement preserves stale position and changes account selection

Rust `crates/omni-gateway-core/src/snapshot.rs:384–403` replaces an existing row in place, even if its authoritative tier/label differ from the held row. The new upsert therefore does not uphold `omni-router/src/snapshot.rs:19` (credentials ordered by tier then label). Its new test explicitly changes label/tier and asserts the old position, pinning this mismatch rather than detecting it. Preserve existing refresh semantics, but make the connect upsert restore the store order when the sort key changes.

Frozen references: `packages/store/src/sqlite/credentials.ts:191–193` credentials list `ORDER BY tier, label`; `packages/control/src/connect.ts:247–258` reconnect saves metadata and emits changes; `apps/gateway/src/dispatch/snapshotCache.ts:39–87` rebuilds on subsequent routing read. `packages/router/src/index.ts:33–56,81–111` ranks candidates in their arrival order with stable ties. Rust `omni-router/src/filters.rs:240` enumerates credential order; `rank.rs:66–94,119–151` preserves order for ties and uses arrival order for weighted selection.

**Paired reproduction**, both providers, `order.ts` / `order/`:

1. Pre-existing priority model targets provider without a credential pin. Enable two existing OAuth credentials with equal tier/weight: `*-full` label `a`, `*-missing` label `b`; wait 650 ms so model/key/credentials are visible.
2. Separate SQLite writer changes `*-full` label to `z` (simulates CLI/admin metadata change).
3. POST `/api/connect/start` `{"provider":"anthropic","label":"inference","credentialId":"anthropic-full"}`; POST `/api/connect/finish` `{"flowId":F,"code":"code#S"}`. Token reply 200 `{"access_token":"anthropic-inference-access-0","refresh_token":"inference-refresh","expires_in":3600}`. Reconnect preserves label `z`.
4. Immediately POST `/v1/chat/completions` with fixture bearer key and `{"model":"inference-anthropic-false","messages":[{"role":"user","content":"hello"}],"max_tokens":32,"stream":false}`. Both HTTP 200 and `fixture answer`, but frozen upstream uses **Bearer old-access** (the `b` credential); Rust uses **Bearer anthropic-inference-access-0** (the `z` credential). Same OpenAI reproduction and wire difference.

Evidence: `order/{ts,rust}/*-routable.json` records exact inference requests/headers; private DBs show authoritative metadata. `order.log` has 2 result differences out of 4 rows; its PASS/FAIL marker means expected new-token selection, not that frozen is incorrect. This is an actual selection mismatch, not merely internal array ordering. It occurs after connect has reread and published the changed row; accepting other admin writes' polling lag does not authorize a connect publication inconsistent with its freshly read row/store order.

Confirmed with normal admin API too: `order-admin.ts` replaces step 2 with authenticated `PATCH /api/credentials/<provider>-full` body `{"label":"z"}`; both providers reproduce the same selected-token difference (`order-admin/`). `order-db.json` confirms both DBs list `b` before `z`. This second reproduction is excluded from primary pair totals as a repeated confirmation.

Five-trial/provider admin-PATCH repetition with unique models (`order-repeat/`): **10/10 first-request selection mismatches**, 20 rows/10 equal/10 different; excluded from primary counts as repeat confirmation.

A rebuild restores list ordering nominally within the 500 ms poll interval, but selection can remain different after the first request changes per-credential health. `order-later/` repeats the inference after 600 ms and still selects the same respective tokens. This follow-up does **not** prove the array stayed unsorted; health/score feedback can preserve an observable effect. No absolute recovery bound claimed.

## Snapshot concurrency analysis (a–g)

### a. Existing refresh behavior

Non-test diff preserves refresh's replace-or-remove algorithm: `refresh_credential` calls shared `read_and_publish_credential(...,false)`, which invokes `patch_credential`, delegating to `publish_credential_at_read(...,false)`. Same W → authoritative read → P → load current → clone → replace/remove → store. Same SQLite transaction, backend mutex, PG runtime.block_on, job lifetime and join-error conversion. Only `publish_credential(...,true)` enables insertion. No token-refresh call sites changed. Existing snapshot tests were independently run, including cancelled waiter/refresh, delayed positive read, authoritative ordering and health publication tests.

### b. Delete / rebuild interleavings

W spans authoritative read and publication; rebuild also obtains W before reading. Thus a rebuild cannot read post-delete state and then queue behind an upsert that already owns W: it must first obtain W. If rebuild goes first, upsert subsequently rereads and sees deletion. If upsert reads first and an external DB writer deletes meanwhile, upsert can temporarily publish its earlier read before the following rebuild removes it. **There is no lock spanning arbitrary external commits and snapshot store.** This is the existing authoritative-read linearization contract, not permanent resurrection after a newer rebuild.

New test `connect_upsert_serializes_with_rebuild_without_resurrection_or_duplicates` really gates a first thread after its read while holding W, performs a delete on another connection, verifies W unavailable, starts the second operation, then releases the first. It covers both operation orders and delete/no-delete. It asserts the final snapshot after both finish, not the intermediate snapshot after first publication. The second thread has no explicit entered/blocked handshake, but regardless of when scheduled its read is ordered by W. It does not force a post-read external delete with **no subsequent publication**, nor claim immediate cross-process revocation. Twenty independent repetitions passed.

### c. Duplicate entries

W serializes upserts/rebuild reads; P serializes every derived-current publication. Upsert looks for id in the **current** snapshot under P, not a pre-read clone. Rebuild cannot insert between this upsert's read/publish because it needs W. Two upserts of the same id serialize: second replaces the entry first inserted. Different IDs from held poll/finish exchange create different credentials, faithfully matching frozen. New tests cover rebuild/upsert both orders; two same-id upserts were reasoned about, not separately gated by reviewer.

### d. Store order and selection

Missing-row insertion compares numeric f64 tier then UTF-8 bytes of label, matching SQLite numeric ordering and default BINARY TEXT collation for representable metadata. Negative/fractional tiers compare numerically; +0/-0 equal. NaN bound by SQLite becomes NULL and fails the required numeric metadata read rather than reaching this comparator. Infinity compares normally. TEXT/BLOB tier fails strict row conversion and is omitted on rebuild. Small independent SQLite comparator experiment (`sqlite-order.json`) agrees on negative/fractional/infinite tiers, embedded NUL, BMP/astral labels and equal insertion keys. No comprehensive storage-type/collation fuzzing was run.

For newly inserted default-rowid credentials, placing after existing equal keys agrees with later insertion order in current table scans. It is not a general guarantee for an **older absent row** whose equal-key peers already exist (nor an explicit SQL secondary ORDER BY rowid). No stored rowid is available in Credential to establish that tie universally. Existing-row reconnect retains position, which is correct only when its ordering keys remain unchanged; S1 demonstrates the changed-key case. Priority/score stable ties, round-robin ties and weighted arrival order all make list order observable.

### e. Omitted/disabled/unported rows

Rebuild uses isolated credential-list conversion: unreadable metadata omitted. Upsert single-row get returns error; code keeps the exact old Arc, confirmed by test. Missing malformed row is not inserted. An existing row newly made malformed can remain stale on publication error until rebuild; this is inherited refresh behavior and connect warns/returns success, not an unconditional failure guarantee. Disabled rows are in the store snapshot and are filtered at eligibility; unsupported-provider rows are likewise stored but targets without adapters are excluded. Upsert does not invent an adapter or bypass enabled checks.

### f. Other snapshot data / generation

Upsert clones current snapshot and changes only credentials. Health/quota/models/settings/keys/built_at remain intact. New ordinary connect has no prior health/quota; missing health yields normal defaults and no quota yields OAuth UNKNOWN_QUOTA=0.5 (no exhausted-window exclusion). Existing credential health/quota is retained. Wholesale rebuild alone bumps generation. `spawn_preseeder` (`omni-gateway/src/lib.rs:104–`) seeds **API-key** rate limits, not credentials; credential insertion requires no new key seed. Miss/negative cache concerns API keys, so leaving generation unchanged does not invalidate a needed credential lookup. Postgres branch unchanged, no live PG probe.

### g. Cancellation / shutdown

Both new/reconnect saves await publish inside detached finish/poll workers. The shared helper creates `publication_job` before spawn_blocking; its guard lives inside the blocking task and shutdown's drain tracks it even if a waiter is gone. Regression probes below confirm client disconnect and connected SIGTERM behavior. W or blocking-pool saturation can delay acknowledgment without a helper timeout, same as refresh today; shutdown still applies its overall deadline. Deliberately saturated pool/W plus disconnected connect was not separately forced.

## Driver review

Eight first-result cells are explicit status=200/valid=true checks on both sides, no retries. valid checks answer content, exactly one upstream request and exact expected bearer, including a distinct `-second` token for immediate reconnect. Pre-existing model/key and 650 ms setup wait separate accepted admin lag from connect. `visibility-lag` removed; exact counts are provider-list 12 + unported-provider 6 =18. Wrong UUID/type/missing row/wrong label all rejected before shape masks. No identical-two-failures loophole in first-result comparison. Tests still do not cover S1's changed ordering keys.

## Inherited behaviors

Poll exchanges empty code; held poll plus finish can redeem twice and create two separate credentials; concurrent polls share one exchange; malformed Anthropic refresh-token host errors differ from OpenAI's normalization; generic malformed-email error mapping preserved. Other admin configuration writes retain the documented polling lag. Fresh connect itself no longer has that exception.

## First-request trial results

`trials.ts` is a scratch copy of the current driver with 20 trials, unrelated setup rows omitted and expected class counts zero. `ordinary.ts` reuses the prior disabled-row reconnect probe. The model/key exist before connect; no first-inference retry. Each successful result verifies answer and bearer.

| Provider | Operation | Route | TS | Rust |
|---|---|---|---:|---:|
| anthropic | fresh | finish |20/20|20/20|
| anthropic | fresh | poll |20/20|20/20|
| anthropic | immediate reconnect of fresh | finish |20/20|20/20|
| anthropic | immediate reconnect of fresh | poll |20/20|20/20|
| openai | fresh | finish |20/20|20/20|
| openai | fresh | poll |20/20|20/20|
| openai | immediate reconnect of fresh | finish |20/20|20/20|
| openai | immediate reconnect of fresh | poll |20/20|20/20|
| anthropic | disabled existing reconnect | finish |20/20|20/20|
| openai | disabled existing reconnect | finish |20/20|20/20|
| anthropic | disabled existing reconnect | poll |20/20|20/20|
| openai | disabled existing reconnect | poll |20/20|20/20|

Evidence `trials/{ts,rust}/*-routable.json`, `ordinary-clean/{ts,rust}/*-routable.json`. All 320 trials start/result pairs and all 80 ordinary start/result pairs compare equal. Initial `ordinary.log` retains a stale scratch visibility-lag count assertion (expected 40, got 0), producing exit 1 despite zero response differences; corrected scratch count and reran all 20 trials/provider: `ordinary-clean.exit=0`, 80 equal. Both attempts retained.

## Regression sweep and counts

| Run | Pairs | Equal | Different |
|---|---:|---:|---:|
| current committed driver copy |361|343|18 expected|
| 20-trial fresh/immediate reconnect |320|320|0|
| ordinary disabled reconnect |80|80|0|
| ordinary disabled reconnect via poll |80|80|0|
| original missing-entry reproduction rerun |80|80|0|
| FlowResult matrix |196|196|0|
| I1 lifecycle success/refusal/close/timeout |10|10|0|
| delayed close after waiter disconnect |2|2|0|
| held poll/finish race |2|2|0|
| SIGTERM |4|4|0|
| changed-label selection |4|2|2 unexpected|
| **Total** |**1139**|**1119**|**20: 18 expected + 2 unexpected**|

Matrix covers both providers × finish/poll × 7 token fields × 7 JS/JSON types, same results as round two. I1 failures leave zero credentials and consume; success leaves one and consumes. Held race waits for second token request before releasing first: two requests/two credentials on both. SIGTERM at 200 ms into 1 s exchange: each process exits 0 and persists one; durations (TS/Rust ms): anthropic finish 839/835, anthropic poll 861/835, openai finish 854/822, openai poll 855/926. Matrix/lifecycle/close/race/SIGTERM `.exit` files are all 0. Selection follow-up/mutation experiments excluded from pair totals.

Original `missing.ts` copied and rerun with only obsolete class-count expectations zeroed: `missing-clean.exit=0`, 80/80 equal, 20/20 first-success per provider per side. This directly reruns the prior finding independently of the implementer's new trial design.

Disabled-row poll variant `ordinary-poll.exit=0`, 80 equal; also 20/20 first-success per provider per side. Across fresh, immediate reconnect and disabled-row reconnect, all twelve provider/route/operation cells now have twenty independent trials per binary.

Row-name diff `row-names.json`: eight previous first/start names removed, replaced by sixteen route-specific fresh/reconnect names; all other 345 old row names retained. Current driver **361/0 failures/18 expected**, no visibility-lag class. Negative wrong-valid-ID probe exits 1 at the intended assertion; no product binary mutation.

## Reviewer-run gates

Touched all worktree Rust sources first as instructed. Offline, shared warm target, two jobs, incremental off, dev/test debug=0; one cargo command at a time, no release build. Exit files written immediately after each command.

- `core.exit=0`: **78 passed, 0 failed, 1 ignored**, including all pre-existing snapshot concurrency/cancellation tests and new upsert tests.
- `race-1.exit` through `race-20.exit`: **all 0**, new gated race test passed each run (four internal delete/order combinations per run).
- Implementer logs independently scanned in `implementer-gates.json`: workspace 1274 passed/0 failed/19 ignored, exit 0; clippy-2/fmt-2/dispatch-size exit 0; no failure/panic/error lines; dispatch 5496 bytes, ceiling unchanged.
- First reviewer workspace run **exit 101**, 94 summaries, **688 passed / 1 failed / 7 ignored** before stopping. Failure: unchanged `omni-providers::http::drain_tests::admitted_drain_replaces_oldest_idle`, `drain_tests.rs:36`, `socket closed: Elapsed(())` in a paused-time test. `workspace.log`, `workspace.exit`, `workspace-summary.json` retained. This is not established as an A15 regression; targeted/full rechecks reported separately below.
- Targeted drain recheck **exit 0** (one test, `drain-recheck.log`, `drain-recheck.exit`); the paused-time failure did not reproduce in isolation. No code changed for this rerun.
- **Post-delivery gate update:** second full workspace run completed after the targeted check: `workspace-recheck.exit=0`, **185 summaries / 1274 passed / 0 failed / 19 ignored**, zero failure/panic/error lines (`workspace-recheck-summary.json`). Completion notification received and logs inspected without polling. First-run failure remains retained; successful rerun does not change the S1 finding or REQUEST CHANGES verdict.
- Controller `gates-3/done` present at final check: connect exit 0 (361/0/18), openai-ns exit 0 (56/0), run.ts exit 0 (all equal), **admin exit 1** (20599 equal /27 expected /6 failures). `admin.log:26–46` shows three **frozen TS** restarted-identity deadline misses (each counted as DIFF and DEADLINE); Rust within 1 s. Not evidence of a Rust A15 regression, but not a green gate. Read controller logs directly; summary copied to `controller-gates.txt`. No waiting/polling for those gates.

## Limits

No live Postgres; no exhaustive SQLite sort-type/tie fuzzing; no injected P-lock-only pause plus external delete beyond existing tests; no independent same-id concurrent-upsert unit test; no saturation deadline measurement. The new test does not prove absence of all transient post-commit stale publication, only final ordering of serialized authoritative operations. The report does not expand the controller ruling to promise transactional cross-process snapshots.
