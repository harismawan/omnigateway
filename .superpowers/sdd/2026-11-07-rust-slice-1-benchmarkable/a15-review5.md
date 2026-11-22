# A15 fifth independent review — APPROVE

Scope: `3b1b09d2..6ffc2501`, option A full connect rebuild. No product edits, commits or subagents. Evidence `/tmp/opencode/a15-review5/`; earlier evidence and dirty reports untouched. Reviewed binary SHA256 `3c0ab923901db5a17faebfd829aec9fec5f51e0103c07b3681f281b6c77d9c3c`; frozen SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.

## Verdict and findings

**APPROVE `6ffc2501`**, across the previous rounds, under the explicit carry-forward bounds below. **T1, T2 and M1 closed.** No new Critical, Important or Minor finding established. Earlier missing-entry/immediate visibility/lifecycle/error/privacy/ID-validation issues remain closed in this round's independent sweep. The eager rebuild's latency and shared OAuth-backend stall are real, measured tradeoffs of the user's chosen option A, not hidden claims of zero-cost parity.

`rebuild_from` takes a tracked publication job before spawning a blocking worker, obtains W before the full authoritative read, then P before store and generation increment. It invokes exactly `rebuild_read`, as does the SQLite poller. SQLite uses `read_snapshot`; Postgres uses the factored pure `snapshot_from` after its backend read. This removes both reconstructed-order failure mechanisms (T1 rowid ties and T2 lossy labels) rather than adding a comparator exception.

Poller reads `data_version` before acquiring W, returns that earlier value only after successful rebuild, and advances its private version then. If a concurrent commit occurs during its wait/read, a subsequent poll sees another version and may redundantly rebuild; it does not mark an unread newer version as consumed. Connect does not modify the poller's connection-local version. W prevents an older captured snapshot from being published after a later W-serialized authoritative read. External commits are not atomic with snapshot publication, as before.

Generation has the same effects as any successful poll rebuild: negative-key entries from an earlier generation are no longer authoritative; preseeder rescans and diffs `(id, limits)` rather than reseeding unchanged subjects. Failed reads return before publication and generation increment. Connect logs a warning but returns saved credential success. No helper timeout was added.

Primary independent selected evidence: **1468 paired records, 1450 equal, 18 documented differences, 0 unexpected differences**. Separate ten-trial committed-driver confirmation: **665 / 647 equal / 18 documented / 0 failed**. Detailed counts below; exploratory fixture-confounded runs are explicitly excluded rather than silently discarded.

## Consistency audit (a–f)

**a — Refresh identity.** Independently extracted the non-test region from `fn patch_credential` through the end of `refresh_credential` from both `7ad389ce` and HEAD. Byte-identical SHA256 `76efaf8548c423b9eebf59b188e7449e011c7138931e5cbb39185d7d23f4a77b` (`refresh-identity.json`). No refresh call-site changes in this round. Pre-existing snapshot tests passed, including both cancellation/drain tests, queued/gated health/rebuild tests, single-publication/no-retry test and delayed-positive-key-read test (`core-snapshot-tests.json`).

**b — Poll equivalence.** `snapshot.rs:314–365,505–530`: identical authoritative SQLite transaction/read machinery and W/read/P/store/generation increment. The private poll version is sampled before W, not after read/publication; therefore it can cause an extra rebuild after connect, never suppress the rebuild for a commit its snapshot missed. On read failure it does not advance version. A connect rebuild can also be followed by a redundant poll rebuild even with no intervening change, because connect deliberately does not update the poller's connection-local marker. This can cost latency/work and another generation increment; it is not stale publication. W does not cover external commits, nor turn pre-existing health/publication concurrency into a cross-process transaction.

**c — Connections and large-DB measurements.** The new mutex is the OAuth refresher's backend connection (`lib.rs:498–509`), shared with other OAuth backend reads/saves, including the reconnect-start lookup and token refresh. It is NOT the request snapshot (lock-free), key-miss reader (`lib.rs:421–431`), admin-auth connection, control/admin-config connection (`433–446`), poller's connection or batched writer's connection (`backend.rs:119–125`). Calling it one mutex shared by all operations would be incorrect. W is additionally shared with poll rebuilds and token-refresh publication; P is acquired only after the full read.

Large fixture adds 5,000 enabled encrypted OAuth credentials, 2,000 keys, 500 models, 25,000 health rows and 15,000 quota rows to the seed. Five reconnects/provider/route, with 50 concurrent sequential settings reads per reconnect; all 20 acknowledgements/side were HTTP 200. Observed acknowledgement min/median/max milliseconds:

| Provider/route | Frozen | Rust |
|---|---|---|
| anthropic finish |112/138/148|442/446/471|
| anthropic poll |88/115/147|447/461/483|
| openai finish |99/120/149|449/458/475|
| openai poll |94/126/140|448/456/469|

Settings reads: frozen median ~26–27 ms, maxima 42–47; Rust median ~79 ms, maxima 96–120, all succeeded. These are whole HTTP timings under load, not measured mutex hold durations, and the cross-language difference cannot all be attributed to the new lock. Full rebuild moves work frozen defers to routing into the connect acknowledgement. No timeout or absolute bound exists. Raw `large/{ts,rust}/measurements.json`, `large-summary.json`; same-backend/health/disconnect probe below.

**d — Generation.** `miss.rs:88,116,176–188` rejects earlier-generation negative cache entries and suppresses stale negative insertion after a generation change. `lib.rs:104–145` preseeder observes generation then snapshot; a concurrent swap is seen on the next tick, unchanged `(id, limits)` are not seeded again. Exactly the existing full-rebuild consequences, now triggered earlier/more often by connect. Key misses already recheck current snapshot identity before insertion. No credential-specific cache invalidation dependency was lost.

**e — Postgres.** Compiled in the independently run core gate and recorded workspace/clippy gates; no live database. `Store::snapshot_reads` delegates to PG's repeatable-read/read-only transaction (`pg/mod.rs:261–279`). `runtime.block_on` inside `spawn_blocking` is the same established adapter pattern as the byte-identical refresh path; it does not block a Tokio async worker or nest block_on on that worker. `read_snapshot` remains the same read plus the extracted pure construction `snapshot_from`; no PG-specific comparator/upsert remains. Successful PG rebuild also uses the identical W/P/store/generation machinery. Production gateway backend integration remains outside this slice's live evidence.

**f — Cancellation/error/shutdown.** Connect finish and poll exchanges own detached completion (`connect.rs:77–94,310–318`), including the awaited rebuild; loss of the HTTP waiter does not cancel their worker. PublicationJob is obtained before spawn and moved into the blocking closure, so even cancellation of its async waiter cannot untrack an unfinished publication. Existing shutdown joins producers and drains publications with its overall grace deadline (`lib.rs:582–608`). It is not an unlimited shutdown guarantee. Independent drop-virtual_models fault probe: both sides return 200 with saved `anthropic-full`, Rust logs `credential snapshot publication failed; retaining previous snapshot` (`read-error/rust.log:9`); scratch exit 1 compares unnormalised updated_at/expires_at, not status failure. The new core test independently confirms Arc identity and generation unchanged after read error. A full rebuild failure can leave a successfully persisted credential temporarily invisible; warning+success is the explicitly chosen contract.

## Removed tests

Relative to **7ad389ce: none removed** (`removed-7ad389ce.json`). Existing refresh-race tests remain. Relative to **3b1b09d2**, five tests removed (`removed-3b1b09d2.json`, which also lists removed non-test helper names):

- `connect_upsert_orders_replaces_removes_and_preserves_read_errors`: upsert-specific placement is gone; full-rebuild insert/order/delete/error/generation subject covered by new real-store rebuild test. Its assertion that refresh does not insert was extra coverage of an unchanged subject.
- `connect_replacement_order_matches_store_rebuild`: reconstructed comparator is gone; now publishing the actual rebuild, not approximating it. Driver exercises changed labels, equal keys and raw invalid UTF-8 order.
- `patch_credential_changed_label_keeps_old_position_unchanged_behavior`: **subject still exists**, refresh keeps position; this extra round-4 pin was removed along with upsert tests, not because refresh semantics changed. Independent byte identity and pre-existing refresh tests are stronger scope evidence, though retaining this small explicit regression pin would be reasonable.
- `refresh_absent_stays_absent_but_connect_publishes`: refresh half still exists unchanged; connect half now full rebuild, whose insert behavior the new test covers. Removed adapter-level combined coverage, not removed functionality.
- `connect_upsert_serializes_with_rebuild_without_resurrection_or_duplicates`: upsert no longer exists. Shared W-serialized full-rebuild/refresh race remains covered by `authoritative_sections_serialize_read_and_publish_in_both_orders`, now adapted to the actual async `rebuild_from`; no pre-7ad refresh race test disappeared. Same-id full rebuilds serialize through W and reread rather than merge captured rows.

## Gates independently executed / logs inspected

All Rust mtimes touched before cargo; offline, shared warm target, two jobs, incremental/debug disabled; one cargo command at a time. Exit writes are on the same shell command line. Reviewer `core.exit` = **0**, **76 passed / 0 failed / 1 ignored**. `race-{1..20}.exit` = **0 each** (adapted authoritative ordering race); `refresh-race-{1..20}.exit` = **0 each** (pre-existing gated refresh/health/rebuild race).

Implementer logs scanned, not rerun: `/tmp/opencode/a15/fix-5/workspace.exit` = **0**, 185 summaries, **1272 passed / 0 failed / 19 ignored**; `clippy.exit`, `fmt-green.exit`, `dispatch-size.exit` = **0**. No FAILED/error/panic lines in those logs; dispatch concrete state machine **5496 bytes**, ceiling 5500. No evidence requiring another workspace run. `38971476..6ffc2501` tracked diff empty, consistent with the binary's source provenance (SHA verified above). Reviewer's narrow tests rebuilt touched sources, not a release binary.

### Same-backend stall and disconnect measurement

`large-cancel/` uses the same large fixture. Abort finish at 50 ms. Rust token exchange completes in 2 ms, detached completion logs success ~436 ms later; HTTP waiter reports `aborted`. While that rebuild is outstanding, a reconnect-start lookup on the **same backend** takes **383 ms**, versus health **0.74 ms** and separate-connection settings **79 ms**, all HTTP 200. Afterward inference is 200 and its only upstream bearer is `cancel-access`: detached worker published despite client loss. Frozen finish had already returned 200 before the scheduled abort; frozen concurrent health/settings/reconnect-start measured **8/41/42 ms**. Its later inference succeeded with the new token, although background refresh wire traffic also appeared in that scratch capture. This is a timing/ownership probe, not a clean paired wire-count conformance row.

Thus the rebuild genuinely stalls other OAuth backend operations sharing that mutex for hundreds of milliseconds at this scale, but does not lock all admin/request operations. Token refresh can wait on the same backend and W. Large fixture is a bounded synthetic measurement, not a maximum latency SLA, blocking-pool saturation study or independent verification of every router/health workload. Evidence `large-cancel/{ts,rust}/cancel.json`, Rust log timestamps; `large.exit=0`, `large-cancel.exit=0` (their scratch comparison tables are empty, so evidence is the explicit timings/status/wires, not those empty table counts).

## Ordering findings disposition

**T1 CLOSED for priority and zero-weight fallback.** Copied round-4 unique-model priority reproduction `tie-clean/`: **80 pairs equal**, all **10/10 first requests per provider/route per side** select the reconnected older-row credential. Copied zero-total-weight fallback `weighted-zero/`: **80 pairs equal**, same 10/10 in all four provider/route cells, avoiding random weighted lottery. Both `.exit=0`. Original copied `tie-rr/` produces **80 equal pairs**, but its reused upstream models develop roundRobin history; both sides alternate the same credential, so its obsolete always-new-token assertion reports exit 1. Fresh-upstream-model confirmation is separate, not inferred from this reused-state run.

**T2 CLOSED in the isolated repeat.** `invalid-ten-clean/`: raw label 0x80 vs UTF-8 é, unique upstream model each trial, **80 equal pairs**, **10/10 exact-new-bearer first requests in every provider/finish/poll cell on each side**, exit **0**. The copied round-4 scripts were first run unchanged: Anthropic finish and isolated OpenAI finish now both agree. A repeated script which leaves invalid label bytes in place while subsequently creating another model fails its admin fixture, not publication: Rust operator-list decoding refuses invalid UTF-8 while routing reads lossily decode it. `invalid-ten/` consequently has 39 non-model inference failures; copied `invalid-utf8/` has one OpenAI model-setup failure. Model creation was unchecked in those old scratch scripts. `invalid-ten-clean.ts` restores valid labels **before** each model setup, then applies invalid bytes only after the fixture is published; this avoids expanding the finding into an unrelated operator invalid-metadata contract. These polluted scratch runs are retained and excluded from primary ordering totals. No claimed 39-fold connect regression.

The old upsert reconstructed credential order after decoding; the new path preserves SQL arrival order before decoding (`credentials.rs:288–300`). Frozen source `packages/store/src/sqlite/credentials.ts:191–193`, `packages/router/src/index.ts:81–111`; full invalidation model `snapshotCache.ts:39–87`. Equal rowid ties and invalid bytes are exercised against the SQL/frozen behavior, not merely a Rust comparator unit test.

**T1 CLOSED also for roundRobin.** `tie-rr-clean/`: fresh upstream model for each trial/provider/route, **80/80 equal pairs**, 10/10 exact-new-bearer successes in all four cells per side; exit **0**. Committed driver's independent equal-priority/equal-roundRobin runs additionally achieve the same 10/10/provider/route result (`driver-ten-final/`, `driver-first-counts.json`). Priority unique-model confirmation and zero-weight fallback requested from round four are both included above.

**M1 CLOSED.** `conformance/e2e/connect.ts:450–458,498–499` computes `expectedId` using a read-only connection's independent `SELECT id FROM credentials WHERE enabled=1 AND provider=? ORDER BY tier, label LIMIT 1`, then reads/decrypts that side's persisted token by that ID. Actual bearer comes from the stub's captured upstream headers, not from the selected Rust snapshot. The fixture isolates equal healthy/unused candidates with a unique upstream model; first-request roundRobin stable ties therefore retain SQL arrival order too. Each side must be 200, correct answer, exactly one wire **and** match its expected bearer; the outer loop rejects either invalid side before equality. Two binaries choosing the same wrong account cannot pass merely by agreeing. `expected-bearer-negative-control.json` recomputes validity with the same deliberately wrong bearer on both sides for all four changed-label pairs: **8/8 side checks false**. This is an assertion-level negative control, not a mutated product binary. Expectations remain fixture/DB-based, not a universal independent implementation of all router strategies or protection against identically corrupted persistent input.

## Driver results

Independent `driver-one.exit=0`: **377 rows / 0 failed / 18 expected**, exactly provider-list **12** and unported-provider **6**. Independent `driver-ten-final.exit=0`: **665 / 0 / 18**; every changed-label/equal-priority/equal-roundRobin/invalid-utf8 × provider × finish/poll cell has **10/10** expected-bearer first requests on both sides. Fresh/immediate-reconnect cells also pass. No retries. The twelve new rows are ordinary equality rows, with extra per-side validity assertions, not divergence exemptions. Exact divergence classes/counts are asserted at lines 505–520; no visibility-lag class.

`row-name-diff.json` compares round-4 `current/` (365 rows, committed `3b1b09d2` driver) with this single-trial run: **nothing removed, 12 added** — `equal-priority`, `equal-roundRobin`, `invalid-utf8` × both providers × finish/poll, each trial 0. Existing four changed-label names retained. Copied driver changes only evidence path, import and CLI cwd; initial copy attempts `driver-ten` and `driver-ten-fixed` failed on relocation (relative import, then relative CLI cwd), recorded exit 1; neither started a gateway. `driver-ten-final` and `driver-one` use corrected worktree paths. No product driver edits.

## Carry-forward contract and limitations

Any approval below is for this branch/slice with these explicit bounds, not a claim of universal gateway parity:

- Provider refusal list derived from connectable build: only Anthropic/OpenAI supported here, versus frozen's eight; **18** documented rows (12 list-message, six unported provider outcomes). No arbitrary new expected-divergence class.
- Other admin configuration writes (models/keys/settings) retain the documented nominal **500 ms data_version polling lag**, with no absolute bound under contention/error. Connect now eagerly rebuilds the whole snapshot before acknowledging; frozen marks stale and pays rebuild on the next routing read. This latency placement, duplicate poll rebuild work and shared OAuth-backend stalls measured above are accepted consequences of option A, not instantaneous/no-cost publication.
- Pending flow KV is process-local, frozen key/JSON and **600000 ms TTL**, lost on restart; no global sweep/cap on unused expired starts. Ordinary provider OAuth exchange remains bounded by its existing transport deadline, but publication itself has no helper timeout.
- PKCE poll deliberately exchanges an **empty code**; it is not a newly implemented device-code protocol. Held poll/finish may both redeem and create two credentials, as frozen does. Poll completion owns consumption even without HTTP waiters; finish consumes first and detached completion continues.
- Frozen provider parsing/host behaviors retained: OpenAI normalizes non-string refresh/id tokens, Anthropic non-null refresh-token types can be rejected; non-scalar Anthropic account email becomes generic internal error at binding. Built-in FlowResult field matrix does not prove arbitrary plugins' isFlowResult validation. Token claims are parsed, not signature-verified by this slice.
- **X2 expiry carrier** fractional/nonfinite/large-number behavior remains the earlier separately parked limit, not resolved by this snapshot change. JSON cannot express undefined/functions/symbols/bigints; absent-property cases are not every possible JS value. No exhaustive SQLite storage-class/collation/huge-integer fuzzing. Invalid-UTF-8 operator/admin fixture reads remain distinct from routing order handling.
- W serializes authoritative reads/publications, not arbitrary external database commits with the snapshot swap. Existing health/P-lock behavior and cross-process transient staleness model are inherited; no new transactional cross-process snapshot promise. Old request-held snapshots remain valid immutable views; a generation increment does not mutate an admitted request's snapshot.
- **No live Postgres**, production backend integration or fleet test. PG adapter compiled and reasoned about only. No explicit TCP RST certification, exhaustive callback/TTL boundary HTTP matrix, blocking-pool saturation/latency SLA, or combined disconnect-during-rebuild-plus-SIGTERM certification. HTTP lifecycle, large-rebuild disconnect and ordinary SIGTERM probes are separate evidence, not proof of every combined schedule. Shutdown publication drain remains subject to the global grace deadline.
- Full rebuild error intentionally warns and still acknowledges the already successful save, retaining previous snapshot; next poll may repair it. No stronger guarantee if store remains unreadable.

## Independent regression sweep

First-request successes (exact answer and new bearer, no retry), **TS / Rust**:

| Operation | Anthropic finish | Anthropic poll | OpenAI finish | OpenAI poll |
|---|---|---|---|---|
| Fresh |20/20 / 20/20|20/20 / 20/20|20/20 / 20/20|20/20 / 20/20|
| Immediate reconnect of fresh row |20/20 / 20/20|20/20 / 20/20|20/20 / 20/20|20/20 / 20/20|
| Disabled existing-row reconnect |20/20 / 20/20|20/20 / 20/20|20/20 / 20/20|20/20 / 20/20|

`trials/` covers first two rows; `ordinary-clean/`, `ordinary-poll/` third. Round-2 missing-entry reproduction `missing-clean/` separately repeats finish immediate reconnect, **20/20/provider/side**, 80 equal records; poll is independently exercised by the immediate-reconnect trial row above. `first-counts.json` contains full per-side cells. All these `.exit` files **0**.

I1 lifecycle (`lifecycle/`): **10 equal pairs** — each provider's held race, disconnected success, refusal, transport-close and 31-second timeout. Successful disconnected exchange saves exactly one credential and later poll is 400 unknown/expired; failures save zero and consume the flow. Delayed-close follow-up (`close/`) **2 equal pairs**. Additional held poll/finish race (`race/`) **2 equal pairs**, two requests/two credentials then consumed, matching frozen. SIGTERM (`signal/`) **1 equal pair**, Anthropic finish, process exit **0**, one saved credential each; shutdown **821 ms frozen / 815 ms Rust**. All corresponding `.exit` files **0**. These preserve inherited double redemption, not a claim to at-most-once redemption across finish and poll.

FlowResult built-in field×type matrix (`matrix/`) **196/196 equal**, zero differences, `matrix.exit=0`: 2 providers × finish/poll × 7 fields × 7 types (absent/null/string/number/boolean/array/object), compared HTTP response and selected decrypted persisted values. As in round two, token JSON probes fields reachable through these two built-ins, not arbitrary FlowResult/plugin injection.

### Selected paired-record totals

| Group | Pairs | Equal | Different |
|---|---:|---:|---:|
| Single-trial committed driver |377|359|18 documented|
| Equal-key unique-model priority |80|80|0|
| Equal-key unique-upstream roundRobin |80|80|0|
| Equal-key weighted zero-total fallback |80|80|0|
| Invalid UTF-8 isolated 10-trial/provider/route |80|80|0|
| Fresh + immediate reconnect |320|320|0|
| Disabled reconnect finish + poll |160|160|0|
| Missing-entry reproduction |80|80|0|
| Lifecycle + delayed close + held race + SIGTERM |15|15|0|
| FlowResult field/type matrix |196|196|0|
| **Primary total** |**1468**|**1450**|**18 documented, 0 unexpected**|
| Separate committed-driver ten-trial confirmation |665|647|18 documented|
| **All selected records including confirmation** |**2133**|**2097**|**36 documented, 0 unexpected**|

`counts.json`, `wire-checks.json`, saved rows/wires and `.exit` files are retained. A record pair is not an individual HTTP request nor an independent defect. Large timing/error probes, repeated exploratory invalid-label/reused-roundRobin runs and assertion-level mutations are excluded from these selected totals for reasons documented above. No positive-weight stochastic lottery comparison used as deterministic evidence.

## Controller final gates

`/tmp/opencode/a15/gates-5/done` **exists** at final review; logs read only then, not waited/polled. Commit record `6ffc25010979f5ba9ccd5f84da97085b6ce5f8d7`, SHA256 Rust/frozen match reviewed binaries. Read from files: `connect.exit=0`, `openai-ns.exit=0`, `e2e.exit=0`, `run.exit=0`, `admin.exit=0`.

- Connect **377 / 0 failed / 18 expected**.
- OpenAI namespace **56 / 0 failed**.
- `run.ts` e2e: all listed client/upstream/scenario rows equal; DB checks include 37 request logs, 18 usage_daily, six usage_rollup and four credential_health rows. The request-ID row explicitly retains TS-v4/Rust-v7 documented behavior rather than raw ID equality.
- Admin routes **20602 equal / 27 expected divergences / 0 failures**, 38 raw keys minted. Live-poison notes show Rust observed tested corruption/revocation/model writes within ~275–501 ms, consistent with documented admin polling, not synchronous admin visibility.

Controller gates corroborate, but are not substituted for the independent core/race/connect and copied reproduction runs above. No product edit, commit, release build or subagent. Evidence remains under reviewer directory; only the requested new report was written in the worktree (gitignored SDD path, uncommitted).
