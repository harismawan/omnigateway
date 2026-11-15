# A15 fourth review — REQUEST CHANGES

Reviewed `753ba820..3b1b09d2`; no product edits, commits or subagents. Evidence `/tmp/opencode/a15-review4/`. Previous evidence/reports untouched. Binary SHA256 `424db636d8c7d788697521f0e6be5b3bd558448a871580617da972b0b7f60b40`. `git diff --stat 47ca0b16..3b1b09d2` empty: final commit changes no tracked source. Gateway probes use private HOME, explicit environments, Bun `--no-env-file`, loopback-only namespaces.

## S1 disposition

Moving changed keys fixes the original unequal-label example, but **store-order parity is not fully closed**. The controller's after-existing-equals rule is not frozen-exact for a lower-rowid credential moved into a later row's equal key. I disagree with that part of the ruling because SQLite's observed tie order and the routing choice differ, as detailed below. Existing token-refresh behavior must remain unchanged; the correction belongs only to connect publication.

## Code analysis

`snapshot.rs:386–412`: finds current index; computes move_row only for insert_missing=true and unequal tier/label; unchanged/refresh replacement uses original index. Changed upsert removes before calculating a **new** insertion position; no stale-index reuse. Empty vector, first/last removal are safe. None still removes; errors precede publication. W/P order, authoritative read, current clone, tracked job and PG branch unchanged.

Refresh (`insert_missing=false`) always takes replace branch for present row and does nothing for absent row, independent of changed keys. New refresh pin verifies this. Existing concurrency/cancellation tests run below. Two gated tests cover W-serialized read/publication; they do not make arbitrary external DB commits atomic with snapshot publication, as already documented in round three.

Tier equality uses f64: -0==+0, correctly same numeric SQLite ordering; binary64 values equal after storage/read do not spuriously move. INTEGER values outside exact f64 range remain an inherited carrier limitation, not exhaustively tested. Numeric NaN binding becomes NULL and cannot pass required numeric read. Labels containing NUL are valid Rust strings; byte comparison matches SQLite BINARY for valid UTF-8, including NUL. **Invalid UTF-8 TEXT can reach Credential**: `omni-store/src/row.rs:21–29` decodes with from_utf8_lossy. Its bytes then differ from the bytes SQLite sorted. See second finding.

New `connect_replacement_order_matches_store_rebuild` genuinely calls a real rebuild and compares ID order, not only comparator output. However its equal-neighbour fixture puts `before` at a LOWER rowid than `subject`; append-after-equals happens to match. It never moves an OLDER subject into a NEWER neighbour's key. Later/earlier/tier cases would fail the old implementation; unchanged-key and refresh pin should pass old code. Existing test also sorts its own cloned list—useful for unequal order, insufficient for tie fidelity.

## Important — T1: Changed-to-equal key reverses SQLite tie order

Frozen `packages/store/src/sqlite/credentials.ts:191–193` lists `ORDER BY tier,label`; `packages/router/src/index.ts:81–111` retains arrival order on priority/round-robin ties. Rust `snapshot.rs:397–409` inserts after all existing equal keys, discarding the older row's original rowid precedence.

Reproduction scripts `tie.ts`, `tie-rr.ts`: enable `anthropic-full` (older rowid) with label `a`, and `anthropic-missing` (newer rowid) with label `b`, equal tier/weight. Prepublish unpinned virtual model/key, wait 650 ms. PATCH `/api/credentials/anthropic-full` `{"label":"b"}`; start reconnect with `{"provider":"anthropic","credentialId":"anthropic-full","label":"inference"}`; finish/poll it with flowId/code. Token reply carries `anthropic-inference-access-N`. Immediately infer with the pre-existing model. Repeat OpenAI. SQLite lists full before missing at equal key, while upsert moves full after missing. Full wire/DB evidence under corresponding run directories; summary counts appended below.

Priority and roundRobin each produced **40 different first-request outcomes** (10/provider/route), with 40 equal start rows. In priority finish trial 0, frozen HTTP 200 uses new full token, Rust HTTP 200 uses old missing token. Raw inference body is `{model:"inference-anthropic-false-0",messages:[{role:"user",content:"hello"}],max_tokens:32,stream:false}` with fixture bearer client key. `order-db.json` confirms full rowids 1/5 versus neighbour rowids 2/6 and equal `tier=1,label=b` on both DBs. Reused model names across route phases can carry selection history; separate unique-model confirmation is identified below. The deterministic first trial alone establishes the defect.

Unique-model priority confirmation `tie-clean/`: **40/40 first-request differences**, frozen all select new token, Rust all select neighbour. This is the primary tie evidence used in final counts. Weighted zero-weight fallback (`weighted-zero/`) removes random lottery and yields **39/40 different selections**; one publication happened after the ordinary rebuild and agreed. This confirms weighted arrival order is observable too, without claiming random positive-weight samples must pair exactly.

## Important — T2: Lossy label comparison differs from SQLite raw TEXT ordering

Frozen same list/rank references; Rust `row.rs:21–29` lossily decodes metadata, and new changed-key insertion compares decoded `label.as_bytes()` at `snapshot.rs:405`. SQLite orders raw TEXT bytes. Existing rebuild preserves the SQL order before decoding; upsert recomputes a different order afterward.

Paired reproduction `invalid-utf8.ts`: held full label `z`, other label `é`, equal tier; after setup `UPDATE credentials SET label=CAST(x'80' AS TEXT) WHERE id='<provider>-full'`; reconnect full, then immediately infer. SQLite raw 0x80 sorts before UTF-8 é (C3 A9); decoded U+FFFD (EF BF BD) sorts after. Anthropic: both HTTP 200, frozen sends `Bearer anthropic-inference-access-0`, Rust sends `Bearer old-access`. OpenAI frozen HTTP 200/new token, Rust HTTP 503/no inference wire in this run. Evidence `invalid-utf8/{ts,rust}/*-routable.json`, DBs, `sqlite-edges.json`. No live provider traffic. Hand-altered metadata is required; ordinary JSON labels are valid UTF-8. This is distinct from equal-key placement and needs authoritative store-order handling rather than only a tie tweak.

Repeated with unique models (`invalid-repeat/`): six result differences. Only the first Anthropic wire comparison is used to establish the pure selection defect; later Rust 503s can include polluted health/refresh state and are not independently classified as new defects.

Isolated OpenAI confirmation (`invalid-openai/`): both HTTP 200; frozen sends `Bearer openai-inference-access-0`, Rust `Bearer old-access`. Thus the pure selection mismatch is independently reproduced for each provider. `invalid-label-db.json` confirms raw label hex 80 versus C3A9 persisted identically on both DBs.

## Minor — M1: Changed-label rows record but do not assert the expected bearer

Four new rows compare actual bearer arrays across binaries and assert 200/answer/one wire, so they detect the old unequal-label mismatch. They compute `expectedBearer` from the other persisted credential but only **write it to evidence**, never assert actual bearer equals it. Both sides selecting the same wrong credential could pass these rows. This is a minor harness weakness; the frozen oracle still makes current differential meaningful. Exact divergence count remains 18, with no visibility-lag class. Source diff is additive (+30 driver lines); row-name comparison recorded below.

Location `conformance/e2e/connect.ts:442–445`; frozen selection contract `packages/router/src/index.ts:81–84` plus store ORDER BY above. This is an assertion-strength finding, not an observed two-binaries-wrong incident. Current paired rows pass; hypothetical mutation of both recorded bearer arrays to the same wrong token also passes the equality check because expectedBearer is not in the compared row. Add an explicit comparison before accepting each row.

## Gates read/run

Reviewer `core.exit=0`: **80 passed, 0 failed, 1 ignored**, including pre-existing snapshot tests and new refresh pin. `connect_upsert_serializes_with_rebuild_without_resurrection_or_duplicates-{1..20}.exit` and `authoritative_sections_serialize_read_and_publish_in_both_orders-{1..20}.exit` all **0**. Real gate results, not inferred from implementer claims. Rust source mtimes touched first; offline/shared target/two jobs/no incremental/debug=0, one cargo command at a time. No workspace rerun: no failures in targeted gates or source changes outside this narrow shared path gave cause to doubt the recorded workspace gate.

Implementer logs scanned in `implementer-gates.json`: workspace **1276 passed/0 failed/19 ignored**, recorded command exit 0; clippy/fmt/dispatch recorded exit 0, no error/panic/FAILED lines. Dispatch ceiling unchanged, 5496 bytes. Binary provenance above verified independently.

## Ordering trial results and harness caveats

- Original direct-SQL and admin-PATCH scripts now compare equal (4 pairs each).
- Unequal-label 10 trials/provider/route: direct SQL **80 equal rows**, admin PATCH **80 equal rows**. Both now select the other credential as frozen does. Old scratch `valid` expects the reconnected token, so both sides mark false and legacy console reports failures; raw paired equality/wires confirm S1's original example fixed. These are retained scratch expectations, not product failures.
- Actual tier REAL change to 3.5 via SQL: **80 equal rows**, same legacy expected-token caveat. Initial `tier/` used rejected/non-applied fractional admin input (DB tier stayed 1), so it is **not** evidence of tier-change handling; corrected `tier-real/` is.
- Unchanged key **80 equal**; unchanged among equal keys **80 equal**, preserving older-row precedence.
- Ordinary weighted random selection (`tie-weighted/`) differs in 23/80 rows but independent random draws prevent interpreting those as deterministic parity failures. A zero-weight fallback test removes lottery randomness; results below. No claim to same-seed positive-weight behavior from independent gateway RNGs.
- Numeric/NUL SQLite experiment `numeric-nul.json`: -0/+0 normalized equality, distinct binary64 0.3 versus 0.30000000000000004, valid Unicode and embedded NUL order all match numeric/UTF-8 comparator. Invalid TEXT bytes are the exception above.
- Driver row-name diff: **none removed**, exactly four changed-label rows added (`row-names.json`). Current driver **365/0 failed/18 expected**, exit 0. This does not cover changed-to-equal older row or invalid UTF-8 metadata.

## Carry-forward constraints / unverified

Provider refusal list differs by supported build (12 provider-list and six unported-provider expected rows). Pending KV process-local, 600000 ms, lost on restart, no global expired-entry sweep/admin-start cap. PKCE poll intentionally exchanges empty code; held poll/finish can exchange twice/create two credentials. X2 fractional/nonfinite expiry carrier remains parked. Publication waits without a helper timeout; shutdown has overall grace deadline. No live Postgres, explicit TCP RST, exhaustive callback/TTL boundary HTTP matrix, blocking-pool saturation or disconnected-SIGTERM certification. Earlier rounds' passing error/privacy/type/lifecycle checks remain evidence, not proof of every possible malformed input. Overall approval withheld for ordering findings.
