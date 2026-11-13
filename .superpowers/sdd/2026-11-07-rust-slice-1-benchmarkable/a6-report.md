# A6 implementation report

Status: partial increment; **A6 is not complete**. Base f7c48e57. Evidence:
`/tmp/opencode/a6/`. Frozen TS and user-owned files were not edited.

## Implemented

- SQLite GET/POST `/api/credentials`, PATCH/DELETE `/api/credentials/:id`,
  GET `/api/credentials/health`, using the existing reader/admin guards.
- API-key writes seal the trimmed UTF-8 secret with the configured field key.
  Metadata reads never decrypt secrets. Create preserves the submitted label's
  UTF-16 in its immediate answer; SQL text binds use replacement characters as Bun
  does. Provider data preserves lone surrogate escapes in JSON. Custom endpoint
  metadata conflicts compare UTF-16 strings without folding them together.
- Patch preserves strict schema validation, empty-patch no-op, manual disable
  reason/time and re-enable clearing. Delete uses the database foreign keys and
  leaves model target JSON untouched, matching the TS repository.
- Health returns stored health/quota, burn projections and last-used seeks.
- SQLite snapshot reads isolate unreadable credential metadata. Operator reads
  remain strict. A malformed credential no longer freezes unrelated publication.
  This was required by the black-box test: creating a lone-surrogate endpoint
  previously froze every subsequent credential/model edit in the snapshot.

## Verification and limits

Both real gateway binaries are copied outside the checkout. SHA256 manifest is
`binaries.sha256`. The driver extends `conformance/e2e/admin-routes.ts` and compares
status/headers/body and its existing per-step DB dump, decrypting all four credential
secret columns with the TS-compatible PBKDF2/AES-GCM format before comparison.
It asserts the three supplied secret strings never appear in captured responses
or gateway stdout/stderr. This does not inspect arbitrary unobserved output.

The credentials corpus covers all five routes and three caller kinds, strict
patch errors, missing ids, repeated deletion, concurrent disjoint edits, provider
existence/format, custom URL normalization/refusals/conflicts, lone-surrogate labels
and endpoint identity, seeded breaker/quota rows and retained target JSON.
The DB dump inherits A5's exclusions (nodes, request_logs, usage_rollup, usage_daily,
migrations); it is not a literal whole-database comparison.

Initial RED: 17 equal / 46 failures. Expanded metadata RED: 16 equal / 101 failures
(`red-edges.log`), GREEN: 117 equal / zero failures (`edges.log`). Later routing
checks exposed the snapshot poisoning above (`routing4.log`: two Rust deadline
failures plus two response-verdict differences). Initial routing harness attempts
also had invalid model bodies and non-streaming upstream responses; these are
retained in routing*.log, not claimed as implementation RED.

An initial workspace run failed the old test asserting that credentials were
unported, and an unrelated snapshot test race (two separate autocommit writes were
observed between key creation and model repair). The old unported-path test now
uses `/api/unported`; no snapshot-test timing change was made. The next workspace
run passed (`workspace-final.log`), before the credential isolation change.

## Outstanding requirements / concerns

- **Postgres credential writes/admin integration are not implemented.** The current
  gateway boot and ControlStore are SQLite-only; PgStore has credential reads but
  no credential create/update/delete APIs. No live-PG verification is claimed.
- No TS gateway restart over Rust-written DB or inverse cross-read driver yet.
  Decryption in the differential dump proves the encryption format, not both
  application-level restart directions.
- Routing metadata containing lone surrogates is omitted rather than represented
  exactly in the routing layer (the admin JSON and stored metadata are lossless).
  PG snapshot isolation is not changed. Ordinary SQLite credential secrets already
  isolate unreadable ciphertext through the existing Secret::Unreadable type.
- Health burn tests currently seed a suppressed reading; active/stale/rolled-over
  arithmetic needs a fuller oracle matrix, as do unusual SQL scalar types.
- Refresh/OAuth remains deferred to B1. The frozen admin router has no direct
  credential refresh route to port; no invented fallback route was added.
- Snapshot timing checks begin at the polling step after mutation response/dump,
  not at database commit. This inherits A5's timing limitation.
- Credential writes currently live in the control module rather than shared
  store mutation APIs; follow-up should extract these when adding PgStore writes.
- Toggle logs are emitted before the SQL update and omit the TS provider field;
  log equivalence for these events is not asserted by the existing A5 log filter.

## Gate chronology

- Before isolation: `workspace-final.log`: 1036 passed, 0 failed, 7 ignored.
- Before isolation: admin-auth 212 equal / 4 expected / 0 failures; surface
  606 equal / 61 expected / 0 failures; run.ts all rows equal. These logs are
  `admin-auth.log`, `surface.log`, `run.log`.
- Final credentials corpus on pre-A6 binary: 22 equal / 115 failures
  (`red-last.log`). This includes cascading DB differences, not 115 independent
  defects. Two additional misses are explicitly per-binary routing deadlines.
- Isolation GREEN: 135 equal / 0 failures (`routing-green.log`), including
  created, disabled, enabled and deleted custom credentials routing changes.
- `clippy-last.log`, `fmt-last.log`, `biome-last.log`: clean. Earlier clippy
  findings (borrow, test placement, unwraps) were corrected before these gates.

- `workspace-isolation.log`: **1037 passed / 0 failed / 7 ignored**. The one new
  test was subsequently moved unchanged from an inline module into
  `crates/omni-store/tests/credential_isolation.rs`; its final-location rerun is
  **1 passed** (`isolation-test.log`). PG early-return tests do not prove PG ran.
- The final release was built with incremental/debuginfo disabled and copied to
  `bin/rust-final` (`build-last.log`, exit 0).
- Final copied binary: `final-admin-routes.log`: **990 equal / 2 expected /
  0 failures**, including 135 credential comparisons and 38 client raw keys.
  `final-admin-auth.log`: **212 equal / 4 expected / 0 failures**.
  `final-surface.log`: **606 equal / 61 expected / 0 failures**.
  `final-run.log`: **all rows equal**, including four DB comparisons.
- `git diff --cached --check`: clean. Evidence occupies about 216 MB; drivers
  removed their disposable DB roots. No shared build caches or other worktrees
  were removed. Only A6 files are staged; progress.md, bun.lock and user specs
  remain outside this commit.
