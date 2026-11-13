# A6 implementation report

## Round 4 checkpoint (base 8ebaf1cc): NOT complete for review

Evidence `/tmp/opencode/a6-round4/`. Exact lone-surrogate routing remains open;
the three-endpoint RED specified in round 3 is still the next identity task.
Do not mark A6 complete based on this checkpoint.

| Requirement | Change | Evidence |
|---|---|---|
| Unusual health rows do not stop SQLite snapshot publication | Separate routing health read isolates rows that cannot fit the typed routing representation; operator reads remain strict | `red-health.log`: 5 equal / 3 failures against frozen TS due to Rust boot refusal; `credential_isolation::unusual_health_never_blocks_other_snapshot_changes` verifies boot and refresh alongside a healthy row and credential disable |
| Health endpoint preserves quota SQL values | Raw quota JSON projection; numeric coercion for burn calculations, NaN-preserving remaining-budget arithmetic | `red-quota.log`: isolation-only binary 12 equal / 1 failure for text used/limit columns; final GREEN below |

Known limits: omitted health rows lose their breaker contribution rather than
reproducing arbitrary JS arithmetic during routing. This is per-row isolation,
not complete routing equivalence for corrupt rows. Quota numeric coercion covers
number/null/text inputs, but text observed_at still requires JS `+` concatenation
semantics in exhaustsAt; unusual quota rows can still poison snapshot reads.
The new regression uses text used/limit and ordinary numeric timestamps. PG
health snapshot isolation is not changed; D4 must apply the equivalent read path
when it wires the gateway. These are not hidden by the green cases.

D4 hand-off remains unchanged: select PgStore for boot/auth/control/snapshot/miss
and writer paths, then run credential HTTP routes and same-database application
restart cross-read in both directions. Prior actual live-PG mutation proof is
retained; no PG HTTP verification is claimed here.

Focused GREEN: `green-health.log` **13 equal / 0 failures**, including unusual
health rows present at boot, text/null health edits and text quota used/limit.
`store.log` **2 passed**, including live disable pickup despite an unreadable
health row. Clippy/fmt/Biome are clean (`clippy.log`, `fmt.log`,
`biome-final.log`). Final workspace and existing-driver gates follow after the
code checkpoint commit. Precise next task remains the distinct-surrogate routing
RED, followed by completing JS quota arithmetic for text timestamps.

## Round 3 checkpoint (base d02bae94): NOT complete-for-review

Evidence `/tmp/opencode/a6-round3/`. PostgreSQL gateway wiring is explicitly
deferred to **D4**, per the revised instruction. D4 must select PgStore from
OMNI_DATABASE_URL in boot, AdminAuth/control operations, snapshot build/refresh,
miss reads and completion writer selection. Then run these credential HTTP
routes and restart cross-read both directions on the live PG database. A6's
previous live-PG mutation test remains the actual PG coverage; no new HTTP PG
coverage is claimed and no D4 boot plumbing was added.

SQLite restart cross-read is now an explicit driver configuration:
`credential-crossread`. Each original implementation creates encrypted accounts
and a model, routes, stops cleanly, and launches the OTHER binary on the exact
same root/database. It authenticates again, reads metadata and routes. The
recording upstream requires the exact decrypted Bearer secret. Both restarted
process stdout/stderr streams are included in secret scans. This extends existing
green behavior; the initial cross-read-only run passed 125 comparisons and is
not claimed as implementation RED.

Health matrix includes active windows, exhausted/idle windows, negative ceiling,
unknown reset, rolled-over and stale readings, fractional arithmetic, and health
rows with fractional, text and null scalar columns. The fixture shares one fixed
set of observation times between binaries; no computed burn values are masked.
RED initially found a Rust boot refusal on fractional consecutive_failures;
`health-red.log`. The admin-focused fixture then inserts that row AFTER boot:
`health-red-http.log` demonstrates the HTTP mismatch independently. Admin health
now projects health columns without narrowing scalar types, preserving TS JSON.
This does not fix boot/refresher handling of unusual health scalar types.

Remaining exact-identity work: credential provider_data endpointId is still
serde-backed, and snapshot isolation omits a row containing lone surrogates.
Next RED should create distinct `\\ud800`, `\\udc00` and U+FFFD endpoints, create
three model targets and assert each selects only its matching credential before
and after restart. Carry exact UTF-16 on BOTH Target.endpoint_id and credential
endpoint identity; compare those in omni-router::filters::serves_target. Do not
map surrogate strings to U+FFFD or merely omit them. JSON-encoded provider/target
names also need exact comparison wherever SQL binding has not already converted
them to UTF-8. Broader quota scalar coercion and unusual-health boot isolation
remain open. Final gates for this checkpoint follow below.

Cross-read scope: the setup retains the same configured encryption key and root;
neither ciphertext nor metadata is rewritten between stopping the first process
and starting the second. Session tokens are newly minted after restart. The
upstream's exact Authorization assertion establishes decrypted secret use, rather
than inferring decryption merely from a successful metadata GET. This is SQLite
only. Health scalar fixtures are deliberately written after startup; they are
not evidence that either boot or routing refresh accepts those values.

Final checkpoint gates (copied binaries and SHA256 in `binaries.sha256`):
- Final health corpus against pre-fix Rust: **8 equal / 3 failures**, all three
  HTTP health answers (`health-red-final.log`). Final full admin driver:
  **1128 equal / 2 expected / 0 failures**, including both restart directions and
  all health projections (`admin-routes.log`).
- workspace **1038 passed / 0 failed / 7 ignored** (`workspace.log`).
- clippy `--workspace --all-targets -- -D warnings`, fmt, Biome all clean.
- admin-auth **212 equal / 4 expected / 0 failures**; surface **606 equal /
  61 expected / 0 failures**; run.ts **all rows equal**.
- No new PostgreSQL container in this round. Prior live-PG mutation proof remains
  in the follow-up evidence. D4 deferral is intentional, not a skipped PG pass.

Status remains **NOT complete-for-review**, principally because exact surrogate
routing is still unimplemented. Resume with its three-endpoint RED specified
above, then quota scalar coercion and snapshot health-row isolation if in scope.

## Follow-up: shared mutations and toggle logs (base d2757acb)

Evidence: `/tmp/opencode/a6-followup/`. A6 remains incomplete. This increment
extracts API-key create, metadata patch and delete into omni-store, with matching
PgStore methods. Field encryption is done inside both store create APIs; encoded
provider_data is passed unchanged. Empty patches do not touch updated_at. PG tier
values outside its INTEGER range are refused rather than truncated. SQLite control
now uses these APIs. Toggle logs follow successful SQL and include provider.

RED: `red-store.log` is a compile RED for absent shared APIs (not behavioral).
First live-PG run `pg-store.log` fails binding f64 to INTEGER tier; corrected to
checked i32. `pg-green.log` executes SQLite and live PostgreSQL create/decrypt,
patch, no-op, re-enable and delete/repeated-delete assertions, and prints an
explicit LIVE POSTGRES marker. Container `omni-a6-mutations-20261113` used
`postgres:17-alpine` on 127.0.0.1:18576; `pg-proof.txt` records image, mapped port,
stop and removal. These are real store legs, **not PG HTTP route coverage**.

`red-logs-final.log` compares the frozen TS binary against d2757acb: 134 equal /
1 failure, missing provider on all toggle lines and an extra line for a refused
SQL UPDATE. The driver now injects a rejecting trigger and compares credential
toggle lines alongside the existing A5 log categories.

### Precise remaining work

1. Wire Postgres through gateway boot, AdminAuth, ControlStore, snapshot source,
   miss reads and writer selection. Current `omni-gateway/src/lib.rs` opens SQLite
   at lines 321, 419, 432, 439; `admin_auth.rs` holds Arc<Mutex<SqliteStore>>;
   `omni-gateway-core/src/snapshot.rs` build/rebuild/refresher accept SQLite.
   D1's PgStore exists but no gateway backend selection uses it. The next RED
   should start the Rust gateway with OMNI_DATABASE_URL and require a credential
   route to read the same PG database that the TS gateway wrote. Do not count
   the new store test as fulfilling this route requirement.
2. Restart cross-read and route in both application directions on SQLite and PG.
3. Exact lone-surrogate routing identity: the prior omission-only isolation is
   still present and insufficient for this requirement.
4. Active/stale/rolled-over burn and unusual SQL scalar oracle matrix.

Final gates for this follow-up:
- workspace: **1038 passed / 0 failed / 7 ignored** (`workspace.log`). PG is
  exercised only by the explicitly configured live run above, not this count.
- clippy all targets `-D warnings`, fmt, Biome: clean (`clippy.log`,
  `fmt-final.log`, `biome-final.log`). Initial Biome formatting failure corrected.
- final unique-step log regression: **136 equal / 1 failure RED**
  (`red-unique.log`) → **137 equal / 0 failures GREEN** (`credential-final.log`).
- full admin-routes: **990 equal / 2 expected / 0 failures**; admin-auth:
  **212 equal / 4 expected / 0 failures**; surface: **606 equal / 61 expected /
  0 failures**; run.ts: **all rows equal**. Logs are named for each driver.
  Full admin-routes predates only the unique failed-update step name; that exact
  final step is covered by the credential-only rerun (two additional comparisons).
- both release binaries copied outside checkout to `bin/`, hashes recorded in
  `binaries.sha256`. No TS, bun.lock, progress.md, specs or stash changes staged.

Checkpoint for context handoff: shared store APIs and item 5 are green. Item 1's
PG HTTP integration and items 2–4 remain open. Begin with the PG boot RED described
above; do not mark A6 complete based on this checkpoint.

The failed-update step was given a unique name after discovering it otherwise
overwrote an earlier identical request in the driver's result map. Toggle log
comparison was unaffected, but the unique name additionally retains both HTTP/DB
comparisons. The final credential-only driver rerun covers that correction.

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
