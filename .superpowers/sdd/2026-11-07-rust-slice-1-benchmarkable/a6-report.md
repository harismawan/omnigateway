# A6 implementation report

## Final A6 acceptance update

Status: **complete for review**, subject to the documented D4 hand-off and known
differences below. This update supersedes the historical checkpoint statuses.
Final code commit: **fd40e48d** (following **4f580cd0**). Final gates execute
against fd40e48d; the subsequent report-only commit changes no runtime/test code.
The historical round-4 checkpoint below was written before the final identity
implementation and text-timestamp fix; its OPEN/PARTIAL entries are superseded by
this acceptance section and retained only to preserve the evidence chronology.

| Final requirement/finding | Commit | Test / evidence |
|---|---|---|
| Distinct UTF-16 endpoint identity, no alias to U+FFFD | fd40e48d | `identity-red.log` → `identity-green.log`; credential-identity driver disables each of three rows independently, then restarts with the other binary |
| Lone JSON provider/pin must not equal UTF-8 SQL replacement name | fd40e48d | exact sidecars recovered for provider/credentialId and refused in serves_target; compilation and existing routing suites; no separate frozen-binary provider/pin vector |
| Quota raw scalar projection and numeric NaN semantics | 4f580cd0 | `red-quota.log` → `green-health.log` |
| Text timestamp JS addition/comparison | fd40e48d | `red-timestamp.log` **14 equal / 1 failure** → `timestamp-green.log` **15 equal / 0 failures** |
| Unusual health cannot poison SQLite snapshot | 4f580cd0 | `red-health.log` boot refusal → credential-health GREEN; credential_isolation verifies independent updates |
| Restart cross-read, actual decrypted Authorization | 8ebaf1cc, fd40e48d | credential-crossread and credential-identity configurations in final admin-routes driver |
| Shared PG mutation format and toggle logs | d02bae94 | live-PG marker/container proof under `/tmp/opencode/a6-followup/`; rejecting-update trigger/log comparison |
| PostgreSQL gateway boot/routes/restart | D4 hand-off | intentionally deferred; store-level tests are not presented as HTTP coverage |

### Closed final findings

- **Exact routing identity:** Credential stores a non-serialized exact UTF-16
  endpoint sidecar; Target stores exact lone-surrogate endpoint/provider/pin
  sidecars. Both SQLite and PG readers recover them from lossless JSON before
  constructing the typed routing view. `serves_target` compares exact endpoint
  units and refuses a lone provider/pin against UTF-8 SQL provider/id columns.
  A genuine U+FFFD endpoint never aliases either lone surrogate. No sentinel
  names enter stored provider_data. Typed diagnostic serialization still renders
  lone strings as replacement characters; admin projections remain lossless.
- **Quota coercion:** health preserves raw SQL quota values while coercing the
  numeric burn operations. NaN stays NaN through Math.max semantics. A textual
  observedAt uses JS string concatenation for exhaustsAt; survives uses string
  comparison when both operands are strings, numeric coercion otherwise.
- **Health snapshot isolation:** 4f580cd0 isolates unrepresentable SQLite health
  rows without freezing unrelated credential/model updates. Admin health keeps
  fractional/text/null values exactly as TS's projection returns them.

### Final RED/GREEN

Evidence root `/tmp/opencode/a6-round4/`, both binaries copied outside checkout.
- `identity-red.log`: **59 equal / 4 failures**, including two independent Rust
  deadline failures when disabling either surrogate endpoint (replacement row
  previously served both); `identity-green.log`: **61 equal / 0 failures**.
  Three endpoint models are routed, each credential disabled with all three
  outcomes checked, then re-enabled and cross-implementation restarted.
- `red-timestamp.log` versus `timestamp-green.log`: text timestamp arithmetic
  regression; GREEN **15 equal / 0 failures**, including health boot isolation,
  fractional/text/null health rows, active/stale/rolled quota, text used/limit
  and text observedAt/resetsAt.
- Earlier health isolation RED/GREEN and shared live-PG tests remain documented
  below. PG HTTP/restart cross-read is **D4**, not claimed as tested here.

### Known differences / D4 scope

- Unrepresentable health rows are omitted from routing; their breaker contribution
  is lost rather than emulating arbitrary JS arithmetic. Other rows keep refreshing.
- SQLite quota rows containing nonnumeric text still may refuse snapshot refresh;
  the admin endpoint projects/coerces them. The text-quota driver inserts them after
  boot. This remains a malformed-config routing limitation beyond the requested
  health-row isolation, not a claim that every SQLite scalar boots successfully.
- PG uses INTEGER for failure counts, so the SQLite fractional/text-count fixture
  cannot be inserted there. D4 must wire backend selection in boot, auth/control,
  snapshot/miss and writer paths, then exercise all credential routes and both
  application restart directions against live PostgreSQL. A6's shared mutation
  live-PG proof remains valid and its container was stopped/removed.
- Existing early-refusal lone **model-name** divergence from A5 is unchanged.
  This increment fixes credential matching identity, not that accepted divergence.
- No full gateway PG integration is implied by compilation of PG identity readers.
- Driver deadlines remain measured from the routing poll step after mutation and
  DB dump, not from SQL commit. The driver dump retains A5's exclusions; separate
  run.ts compares completion/usage/health tables. Ciphertexts are compared by
  decrypting their columns rather than expecting randomized bytes to match.
- The identity driver uses one expected upstream secret for all three endpoints;
  isolation is established by disabling each row and checking all three route
  outcomes, not by secret differences. The independent restarted process must
  send the correct decrypted Authorization to obtain a successful upstream reply.

Focused touched-crate gate before the final workspace pass: **254 passed /
0 failed / 5 ignored** (`touched-final.log`). Early implementation clippy found
the obsolete row::json helper, which was removed after all callers moved to the
lossless credential read. A proposed extra provider/pin integration unit did not
compile (private router helper and absent tempfile dependency) and was removed;
it is not counted as behavioral evidence. The provider/pin limitation in the test
map above is intentional disclosure.

### Final gates at fd40e48d

Logs relative to `/tmp/opencode/a6-round4/`:

| Gate | Result | Log |
|---|---|---|
| Release build, no incremental/debuginfo | pass | build-acceptance.log |
| cargo test --workspace --no-fail-fast | **1039 passed / 0 failed / 7 ignored** | workspace-acceptance.log |
| clippy --workspace --all-targets -- -D warnings | clean | clippy-acceptance.log |
| cargo fmt --check | clean | fmt-acceptance.log |
| admin-routes | **1193 equal / 2 expected / 0 failures**, 38 raw client keys | acceptance-admin-routes.log |
| admin-auth | **212 equal / 4 expected / 0 failures** | acceptance-admin-auth.log |
| surface | **606 equal / 61 expected / 0 failures** | acceptance-surface.log |
| run.ts | **all rows equal** | acceptance-run.log |
| Biome driver check | clean | biome-acceptance.log |

All driver binaries are copies in `bin/`, outside checkout; hashes are recorded
in `binaries.sha256`. The release build began before the code commit, after the
final source edits; the checks run after the commit. Only the report changes
after these gates. No TS, bun.lock, progress.md, user specs or stash were staged.

## Round 4 checkpoint (base 8ebaf1cc): NOT complete for review

Evidence `/tmp/opencode/a6-round4/`. Exact lone-surrogate routing remains open;
the three-endpoint RED specified in round 3 is still the next identity task.
Do not mark A6 complete based on this checkpoint.

| Requirement | Change | Evidence |
|---|---|---|
| Unusual health rows do not stop SQLite snapshot publication | Separate routing health read isolates rows that cannot fit the typed routing representation; operator reads remain strict | `red-health.log`: 5 equal / 3 failures against frozen TS due to Rust boot refusal; `credential_isolation::unusual_health_never_blocks_other_snapshot_changes` verifies boot and refresh alongside a healthy row and credential disable |
| Health endpoint preserves quota SQL values | Raw quota JSON projection; numeric coercion for burn calculations, NaN-preserving remaining-budget arithmetic | `red-quota.log`: isolation-only binary 12 equal / 1 failure for text used/limit columns; final GREEN below |

Both rows above are implemented in **4f580cd0**. This is a verified partial
checkpoint, not the requested final acceptance commit.

### Cumulative requirement → commit → test map

| Requirement | Commit | Test/evidence |
|---|---|---|
| SQLite credential routes, encrypted API-key creation, guards, delete semantics | d2757acb | admin-routes credentials configuration; decrypted DB column comparison; no-secret scan |
| Shared SQLite/PG credential mutations | d02bae94 | credential_mutations integration test; explicit live-PG marker and container proof under a6-followup |
| Toggle logging after commit with provider | d02bae94 | rejecting UPDATE trigger plus exact TS/Rust log comparison |
| SQLite application restart cross-read in both directions | 8ebaf1cc | credential-crossread configuration; exact upstream Authorization assertion |
| Active/stale/rolled-over burn, fractional and text health projection | 8ebaf1cc | credential-health configuration, round3 RED/GREEN |
| Health-row snapshot isolation and raw quota text projection | 4f580cd0 | round4 red-health/red-quota/green-health; credential_isolation integration test |
| Exact lone-surrogate routing | OPEN | next RED detailed below; existing admin identity coverage does not establish routing identity |
| Full unusual quota JS coercion | PARTIAL | text used/limit covered; text timestamp addition outstanding |
| PG gateway HTTP/restart cross-read | D4 | live-PG store tests are not a substitute for the deferred gateway leg |

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

Concrete identity implementation touchpoints: `omni-store/src/models.rs:Target`
and `model_from_parts` (currently `omni_ir::js::parse_json` loses lone units),
`omni-store/src/credentials.rs:Credential/to_credential`, the PG equivalents in
`pg/rows.rs`, and `omni-router/src/filters.rs:serves_target`. Keep explicit
lossless sidecar identities instead of a sentinel string hidden in provider_data:
sentinels collide with real endpoint names and leak into operator views. Target
provider and credentialId also originate in JSON; credential provider/id columns
are already SQLite UTF-8 strings. Their comparison must reject a lone JSON name
rather than matching an actual replacement-character SQL name. Existing literals
construct these structs in router/store/core tests, so update their default
sidecar fields when introducing the representation.

Final copied-binary drivers at code commit 4f580cd0:
- `/tmp/opencode/a6-round4/admin-routes.log`: **1130 equal / 2 expected /
  0 failures**, 38 raw client keys; includes the two SQLite restart directions.
- `admin-auth.log`: **212 equal / 4 expected / 0 failures**.
- `surface.log`: **606 equal / 61 expected / 0 failures**.
- `run.log`: **all rows equal**.
- Binaries isolated outside the checkout; hashes in `binaries.sha256`.
The workspace/clippy/fmt final chain was started after 4f580cd0; results below.

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

## Fix round 1 — checkpoint, NOT complete for review

This section supersedes the earlier acceptance status and the treatment of I1/I2
as known differences. Both are defects under the operator ruling. Evidence root:
`/tmp/opencode/a6-fix1/`. Branch `feat/rust-migration-design`, base `b30a85c4`.

| Finding | Commit/status | Verification |
|---|---|---|
| I3: repeated steps overwrite comparisons | **52026a2a** | Reviewer enumeration retained in `duplicates-red.log`; strengthened full driver `unique-final.log`: **1249 equal / 2 expected / 0 failures**, 38 raw keys |
| I1: unusual health counter discards valid deadline/breaker | OPEN, reproduced | Reviewer `health.ts`, copied review binaries: `health-red.log`: **138 equal / 2 failures** |
| I2: malformed quota freezes unrelated publication | OPEN, reproduced | Reviewer `quota.ts`, copied review binaries: `quota-red.log`: **135 equal / 4 failures** |
| Mutation-ack deadline and creation-only bound | OPEN | Existing polling clock still starts too late |
| Explicit no-op/repeated-toggle timestamp assertions | OPEN | Near-now normalization is still insufficient |
| Frozen-oracle lone provider/pin versus U+FFFD | OPEN | Endpoint vectors do not cover these fields |

I3 materializes every configuration before replacing any `steps` factory, then
prefixes names with their occurrence index and asserts uniqueness before running.
This ordering matters: credential-crossread derives its setup by finding the
unprefixed creation step in credentials. The first attempt replaced factories
too early and removed that setup; it was corrected before commit. Both binaries
and expected-divergence lookup now use identical materialized steps. The green
run retains 56 more comparisons than the previous 1193; it exposed no additional
parity failures. `biome.log` records the driver formatting check.

### I1 investigation and precise next step

No I1 implementation change has been made at this checkpoint. The frozen reader
returns raw cells. Preserve these independent operations rather than replacing
the whole row or narrowing the counter:

- Deadline: `rateLimitedUntil !== null && rateLimitedUntil > now`.
- Open breaker: `now - (openedAt ?? now)` compared against the NaN-preserving
  capped exponential of `consecutiveFailures - threshold`; halfOpen always probes.
- Score: `1 / (1 + (consecutiveFailures ?? 0))`; text requires concatenation,
  not just numeric coercion.
- Hard failure: `consecutiveFailures + 1`; text concatenates in the opposite
  operand order from scoring. Success resets all four fields and uses strict
  comparison with the blank row to decide whether to write.

Next: port the reviewer's health insertion into the uniquely keyed permanent
driver, then extend active-deadline/open-breaker/probe routing vectors for
fractional, text, nullable, negative and huge cells. Run RED with the copied review
binaries. Replace the strict health representation with one preserving these
operations, deriving routing coercions at snapshot construction. Trace it through
`CredentialHealth`, router filters/score/breaker, dispatch overlay, both SQLite
health write paths (`update_health` and writer batch), and PG checked count binds.
Do not fix only the filter: that leaves scoring or completion persistence wrong.
The current isolation test must assert retained field behavior, not row omission.
NULL counter fixtures require checking schema constraints: the ordinary SQLite
column is NOT NULL; nullable deadline/openedAt fields can be tested directly.

After I1 is green and committed, implement I2 with permanent pre-boot/live quota
vectors and unrelated create/disable/delete pickup. Note that comparing two text
quota cells uses JS string comparison; coercing both to numbers alone is not full
`used >= limit` parity. Complete all three minors next, then run the final gates.

### Snapshot-reader audit and final D4 hand-off

SQLite `snapshot_reads` reads keys, credentials, health, models, quota and settings
in one transaction. Inspection found:

- `keys::read_key_entry` isolates row conversion failures, retaining an error
  entry for a usable hash or skipping an unaddressable hash.
- `credentials::list_routing` catches row conversion errors. Health currently
  does likewise but incorrectly loses valid fields (I1).
- `quota::list` propagates scalar conversion errors (I2).
- `models::list` retains target/strategy parse errors per model, but reads `id`
  strictly outside that boundary: a NULL/BLOB id can still fail the transaction.
  This additional whole-snapshot path is identified by inspection, not yet
  reproduced or fixed. Include it in the I2 follow-up.
- `settings::get` accepts non-text as defaults and normalizes parsed settings;
  its remaining propagated errors are query failures rather than scalar errors.

**D4 must implement equivalent PG row isolation while preserving usable per-field
health/quota semantics**, including boot and refresh with malformed unrelated
rows and credential mutation pickup. PG `rows::list_credentials` currently
collects conversion errors into a whole-read failure. Integer PG schema widths
do not remove malformed JSON/metadata isolation requirements. D4 also selects
PgStore via OMNI_DATABASE_URL throughout boot, auth/control, snapshots, miss reads
and writers, and runs credential HTTP routes plus same-database application
restart cross-read in both directions on live PostgreSQL. Prior PG mutation tests
remain store-level evidence, not PG HTTP evidence.

### Verification state

`build.log`: baseline release build passed with `CARGO_INCREMENTAL=0` and
`CARGO_PROFILE_RELEASE_DEBUG=0`. No final workspace/clippy/fmt or four-driver gate
is claimed for this incomplete round; those must run once on the final code.
Only I3 is implementation-complete. No health/quota fix is claimed by the green
driver, because its permanent regressions have not yet been added.

### Fix round 1 continuation — I1 checkpoint

I1 now preserves independent health cells. Unusual scalar rows retain raw cells
and precomputed numeric/score coercions in an Arc sidecar built during reads;
filtering/scoring performs no new conversion or allocation. Hard failure keeps
JS text concatenation, soft failure retains siblings, success clears the sidecar,
and SQLite direct/batched writes preserve raw cells. Dispatch's persistence
choice uses a full transition for unusual health (refresh logic untouched).
PostgreSQL writers refuse SQLite-only scalar sidecars rather than narrowing them.

Finding → commit → tests: I1 → this checkpoint commit → permanent five-case
credentials driver plus `unusual_sqlite_health_preserves_deadlines_breakers_and_probes`
and `unusual_health_arithmetic_and_raw_cells_survive_writes`.
Evidence `/tmp/opencode/a6-fix1/`:
- `health-permanent-red.log`: **162 equal / 10 failures** on baseline binaries.
- `health-permanent-green.log`: **167 equal / 0 failures**, fresh release copied
  to `/tmp/opencode/a6-fix1/rust-health`, frozen TS review binary.
- `health-tests.log`: **304 passed / 0 failed / 6 ignored** (store/router/core).
- `health-clippy.log`: scoped store/router/gateway all-target clippy clean before
  the final additional routing-vector test; not a final workspace gate.
- `health-build.log`: release build passed, incremental/debuginfo disabled.

Status: **NOT complete for review**. Next: I2 preboot/live quota REDs and raw
comparison semantics, then NULL/BLOB model-id isolation, then all three minors.
Run final workspace/clippy/fmt and four freshly built copied-binary drivers only
after those changes. No final gate claim here. Ordinary schema disallows NULL
failure counts; NULL opened/deadline and text/negative/huge counters are covered.

### I2 checkpoint

I1 commit: `a6f9f0e9`. I2 → this checkpoint commit →
`unusual_quota_keeps_publication_and_js_comparisons` and permanent preboot/live
credentials-driver quota fixtures. Quota numeric coercions happen during reads;
the string/string relational result is precomputed separately for routing.
`quota-permanent-red.log`: **4 equal / 82 cascading failures**, Rust fails boot
on pre-existing text usage. `quota-permanent-green.log`: **167 equal / 0 failures**,
fresh outside-checkout `rust-quota`. `quota-tests.log`: **257 passed / 0 failed /
5 ignored** (store/router/control). `quota-build.log`: release build passed.
Remaining: model-id isolation, three minors, final gates. Quota identity columns
remain strict; malformed scalar numeric columns no longer abort publication.

### Model-id checkpoint

I2 commit: `d12597e8`. Model-id snapshot isolation → this checkpoint commit →
`unaddressable_model_ids_do_not_abort_snapshot_publication`. Frozen
`sqlite/config.ts:65-75` retains raw IDs; null/blob Map identities cannot equal
request strings. Rust omits those unaddressable rows while retaining normal
models and subsequent live changes. `model-red.log` is a runtime snapshot error,
not a compile failure; `model-green.log`: **5 passed / 0 failed**.
Precise next step: three minors (ack-based deadline/precreated model, timestamp
invariants, lone provider/pin identity regressions), then final gates once.
