# Fix round 3 — pins and limits logging committed; closure running
**NEXT STEP:** `e7e83f04` implements N1 pins/comment and minor (b); `b192499a` preserves allowlist-before-limits evaluation. Corrected binary copied to `/tmp/opencode/a8/fix3/rust`; manifest hashes updated. `closure-tests.log` and four `closure-*.log` drivers running; closure build/Clippy/fmt passed. Wait/read these results, tally counts, update manifest, replace this top block only on success. Earlier `final-admin-routes.log` failed frozen credential-crossread's 1-second visibility bound (20420 equal / 26 expected / 2 failures); final-admin-auth/surface/run passed before correction. All evidence for this round is in `/tmp/opencode/a8/fix3/`.
N1: `n1-observe.log` 9891 equal / 8 expected / 2 unpinned differences; `n1-green.log` 9891 / 10 / 0. Pair order frozen ["1",2], Rust [2,"1"]. 50,002-sample probe: both 200, 50,000 samples, truncated=true, no panic; SQL LIMIT omitted sample 50,002 on both, subsequent trim omitted sample 50,001 (id=2) frozen vs 50,000 (id="1") Rust. Full normalised exchanges pinned, no product comparator change beyond comment.
Minor (b): frozen counts per successful request summary=2, logs/usage/quota/history/login=1, logout=0; Rust now matches exactly on probe. `limits-red.log` has six missing-count assertions plus unbounded logs/usage fixture differences; fixture bounded to stable historic interval before green. `limits-green.log` 235 equal / 0 expected / 0 failures; both per-path count JSON files retained. No stored content logged.
Log rule: Rust logs no parser or input detail about a stored cell that the frozen gateway does not log in the same situation; sanitised Rust-only lines carry a fixed message plus table, column and row id.

## History — everything below
# Fix round 2 — complete for review
Evidence base: `/tmp/opencode/a8/fix2/` (all log paths below relative); verified code/driver commit `c42cbbff`, following observation commit `20be5c97`; subsequent report-only commit changes no executable source. A–C complete; inference logging is inherited, not an unresolved R3 defect.
| Finding | Fix commit(s) | Failed first → evidence |
|---|---|---|
| R1 quota identity joins | `30411500` | BLOB disclosure, 6 failures `r1-red.log`; green `r1-quota.log`, `r1-history.log` |
| R2 history total ordering | `1d692b74` | 3 failures (order/500), `r2-red.log`; green `r2-green.log`, adversarial test `r2-test.log` |
| R3 Rust-only stored parser logging | `ab409566`, `a95494b3`; PG value tests `298b071e`, `6e05646a` | Summary canary 1 failure `r3-red.log`; green `r3-green.log`, `r3-rest-admin.log`; later model/provider canaries had no failing-first run |
Producer disposition (paths below under `crates/`; S=omni-store/src, C=omni-control/src, G=omni-gateway/src):
| Column | Disposition / source |
|---|---|
| api_keys.model_allowlist | Converted StoredJson: S/keys.rs:265,493,513; S/pg/rows.rs:58,263; C/api.rs:114, keys.rs:509, admin_password.rs:147. Explicit inference wire text kept; client/operator logs sanitised. |
| credentials.provider_data | Converted: S/credentials.rs:230, pg/rows.rs:292; C/models.rs:60, api.rs:783. StoredJson Display or fixed isolation message. |
| virtual_models.targets | Converted: S/models.rs:210-225; C/models.rs:17. Sanitised Display; typed Target decode fixed reason. |
| settings.value / contained policies | No parser-error propagation: S/settings.rs:170, C/settings_value.rs:45 return defaults. |
| api_keys.limits / guardrail_policy | Limits discard diagnostics: S/keys.rs:13-19, pg/rows.rs:42,224; C/api.rs:127; fixed warning :170. Policy is text: S/keys.rs:362, pg/rows.rs:47,229. |
| request_logs.degradations / rtk_filters / encrypted body JSON | Fixed InvalidQuery S/logs.rs:202; defaults S/usage.rs:205, pg/usage.rs:281; .ok() S/logs.rs:204, pg/bodies.rs:240. |
Complete stored-parser-capable sink table, including investigated writer/boot candidates:
| Sink | Printed form / reachability |
|---|---|
| G/api.rs:160; admin_routes.rs:177; S/keys.rs:378 | StoreError Display (or Failure.message derived from it): fixed text + table/column/id, no parser detail. |
| S/credentials.rs:296,506; C/api.rs:170; G/dispatch.rs:323 | Fixed isolation/limits/publication text (id where present); no parser diagnostic. |
| G/server.rs:1278,1311; dispatch.rs:179 via finish.rs:179 | Inference GatewayError.message retains parser text; BOTH gateways log it (table below). |
| G/dispatch.rs:907 (also :179 on refresh failure) | Stored credential reread can fail; refresh.rs:53 replaces StoreError with fixed `credential persistence failed`. |
| S/writer/health.rs:403,486,500,504,522,536 | JoinError Display; Refused/UncertainCommit/Panicked strings; StoreError Display at :500,536. Health scalar/vocabulary readers have no JSON parser. |
| S/writer/pg_batch.rs:234; writer/task.rs:517,916,928; G/lib.rs:624 | Event-validation StoreError / checkpoint SQL error / batch StoreError / writer-close StoreError Display; no stored JSON parser on these paths. |
| G/main.rs:54,79,87 | Config / start String / signal IO Display. Start maps store errors through Display (lib.rs:323-339); snapshot isolates malformed JSON rows. Others cannot read cells. |
| Other inventory candidates | G/admin_routes.rs:166 JoinError; S/pg/mod.rs:189 and G/lib.rs:571 protocol errors; G/dispatch.rs:504 eligibility vocabulary, not ModelRowError. No parser detail. Full occurrence inventory: `r3-tracing-audit.txt`. |
Observation (distinct canary per path; response comparison and BOTH stdout/stderr scanned by driver):
| Inference path | Frozen log | Rust log | Response body, both |
|---|---|---|---|
| POST /v1/chat/completions | yes | yes | yes |
| POST /v1/messages/count_tokens | yes | yes | yes |
| GET /v1/models | yes | yes | yes |
Inherited behaviour: a key whose stored allowlist is invalid JSON makes every request with that key answer 500 quoting the parser's diagnostic of the stored value, and the same text is logged in both gateways (observed on these three inference paths). Pinned by `20be5c97`; initial observation passed, no failing-first run: `inference-observation.log` 221 equal / 0 failures; repeated with fresh binary in `closure-admin-routes/`.
Known differences: sort pair order on non-string sort cells; history order with non-numeric observedAt (requires hand-altered affinity); sanitised log lines on paths where frozen logs nothing; empty-413 `content-length` header. Broader operator malformed-id audit remains separate; PG covered by error-value unit tests, no live-PG driver.
Gates: `closure-tests.log` **1163 passed / 0 failed / 11 ignored / 161 groups**; `closure-clippy.log` workspace all-targets -D warnings passed; `closure-fmt.log` passed; `closure-build.log` fresh build passed. All Cargo commands used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0; test timeout 20 minutes.
Drivers: `closure-admin-routes.log` **20377 equal / 24 expected / 0 failures**, 38 keys; `closure-admin-auth.log` **212 / 4 / 0**, 116 tokens; `closure-surface.log` **620 / 61 / 0**; `closure-run.log` **47 passing rows, all equal**. All runs completed and results read; normal driver scratch teardown, run.ts scratch removed after recording.
Manifest: `manifest.json` records tested commit and SHA256 of frozen `/tmp/opencode/a8/ts` and fresh `rust-r1` (only copied Rust binary in fix2). Source edits this follow-up: driver only; excluded files, unrelated bun.lock/specs/stash untouched.

## History — everything below is superseded checkpoint evidence

### B follow-up sink trace (current observation)
| Sink under crates/ | Printed value; stored JSON reachability |
|---|---|
| omni-store/src/writer/health.rs:403 | JoinError Display, not StoreError (corrects earlier inventory). No stored JSON reader in worker health path. |
| omni-store/src/writer/health.rs:500,536 | StoreError Display from read_health/update_health (:419); health rows contain typed scalar/vocabulary fields, no JSON parse. StoredJson would format safely if introduced. |
| omni-store/src/writer/health.rs:486,504,522 | Refused/UncertainCommit/Panicked strings; database commit classification or mutation panic, not stored JSON diagnostics. |
| omni-store/src/writer/pg_batch.rs:234 | StoreError Display from apply(event); range/value validation of incoming log event, not stored JSON parse. read_row reads scalar fields. |
| omni-store/src/writer/task.rs:517 | rusqlite Error Display from PRAGMA wal_checkpoint, no cell JSON. |
| omni-store/src/writer/task.rs:916,928 | StoreError Display from SQLite/PG batch persistence; log/usage/health scalar readers and SQL operations, no JSON parser. |
| omni-gateway/src/lib.rs:624 | Writer::close StoreError Display; joins worker (task.rs:607-619), no stored JSON parser on worker path. |
| omni-gateway/src/main.rs:54,87 | Config error / signal-install IO error Display respectively; no database read. |
| omni-gateway/src/main.rs:79 | String from start; store/snapshot errors converted with Display at lib.rs:323-339. Stored JSON producers are isolated in snapshot or sanitised via StoredJson Display before this sink. |

Other error-bearing sinks were inventoried in r3-tracing-audit.txt: PG migration connection and gateway connection termination print protocol/transport errors; admin task failure prints JoinError; catalog warning prints fixed CatalogProblem fields; dispatch eligibility prints router vocabulary. Stored JSON-capable sinks are the inherited inference sinks, sanitised admin/auth sinks and store isolation warnings listed below. No additional product conversion found in B.

**NEXT STEP (current):** Item 1 disposition committed as `eef79df4`. Item 2 found an unresolved stored-allowlist parser leak through inference authentication: omni-store KeyRowError.message → omni-gateway-core/src/snapshot.rs:117 GatewayError.message → omni-gateway/src/server.rs:1278 (token count), :1311 (model listing), and finish.rs:179 → dispatch.rs:179 (request rejection). Preserve wire text, sanitise ONLY logged error. Add a stored-allowlist canary authenticated with its raw API key for all three inference paths; prove failing first. `dispatch.rs`, `omni-gateway-core`, and `omni-ir` are excluded from edits: do not change them without scope authorisation; investigate an allowed gateway-side logging boundary rather than losing wire detail. No implementation attempted for this newly discovered path. Finish remaining sink trace, then final closure. Do NOT mark complete. Older NEXT STEP paragraphs below are history.

Item 2 sink table so far (NOT complete; source-traced, no new runtime verification):
| Sink (under crates/) | Current formatting / status |
|---|---|
| omni-gateway/src/server.rs:1278,1311; dispatch.rs:179 via finish.rs:179 | **DEFECT:** GatewayError.message may contain explicit wire parser detail from KeyRowError. No redaction at these sinks. |
| omni-gateway/src/api.rs:160 | `%e`, StoreError Display sanitises StoredJson. |
| omni-gateway/src/admin_routes.rs:177 | `%e.message`, Failure contains sanitised StoreError Display or fixed error for audited stored JSON producers. |
| omni-store/src/keys.rs:378 | `%e`, StoreError Display. |
| omni-store/src/credentials.rs:296,506 | Fixed metadata/health unreadable messages; no error formatting. |
| omni-control/src/api.rs:170 | Id + fixed `api key limits unreadable`; parser discarded. |
| omni-store/src/writer/health.rs:403,500,536; writer/pg_batch.rs:234; writer/task.rs:517,916,928 | Inventory shows `%e` StoreError Display; full reachability audit pending. |
| omni-gateway/src/main.rs:54,79,87; lib.rs:624 | Inventory shows Display; full origin trace pending. |
| omni-gateway/src/dispatch.rs:504 | Resolved: reason is router filters' eligibility reason, not ModelRowError; omni-router/src/filters.rs:208-325 uses fixed vocabulary/capability/quota reasons. resolve.rs:53-95 consumes configured models or synthesises them, not model parse errors. |

No new tests/drivers run in this checkpoint; no manifest updated. Item 1 required no new product conversion. Item 2 is blocked on an actual remaining leak, not merely paperwork; item 3 unstarted. Existing earlier gate counts below are historical only.

Producer disposition (paths relative to `crates/`; line numbers observed in this checkout):
| Stored column | Disposition / error travel |
|---|---|
| api_keys.model_allowlist | Converted: omni-store/src/keys.rs:265,493,513 and pg/rows.rs:58,263; omni-control/src/api.rs:114, keys.rs:509, admin_password.rs:147. StoredJson Display/Debug sanitised; KeyRowError explicit wire parser text retained. Existing summary/operator canary coverage. |
| credentials.provider_data | Converted: omni-store/src/credentials.rs:230, pg/rows.rs:292; omni-control/src/models.rs:60, api.rs:783. Structured error or its Display; snapshot isolation fixed message. Existing operator canary. |
| virtual_models.targets | Converted: omni-store/src/models.rs:210-225, omni-control/src/models.rs:17. Structured Display in String reason; typed Target decode uses fixed reason. Existing operator canary. |
| settings.value (settings object) | No parser-error propagation: omni-store/src/settings.rs:170 returns defaults; omni-control/src/settings_value.rs:45 returns defaults. Guardrail/smart-router settings share this reader. |
| api_keys.limits | No parser-error propagation: omni-store/src/keys.rs:13-19 returns None, pg/rows.rs:42,224 shares reader; omni-control/src/api.rs:127-135 returns null and :170 logs only id + fixed `api key limits unreadable`; keys.rs:520 consumes Option. |
| api_keys.guardrail_policy | No JSON parser: omni-store/src/keys.rs:362 text reader, pg/rows.rs:47,229 typed text. Policy inside settings uses tolerant settings reader above. |
| request_logs.degradations | Fixed error: omni-store/src/logs.rs:197-202 discards parser detail for InvalidQuery; usage.rs:205 and pg/usage.rs:281 default on parse failure. |
| request_logs.rtk_filters | No parser-error propagation: omni-store/src/logs.rs:204 uses .ok() and filters/defaults. |
| encrypted body JSON | No parser-error propagation: omni-store/src/pg/bodies.rs:240 uses .ok()? after decrypting. from_slice calls in this file are crypto byte operations. |

Audit searched parse_error/parse_js/serde_json::from_str/from_slice plus parser aliases (`operator_json::parse`, `parse_json`). Other matches are request/query input, plugin manifests, generated catalog, tests or non-JSON vocabulary/URL parsing. No new conversion and therefore no new converted-column canary in item 1; prior canaries remain in admin-routes.ts:2747-2755 and captured-log scan :3083-3086. This item is source inspection, not a new driver run.

## Historical checkpoints (everything below)

**NEXT STEP (current, supersedes ALL older NEXT STEP paragraphs):** product HEAD `6e05646a`. Finish the settings/limits/policy parser disposition and canary coverage; finish the complete log-sink consumer trace using `/tmp/opencode/a8/fix2/r3-tracing-audit.txt`; then final-commit closure and manifest. Do not mark complete yet. R1/R2 accepted. Named remaining R3 producers converted in `a95494b3`; PostgreSQL error-value test `298b071e`, relocated for Clippy in `6e05646a`. No new dependency or excluded-file edits. Other agents' notes, bun.lock, untracked specs untouched.

Latest R3 conversions: key LIST errors (SQLite/PG) now reconstruct StoredJson; credential provider_data readers (SQLite/PG) now emit StoredJson; model targets store readers sanitise parse diagnostics via StoredJson Display and typed Target[] decode errors use fixed reason/id; control models list/put, control keys listing, control API account catalog parser use StoredJson Display. Existing String-return APIs retain only sanitised Display; operator failures remain generic INTERNAL. KeyRowError explicit wire text is retained. Full admin-routes after these conversions: `r3-rest-admin.log` **20359 equal / 24 expected / 0 failures**, 38 raw keys minted. New targets/provider_data canaries read via `/api/models` and `/api/credentials`, scanned in captured Rust stdout/stderr; existing summary/operator allowlist canaries retained. Raw exchanges/logs in `r3-rest-admin/`. No failing-first run was recorded for the new model/provider canaries; earlier summary RED remains evidence.

Debug hardened in `a95494b3`: ParserDetail private String has fixed-placeholder Debug, no Display implementation, explicit `into_wire_detail`. StoreError Display and Debug tested to omit canary while explicit wire extraction retains it. PG test tests these properties for allowlist/provider_data/targets error values; **no live PG request driver**. `r3-pg-value-test.log` passes. Existing snapshot_rows assertion updated for sanitised reason after workspace test caught old `not JSON` wording assertion; final repeat passed.

Latest observed gates: `r3-rest-tests.log` **1162 passed / 0 failed / 11 ignored / 161 groups** before PG value test; `final-tests.log` workspace passed after adding PG value test (counts not yet tallied). `r3-rest-clippy.log` workspace all-targets -D warnings passed after relocating test module. `final-clippy.log` is a FAILED earlier run (items_after_test_module), resolved by `6e05646a`, not passing closure evidence. `r3-rest-fmt.log` passed before PG test addition; repeat fmt required. All Cargo builds/tests/clippy used requested environment variables and >=15-minute test timeout. External binary `/tmp/opencode/a8/fix2/rust-r1` is the a95494b3 product build, not rebuilt after test-only commits. Only one copied binary retained in fix2. No final manifest; four-driver final-commit closure still required.

Log audit progress (NOT exhaustive consumer tracing): `r3-tracing-audit.txt` records every tracing occurrence in the three requested source trees. Store keys warning prints StoreError Display; credential metadata/health isolation warnings print fixed text only; control limits warning prints id plus fixed text; gateway auth prints StoreError Display, admin failure prints sanitised Failure.message for converted producers. Additional StoreError-capable sinks found: store writer/health.rs:403,500,536; writer/pg_batch.rs:234; writer/task.rs:517,916,928 — all `%e` Display. Health variant-specific reason branches 486/504/522 print Refused/UncertainCommit/Panicked reason strings, not StoredJson.detail. Gateway main boot and lib flush errors also use Display; dispatch candidate reason is String and requires final trace from model errors. PG migration connection debug prints postgres connection error. No source edits in dispatch/refresh. Remaining settings/logs/usage fallback and policy paths need definitive producer dispositions and requested canary probes before claiming class closure.

Everything below this paragraph is **historical checkpoint evidence**, including superseded NEXT STEP instructions and older not-converted lists.

**NEXT STEP (latest):** continue R3 from `ab409566`. New `StoreError::StoredJson { table, column, row_id, detail }` has sanitised Display; only explicit wire consumers should read detail. Session-key allowlist -> summary reproduction now passes its log canary. Full admin-routes passed after the partial conversion. Remaining work: convert other stored JSON producers below, add per-column request canaries, then final-commit closure (all Cargo gates and four drivers, fresh external binary, manifest). The older NEXT STEP paragraph below is historical; its claim that R3 is entirely unfixed is superseded here. Do not pursue the deferred identity audit.

R3 partial finding -> commit -> failed first -> evidence: `ab409566`; `r3-red.log` 208 equal / 0 expected / 1 failure, captured stdout contains storedAllowlistSecretCanary from summary; `r3-green.log` passed initial summary reproduction. Expanded client summary scenarios also request operator `/api/keys` with that canary. Full `r3-admin-routes.log`: **20347 equal / 24 expected / 0 failures**, 38 raw keys minted; full exchanges/stdout/stderr retained in `r3-admin-routes/`. `r3-admin-auth.log`: **212 equal / 4 expected / 0 failures**, 116 tokens. All paths under `/tmp/opencode/a8/fix2/`.

R3 producers converted:
- `omni-control/src/admin_password.rs`: session allowlist validation -> StoredJson.
- `omni-store/src/keys.rs`: parse_allowlist and get_operator -> StoredJson. The allowlist_parse_error helper and KeyRowError wire message remain verbatim; existing auth comparisons pass.
- `omni-store/src/pg/rows.rs`: get_operator_key -> StoredJson; to_key_entry explicitly extracts StoredJson.detail for wire auth refusal. Shared parse_allowlist uses new variant. No live Postgres canary run; SQLite request fixtures cover the converted column, not the PostgreSQL execution path.
- `omni-control/src/api.rs`: key_rows and read-own-key allowlist parses -> StoredJson -> Failure's Display string.

R3 producers NOT CONVERTED (audit incomplete, not a claim they require wider changes):
- `omni-store/src/keys.rs` list and `pg/rows.rs` list_keys reconstruct Corrupt(e.message); need trace list consumers and preserve key refusal semantics.
- `omni-store/src/credentials.rs:229`, `pg/rows.rs` to_credential: parse_js still maps to Corrupt; wire/log consumers not traced.
- `omni-store/src/models.rs:210–216`: serde diagnostic and parse_js String errors; consumers not fully traced.
- `omni-control/src/models.rs:17,51`: String error propagation; need typed stored error conversion and route canaries for targets/provider_data.
- `omni-control/src/api.rs` remaining parse_stored is used by credential provider_data projection; not converted, needs id retained and provider_data canary request.
- `omni-control/src/keys.rs:509`: operator allowlist parser in String result; CLI/wire consumers not traced.
- Settings/logs/usage parsers found with fallback behavior (`settings.rs:170`, logs.rs, usage.rs, pg/usage.rs, pg/bodies.rs); no conversion yet, audit propagation fully before disposition.
- Existing shared control credentials parser remains sanitised by `19e6cc27`.

R3 log sinks checked: gateway `api.rs:160` uses `%e` (StoreError Display); gateway `admin_routes.rs:177` logs `%e.message` (Failure::internal copies Display, generic INTERNAL wire); store `keys.rs:375` logs `%e` for skipped hashless row. None of these reads StoredJson.detail. Remaining tracing sinks, including writer/health and refresh consumers, are not yet fully audited. Derived Debug still includes detail; audit must ensure sinks never use Debug for this variant.

Observed gates on the source subsequently committed as `ab409566`: `r3-tests.log` **1162 passed, 0 failed, 11 ignored, 161 groups**; `r3-clippy.log` full workspace all-targets -D warnings passed; `r3-fmt.log` passed; `r3-test.log` new Display canary unit test passed; `r3-build.log` gateway build passed. All Cargo commands used the three requested environment settings. External `/tmp/opencode/a8/fix2/rust-r1` now contains this partial R3 build. These runs preceded the commit and are NOT final closure; surface/run.ts and manifest pending. Known differences remain those below plus remaining unsanitised stored JSON paths. Scratch teardown completed for successful drivers.

**NEXT STEP:** R3 first, then full closure. Do NOT pursue the broader operator identity audit below: it is a separate roadmap item. R2 is committed in `1d692b74`; both reviewer fixtures now pin full exchanges and Rust logs are checked for panic lines. R3 is UNFIXED: start at `admin_password.rs:146–149` (session allowlist parse error -> StoreError::Corrupt -> gateway api.rs auth logging), then trace every site listed below through wire/log consumers before changing messages. `keys.rs:291` deliberately supplies verbatim wire auth refusal text; do not globally redact that helper. `omni-control/src/models.rs:17,51` propagate parser strings via Result<_, String>; consumers not yet traced. Add stored canaries per changed site and preserve operator wire comparisons. Then run workspace tests (timeout >=15 minutes), Clippy all targets, fmt, fresh build and all four drivers, and write `/tmp/opencode/a8/fix2/manifest.json`. No full closure or manifest exists for this checkpoint. External binary `/tmp/opencode/a8/fix2/rust-r1` was overwritten with the R2 build (despite its historical name); only one copied Rust binary was kept in fix2.

| Finding | Commit | Failed first | Evidence under `/tmp/opencode/a8/fix2/` |
|---|---|---|---|
| R1 quota joins fixed; wider audit deferred | `30411500` | 6078 equal / 6 expected / 6 failures, BLOB rows disclosed | `r1-red.log`; GREEN `r1-quota.log` 6081 equal / 6 expected, `r1-history.log` 9887 equal / 6 expected, zero failures |
| R2 fixed | `1d692b74` | Ported fixtures: 9889 equal / 6 expected / 3 failures (five-row order mismatch; 22-row 500 and status assertion) | `r2-red.log`, full exchanges/logs in `r2-red/`; GREEN `r2-green.log` 9889 equal / 8 expected / 0 failures, `r2-quota.log` 6081 equal / 6 expected / 0 failures |
| R3 | pending | review summary canary disclosure | `/tmp/opencode/a8-review/fix-canary2/` |

R1 semantics: independent BLOB reads never join; text matches only text; INTEGER/REAL compare as JS numbers with SameValueZero (including ±0 and NaN); NULL matches NULL; reverse lookup reproduces Map's last entry on duplicate primitive keys. Bun SQLite probe `r1-map-semantics.log` observes numeric 1 vs text "1" distinct, ±0 equal, bound NaN stored as NULL, BLOB objects distinct. Rust `map_id_primitives_and_object_identity` passed (`r1-test.log`); synthetic NaN tested there, not claimed as a readable SQLite NaN cell. Fresh external binary `/tmp/opencode/a8/fix2/rust-r1`, build `r1-build.log`, all requested Cargo environment settings. No full workspace gate this increment.

R1 audit so far (not exhaustive, no universal parity claim):
- `client_quota.rs` history/live account joins: structural BLOB equality fixed above. Other client summary/logs/usage paths use session-derived SQL scope, not these in-memory account joins.
- `catalog.rs:choice`, `api.rs:852–861` static ids/public model grouping: string keys or generated catalog values; BLOB/numeric raw cells do not enter those comparators as keys. `public_rows` validates JSON catalog entries; deeper verification still needed.
- `models.rs:31,77,105–138` model id / credential pin / provider / auth membership: Rust `models::operator_credentials` uses strict String reads (`omni-store/src/models.rs:35–43`), and model ids use `row::opt_text` (`models.rs:140–150`). BLOB or numeric storage cells fail before matching; frozen strict equality would not match a string request/target to those cells. This is a possible whole-request-vs-no-match difference, NOT yet reproduced; fixing requires widening operator read carriers and validating downstream projections, not just changing one equality.
- `models.rs:94–99,124` grandfathered target pairs deliberately stringify JSON provider/model, rather than comparing raw row identities. `keys.rs:429` matches projected key id to request string; store/projection behavior for malformed ids remains to audit.
- `credentials.rs:189–205` health last-used lookup reads projected ids then queries SQL; `sql_value` turns BLOB into text. Potential malformed-id behavior requires comparison with frozen health/readOwnKey code; no fix or equality claim yet.
- Further client/operator matches and store/auth paths need examination; grep results are starting points, not a completed audit.

R2 evidence: `r2-test.log` has one passing 8,192-row adversarial test (NaN, infinities, signed zero, null, text, integer, BLOB, equal keys; both raw/history key compositions, sortedness and permutation). `r2-clippy.log` targeted omni-control all-targets Clippy passed; `r2-fmt.log` workspace format check passed. `r2-build.log` fresh gateway build passed. All Cargo commands used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0. Both driver runs completed and results were read. `r2-observe/` records full exchanges used to pin orders. Comparators now use collation/lexicographic total preorders and numeric classes with all NaNs equal and last; stable sorting preserves ties. Raw pre-sort separates numeric and string primitive classes to avoid mixed-coercion cycles. Malformed mixed-type raw keys have no independent differential order fixture yet; no universal malformed-schema byte parity claim.

R3 site dispositions (no R3 code changes in this checkpoint):
- `admin_password.rs:147`: **not traced** to every consumer; summary log path confirmed by prior review, still unfixed.
- `omni-store/src/keys.rs:291,379,490`: **not traced**; 291/379 intentionally preserve auth refusal wire parse text; 490 not traced.
- `omni-store/src/pg/rows.rs:72,251`: **not traced**.
- `omni-store/src/models.rs:214`: **not traced**.
- `omni-control/src/models.rs:17,51`: **not traced**; parser text propagated in String errors.
- Settings/policies/limits and other stored JSON parsers: **not traced**, broader search still required.
- Previously fixed `omni-control/src/credentials.rs` shared metadata parser: **sanitised**, commit `19e6cc27`; fixed reason plus credential id, existing canary checks retained.

Known differences: sort pair order on non-string sort cells; history order with non-numeric observedAt (hand-altered column affinity), pinned twice with Rust 200 and no panic line; sanitised metadata log lines which frozen does not emit; empty-413 content-length header. R3 stored JSON log leakage remains an unresolved defect. Shared metadata error log is **fixed reason plus the credential id**; the id is an accepted operator-visible identifier. Grouped-rule unit test shares production key extraction and collation with its all-pairs evaluation: it verifies grouping, not independent JS coercion; differential cases check coercion. Successful drivers completed normal scratch teardown. Excluded local work untouched. Full workspace gates, four-driver closure and manifest are pending; only the targeted counts above were observed this checkpoint.

---

# Fix round 1 — historical completion before re-review

I2 rule: fail with generic 500 iff some ordered pair of distinct projected rows would throw under the frozen left-to-right comparator. Validate equal-prefix groups in O(n log n), requiring only reached receivers to be strings and using JS argument coercion; otherwise use stable sorting with the same field ordering. History's fourth key is numeric subtraction: non-numeric observedAt produces NaN, treated as equal without throwing (frozen `clientHistory.ts:128`).

Properties/evidence: (a) empty and singleton comparisons pass; (b) differing providers protect malformed labels (`sort short circuit`); (c) reached receiver failures agree, including the observed eight-row arrangement; (d) successful singleton/short-circuit/populated/UTF-8/overflow fixtures compare byte-equal; (e) three-row and five-row argument-only arrangements are pinned divergences. `grouped_rule_equals_all_ordered_pairs` checks the grouped rejection predicate against brute-force ordered pairs for 9,000 deterministic random arrays of sizes 0–8, including coerced BLOB/null/numeric arguments and canonically equivalent Unicode strings. This proves the tested predicate cases, not a universal byte-equivalence theorem for malformed numeric comparator inputs.

Per route, the original 18 RED failures represented 9 distinct exchanges counted twice (comparison plus status): 6 exchanges now equal (singleton/short-circuit × three clients), 3 become documented divergences. Final seven sort arrangements × three clients give 15 equal and 6 documented-divergence exchanges per route, plus 35 equal unauthorized exchanges. Larger five-row TS success and eight-row TS failure were observed in `i2-observe-{quota,history}.log` before pinning. Across both routes there are 12 pinned divergences. Concrete example: `(id,provider,label)` rows `(0,b,BLOB 3132),(1,a,x),(2,b,x)` yield frozen 200 in order `[1,0,2]`, with BLOB label `{"0":49,"1":50}`; Rust gives generic 500 INTERNAL. Driver pins complete headers/status/body for both sides with reason `sort pair order (documented difference)`. Exact-cap probes remain reviewer evidence, not added this round.

| Finding | Commit | Failed first | Evidence under `/tmp/opencode/a8/fix1/` |
|---|---|---|---|
| I1 fixed | `19e6cc27` | log canary: 2886 equal / 1 failure | `i1-red.log`; GREEN `i1-quota.log` 2887 equal, `i1-history.log` 3621 equal, zero failures |
| I3 fixed | `21c8ed8c` | 5527 equal / 864 failures | `i3-red.log`; GREEN `i3-quota.log` 5959 equal, `i3-history.log` 9765 equal, zero failures |
| I2 accepted rule implemented | RED `e55be7ae`, fix `91451272` | singleton, short-circuit and three-row argument-only cases | RED `i2-red.log` / `i2-history-red.log`: 18 failures each; GREEN `i2-quota.log`: 6065 equal / 6 expected; `i2-history.log`: 9871 equal / 6 expected; zero failures |

I1 shared parser now carries only fixed reason and credential id, never the stored provider_data or parser error. Both syntactically invalid canary and valid array containing it are covered, with response and stdout/stderr secret scans. Grep found two direct shared-parser callers: client whole-list validation and operator `rows`. The latter serves list, health, patch lookups and create validation/result paths; they inherit the sanitization. Generic 500 wire response remains equal; Rust still logs its sanitized reason whereas frozen TS does not log that failure.

I3 uses existing `js::own_cell` in credential identity, quota-window and quota-sample readers. Both routes compare invalid/truncated/overlong UTF-8 and embedded NUL in label/provider/id/window_type. BLOB identity is preserved. No product TypeScript/dependency/unsafe changes.

Closure on `91451272`: workspace tests 1159 passed, 0 failed, 11 ignored, 161 groups (`final-tests.log`); workspace Clippy all targets -D warnings passed (`final-clippy.log`); fmt passed (`final-fmt.log`). All three requested Cargo environment variables used. Fresh build `final-build.log`, external binary `rust-final`; final `/tmp/opencode/a8/fix1/manifest.json` records commit and both SHA256 values. Admin-routes: 20301 equal / 22 expected / 0 failures (`final-admin-routes.log`); admin-auth: 212 equal / 4 expected / 0 failures, 116 tokens (`final-admin-auth.log`); surface: 620 equal / 61 expected / 0 failures (`final-surface.log`); run.ts: 64 passing rows, all equal (`final-run.log`). All runs waited for and read; drivers remove scratch on teardown.

Known differences: an operator could see the sort difference only with credential or quota sort cells that are not strings, which the gateway itself never writes: a throwing ordered pair exists but the frozen engine never visits it in that direction, so TS returns 200 and Rust 500. Rust still emits the sanitized metadata error log; accepted empty-413 framing difference remains. Documentation correction: logs projection is 20 fields; final pre-review targeted summary counts were 207 each and logs 429 (reviewer's rerun); older counts below are historical fixture versions. No new claim about other edge cases.

---

# Previous completion checkpoint (superseded by review findings above)

All seven routes implemented; full closure passed. History implementation/fixture: `670bc8f4`. Product TypeScript untouched; no dependencies, unsafe, subagents, pushes or merges. External concurrent documentation commits and excluded local files were left alone.

| Route | Commits | Targeted equal / failures | Failed first |
|---|---|---|---|
| login | `b4d8ffe1` | 39 / 0 | 34 failures, 404 |
| logout | `6861c046`, `bbc20d35` | 21 / 0 | 12 failures, 404 |
| summary | `2493a8a9` | 207 / 0 each | Rust 404 |
| logs | `b5973bb3`, `20cddcbc` | 429 / 0 | 368 failures; malformed-degradation RED 6 |
| usage | `1d84ed0f`, `43263a90`, `327f240f` | 487 / 0 | 422 failures, 404 |
| quota | `f95b99b9`, `9cbd3b8c` | 2887 / 0 | 578 failures; malformed metadata RED below |
| quota/history | `670bc8f4` | 3621 / 0 | 192 failures, 404 (`history-red.log`); duplicate-bound comparisons failed before last-value fix |

Summary isolation: verified-session id only; ignored identity attacks; B response bytes exclude A/C markers; shared caller matrix and post-login expiry.
Summary lane: `require_client` before bounded read-only report reader and all parsing/reads.
Logs isolation: explicit 20-field projection, removed excluded credential degradations, scoped foreign cursors/filters, B marker scans and complete paging.
Logs lane: `require_client` before bounded read-only report reader and all parsing/reads.
Usage isolation: scoped totals, B marker scans; allowed apiKey grouping stays scoped, credential grouping refused; all shared callers and expired key.
Usage lane: authorization first; bounded read-only reader, direct bucket writer.
Quota isolation: all shared callers × identity/encoded/duplicate/cursor attacks; orphan omitted, disabled included; every response scanned for three distinctive credential secrets.
Quota lane: authorization first; bounded read-only reader; identity metadata read excludes secret columns, whole-list metadata validation retained.
History isolation: same caller/attack matrix plus span edges/duplicates, malformed metadata/settings, orphan/disabled accounts, unusual numeric/BLOB cells, overflow and key expiry; every history response scans all three distinctive secrets.
History lane: authorization before query parsing or reader; bounded read-only lane, newest 50,001 rows → binary reorder → trim 50,000 → projection/locale sort.

Quota discloses exactly `{accounts:[{credentialId,label,provider,windowType,usedRatio,resetsAt,observedAt,windowMs,ratePerHourRatio,exhaustsAt,survives,stale,rolledOver}]}`.
History discloses exactly `{samples:[{credentialId,label,provider,windowType,observedAt,usedRatio,resetsAt,windowMs}],truncated}`. Both equal TS on the recorded fixtures: all clients see all named accounts, including disabled credentials; orphans disappear. Raw used/limit/rate counts and secrets are absent; exact ratios can reveal ceilings. History's flag is one top-level boolean. No gateway-wide traffic rate is disclosed.

Memory: at most 50,001 raw sample rows, 50,000 sort descriptors, metadata and output buffer; projected JSON held one row at a time. Full fixture process VmHWM: Rust 105136 kB, TS 141472 kB (not an isolated request allocation measurement), `final/admin-routes/client-history-{rust,ts}-rss.txt`.

Known differences: accepted empty-413 content-length framing difference remains. No new client response difference observed. Existing non-client expected divergences remain in closure driver logs. Coverage is fixture-based, not proof over every malformed SQLite cell. Limits: neither gateway has a login attempt limiter; day boundary fixed at boot in both.

All evidence below is under `/tmp/opencode/a8/`; results were waited for and read. Cargo used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0.

| Gate | Result | Log |
|---|---|---|
| workspace tests | 1158 passed, 0 failed, 11 ignored; 161 groups | `history-workspace-tests.log` |
| workspace Clippy all targets -D warnings | pass | `history-workspace-clippy.log` |
| workspace fmt check | pass | `history-workspace-fmt.log` |
| fresh build / targeted history | 3621 equal, 0 failures | `history-build.log`, `history-green.log` |
| admin-routes | 10873 equal, 10 expected, 0 failures | `final/admin-routes.log` |
| admin-auth | 212 equal, 4 expected, 0 failures; 116 tokens | `final/admin-auth.log` |
| surface | 620 equal, 61 expected, 0 failures (quota checkpoint: 618 equal) | `final/surface.log` |
| run.ts | 64 pass rows, all equal | `final/run.log` |

Manifest: `/tmp/opencode/a8/final/manifest.json`, implementation commit `670bc8f4`, external binary `/tmp/opencode/a8/final/rust`, Rust SHA256 `b3d92914c6827cb50c29f26c4bc69b8743fc2b6ee91f621286128506786d26d1`; TS `/tmp/opencode/a8/ts`, SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. Drivers remove scratch on success; retained files are evidence. Initial fixture used future samples and an absolute backward clock; corrected to retained samples without changing the login clock. Initial compile used unsupported usize SQL binding; fixed before GREEN.

D4 must wire authenticated client report readers to Postgres: session-derived key scope for summary/logs/usage, explicit projections, lossless metadata validation/coercion, quota-window and bounded quota-sample reads, inclusive span/clamp/settings semantics, newest-first cap then binary reorder and page trim, ICU locale output ordering and single top-level truncated. Preserve authorization-before-read and bounded lane ownership.

---

# Previous checkpoint — partial: malformed quota gap closed; history RED recorded

**NEXT STEP (2026-11-14, malformed-quota checkpoint):** implement `/api/client/quota/history`. Item 1 is committed as `9cbd3b8c`; targeted GREEN is 2887 equal / 0 failures. A new `client-history` configuration and movable-clock enablement now record RED: 101 equal / 192 failures, Rust 404 (`/tmp/opencode/a8/history-red.log`). The fixture currently covers only empty history and shared callers/identity attacks: extend it with >50001 samples, orphan/disabled accounts, unusual cells, malformed credentials/settings, secret scans and expiration after login. Frozen `clientHistory.ts` (132 lines) and `history.ts` lines 1–150 have been read: **the actual wire result has a single top-level boolean `truncated`, NOT a per-series flag**, despite stale comments/request wording. `pageSamples` trims the store-reordered 50001 rows to 50000. Store `listQuotaSamples` first selects newest by observed_at DESC LIMIT 50001, then JS binary-id/window ordering and observed_at subtraction; read credentials.ts lines 530 onward for the rest. `retainedSpan` reads settings, clamps since to max(now-retentionDays*DAY, now-16*DAY), until to now; use frozen optionalNumber semantics (inspect schemas.ts). Reuse `credentials::validate_client_metadata` for whole-list parse failures, added in item 1. Authorize before reader/parsing; direct sample writer, bounded report lane; surface expectation still pending. Then run full closure and write final manifest. No subagents.

## This session's completed increment

| Item | Commit / result | Evidence |
|---|---|---|
| malformed quota credentials | `9cbd3b8c`; 2887 equal, 0 failures | `/tmp/opencode/a8/quota-malformed-green.log` |
| malformed quota RED | 2467 equal, 144 failures (36 real invalid-JSON differences plus expected-status failures from the initial incorrect malformed-settings assumption) | `/tmp/opencode/a8/quota-malformed-red.log` |
| history | RED only; 101 equal, 192 failures | `/tmp/opencode/a8/history-red.log` |
| targeted omni-control tests | 22 passed, 0 failed | `/tmp/opencode/a8/quota-malformed-tests.log` |
| control + gateway Clippy all targets -D warnings | pass | `/tmp/opencode/a8/quota-malformed-clippy.log` |
| workspace fmt check | pass | `/tmp/opencode/a8/quota-malformed-fmt.log` |

Item 1 outcomes (status AND response bytes compared): invalid provider_data JSON among valid credentials → 500 INTERNAL/internal error; valid JSON array/null/number → 200; number stored in TEXT label/provider → 200; BLOB or NULL label/provider → 500; malformed settings JSON → 200 fallback. NULL cases use a fixture-only nullable replacement table because production schema rejects NULL. Existing operator provider-data parser was extracted and reused; metadata validation opens only provider_data, never secret columns. No other implemented client route lists credentials. Quota continues to disclose exactly the fields listed below, identically to TS; all callers and all response bytes/headers in all malformed phases were checked for the three distinctive credential secrets, with zero leaks. Authorization/lane placement unchanged.

Fresh external binary `/tmp/opencode/a8/rust-quota-malformed`: SHA256 `1d874fdd6e8b40f7785092d3ceea50df1cf73bd0be29f306a5153cb7df6536a7`; TS `/tmp/opencode/a8/ts`: SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. Built with all three required Cargo environment settings (`quota-malformed-build.log`). No final manifest or full closure claimed. Initial history fixture run failed because clock enablement was missing; corrected before recorded RED. Build artifact is `target/debug/omnigateway`, not `omni-gateway`.

Known differences/limits: the prior invalid-JSON quota gap is CLOSED on the compared cases. Accepted empty-413 content-length difference remains; no new quota difference observed. History remains unimplemented; no per-series flag exists in frozen history's actual response. No login attempt limiter in either gateway; day boundary fixed at boot in both. D4 obligations below still apply. `bench-matrix-report.md` changed externally during this session and was left untouched, along with bun.lock and all other excluded work.

---

# Previous checkpoint (historical; open quota item below is now closed)

**NEXT STEP (quota checkpoint, 2026-11-14):** implement GET `/api/client/quota/history` with a failing comparison first. Read frozen `clientHistory.ts` and `history.ts` (retainedSpan, sample query cap, pageSamples, per-series truncated), then `listQuotaSamples`. Authorize before parsing/opening the bounded reader; write samples directly without a value tree. Extend the shared fixture clock to the history configuration, include limit overflow affecting only some series, orphan/disabled accounts, unusual cells, all callers and the distinctive credential-secret scan. Then run the full closure drivers and write `/tmp/opencode/a8/final/manifest.json`; that final manifest and full closure are NOT done. Existing history below is preserved. No subagents.

## Latest checkpoint

| Route | Commits | Comparisons | Failed first |
|---|---|---|---|
| login | `b4d8ffe1` | 39 equal / 0 failures | 34 failures, 404 |
| logout | `6861c046` | 21 equal / 0 failures | 12 failures, 404 |
| summary | `2493a8a9` | 183 equal / 0 failures | Rust 404 |
| logs | `b5973bb3`, `20cddcbc` | 379 equal / 0 failures | 368 failures, then malformed-degradation RED 6 |
| usage | `1d84ed0f`, `43263a90`, `327f240f` | 487 equal / 0 failures | 422 failures, 404 |
| quota | `f95b99b9` | 775 equal / 0 failures | 294 equal / 578 failures, Rust 404 |
| quota/history | pending | none | not run |

Quota disclosure equals TS on the compared fixtures: `{accounts:[...]}` contains exactly credentialId, label, provider, windowType, usedRatio, resetsAt, observedAt, windowMs, ratePerHourRatio, exhaustsAt, survives, stale, rolledOver, in that order. Every valid client sees all named accounts, including disabled accounts; orphan windows disappear. Raw used/limit counts, raw rate, and secrets are absent. Exact fractions can reveal ceilings; this is intentional frozen behavior, not a secrecy claim. History disclosure is NOT implemented or verified.

Quota isolation: shared A/B/C, operator, viewer, anonymous, revoked and genuinely expired-session callers × twelve identity/cursor/duplicate/encoded parameter attacks × empty/populated/unusual/observed-cell phases. Expired-after-login C also gets 401. All response headers/body bytes scanned for `quota-distinct-access-token`, `quota-distinct-refresh-token`, `quota-distinct-api-key`; zero leaks. Explicit field-list/orphan/disabled assertions pass.
Quota lane: `require_client` precedes `app.control.reader()` and all DB reads; only the bounded read-only report lane runs the operation. New store reads select identity metadata and raw quota cells, never secret columns. Existing ICU root comparison matches tested labels é/E/e/Z/ä/A/a/Å/中; no new dependency.

Summary isolation: verified-session id only, ignored URL identities; B responses scanned for A/C markers; shared fixture/caller coverage described below.
Summary lane: authorizes before opening the bounded read-only report reader.

Logs isolation: explicit 19-field projection, scoped cursors and filters, B byte scans and complete paging described below.
Logs lane: authorizes before opening the bounded read-only report reader.

Usage isolation: scoped bucket totals and B byte scans, allowed apiKey grouping and refused credential grouping described below.
Usage lane: authorizes before opening the bounded reader; direct bucket writer.

History isolation/lane: pending; no evidence claimed.

### Latest verification (results read)

All logs under `/tmp/opencode/a8/`; Cargo used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0.

| Gate | Result | Log |
|---|---|---|
| quota RED | 294 equal / 578 failures | `quota-red.log` |
| quota GREEN, fresh external binary | 775 equal / 0 failures | `quota-green.log` |
| workspace tests | 1158 passed / 0 failed / 11 ignored, 161 result groups | `quota-tests.log` |
| workspace Clippy all targets -D warnings | pass | `quota-clippy.log` |
| workspace fmt check | pass | `quota-fmt.log` |
| fresh gateway build | pass | `quota-build.log` |
| surface | 618 equal / 61 expected divergences / 0 failures | `quota-surface.log` |

`quota-manifest.json` records commit `f95b99b9` and SHA256 of `/tmp/opencode/a8/rust-quota` and unchanged `/tmp/opencode/a8/ts`. Final manifest is deliberately not claimed. Full admin-routes/admin-auth/run.ts have not been rerun for this increment; previous evidence below applies to the previous binary. First workspace test build was terminated at the tool's 120-second deadline; rerun with 600 seconds completed successfully. Initial fixture attempts assumed an array rather than `{accounts}` and tried NULL in NOT NULL `used`; corrected before RED. Initial compile needed an explicit text-cell helper; Clippy required NaN-aware positive comparisons. All corrected before final GREEN.

Known differences/limits: accepted empty-413 content-length difference remains. No new response difference observed in quota comparisons. Code-inspection difference still to close before review: invalid JSON in a credential's provider_data makes frozen credentials.list throw, while the new identity-only read never parses it. This case has not been compared. Malformed credential labels/providers and malformed settings also need dedicated comparisons. No universal parity claim for malformed credential records. No login attempt limiter in either gateway; day boundary fixed at boot in both. D4 must wire the authenticated client read lane and lossless quota/credential metadata reads to Postgres, preserve JS cell coercion, ICU ordering and output order, and add bounded quota sample reads plus retained-span/paging semantics for history.

---

## Prior checkpoint history

**NEXT STEP:** implement GET `/api/client/quota` with a failing comparison first. `headroom.ts` was read completely: it DOES disclose `credentialId`, label, provider and window fractions (plus timing/estimate flags); it omits raw used/limit counts. Read `burn.ts`, credentials.list and settings semantics before porting; listQuota is an unfiltered `SELECT * FROM quota_windows`. Skip orphan windows, include disabled credentials, preserve JS coercion of unusual cells and locale sorting. Use the bounded report reader AFTER require_client. Extend shared fixture clock enablement (admin-routes.ts `clientClock`) to the new quota configuration. Commit quota when equal, then history with retainedSpan/sample cap/truncated. Neither quota route has a RED comparison yet. This session closes at the usage checkpoint due to context budget; A8 is not complete for review.

## Status and commits

Partial increment, not A8 complete. No subagents, pushes, merges, dependencies or unsafe code. Product TypeScript untouched. Login uses existing `AdminAuth::login_client`, JSON-field reader and cookie helper. Logout reuses the existing logout handler. Frozen `loginClient` has no attempt accounting/rate limiter; neither does Rust's existing operation. Both hash and look up unknown/revoked keys; no timing equalization or empirical timing claim is made.

| Route | Status | Commit | Comparison evidence |
|---|---|---|---|
| POST login | Implemented | `b4d8ffe1` | `login-red.log`: 22 equal / 34 failures; `login-green.log`: 39 equal / 0 failures |
| POST logout | Implemented | `6861c046` | `logout-red.log`: 13 equal / 12 failures; `logout-green.log`: 19 equal / 0 failures; `logout-session.log`: 21 equal / 0 failures |
| GET summary | Implemented; coverage gaps below | `2493a8a9` | `summary-red.log`: Rust 404; `summary-green.log`: 183 equal, 0 failures; final full driver below |
| GET logs | Implemented | `b5973bb3`, `20cddcbc` | `logs-red.log`: 186 equal / 368 failures (Rust 404); `logs-green-final.log`: 371 equal / 0 failures; malformed degradations RED 376 equal / 6 failures, GREEN 379 equal / 0 failures |
| GET usage | Implemented | `1d84ed0f`, `43263a90`, `327f240f` | `usage-red.log`: 216 equal / 422 failures (Rust 404); `usage-green.log`: 427 equal / 0 failures; expired-session and daily fixtures: 487 equal / 0 failures each |
| GET quota | Not started | — | No comparison or isolation evidence |
| GET quota/history | Not started | — | No comparison or isolation evidence |

`bbc20d35` adds minted-client logout coverage and sorts Rust module declarations; `73f57924` adds login/logout to surface comparisons. Counts above include database comparisons; failures include independent expected-status failures as well as byte differences. Before implementation Rust returned 404 NOT_FOUND on both POST routes. The first exploratory login fixture failed because it assumed an `enabled` column on api_keys; fixed to use expiry before recording RED. The first build exposed private shared helpers; their visibility is now crate-only. One copy command used the wrong binary filename and failed before any comparison; actual binary is `target/debug/omnigateway`.

Login cases assert statuses for malformed/empty JSON, primitive/non-object JSON, missing/non-string keys, unknown key, usable key, expired key, revoked key, and forwarded-proto forms. Cookie normalization validates a 43-character base64url token and compares remaining attributes. Logout checks anonymous/viewer/admin calls and loss of operator access, secure forwarded cookie, and a freshly minted client cookie. Client-session deletion itself is covered by existing auth tests, not a newly ported protected client GET.

Shared fixture extraction: `fd7ed178`, `fixture-extract.log`: 183 equal / 0 failures, unchanged summary behavior. Fixture includes real A/B/C traffic, revoked caller, sessions, and both admin/client cursors; expiry after login is applied by each consuming configuration.

## Isolation evidence

Usage: all five forwarded parameters, duplicate/percent-encoded/case-varied names, ignored URL identity/credential filters and foreign cursors compare equal. apiKey grouping/splitting is allowed but narrowed to the verified session; credential grouping/splitting returns the frozen 400. Every B response (headers and body) is scanned for A/C markers AND key ids and credential-secret markers. Raw totals are directly asserted as B's three SQL rows (two after since=101), daily totals as B's 66 requests against distinct A/C daily counts. The shared fixture also seeds real A/B/C traffic; comparisons use deterministic time bounds. All callers including an actually expired session are checked. libfaketime mints an additional B token at -43201 seconds, then restores the clock before requests; this now applies to summary/logs/usage. C expiry after login is checked before invalid usage grain validation. Implementation reuses the direct bucket writer without a value tree and opens the bounded read-only lane only after require_client.

Quota disclosure reconnaissance only: frozen accountQuota explicitly includes credentialId, label, provider, window type, exact fractions, timestamps and burn/staleness/rollover flags; raw used/limit/rate counts and secrets are omitted. Removed credentials' windows are skipped; there is no enabled-account filter in this operation. No Rust quota disclosure/equality or isolation claim yet. History still requires reading its authorities.

Logs: all ten forwarded filters, invalid cursor/time/state, duplicate/encoded/case-varied names, ignored identity/grouping overrides, A's client cursor and A-scoped admin cursor compare equal. Every B response is directly scanned (headers and body) for A/C markers and `secret-credential-`; excluded degradation entries are seeded for every key and removed in the explicit 19-field projection. B pages to completion using its own cursor (three distinct SQL rows), with real traffic additionally present. Admin/viewer/anonymous/revoked callers and expired-after-login C are refused before malformed query processing. Own text/BLOB/invalid UTF-8/huge integer/NULL cells pass. Initial green had six fixture expectation failures: `state=completed` is invalid (TS accepts pending/done); byte equality already passed. Corrected expected status and reran. No product TS edits.

Summary: three logged-in keys A/B/C have distinct marked labels/prefixes, SQL log rows and real `/v1/chat/completions` traffic through the stub. Each caller (A/B/C, admin, viewer, anonymous, revoked-after-login) is compared with an explicit expected status across 12 queries: identity/credential overrides, apiKey grouping/splitting, admin and client cursors, duplicate names, percent encoding, case changes, bogus offset and invalid filters. Every B answer's headers and body are directly checked for absence of A/C markers. C expired after login is separately refused. Summary ignores all query parameters, as frozen TS does. Both binaries now mint real client cursors and check them against scoped admin cursors. Unusual B display cells (text, BLOB, invalid UTF-8, huge integer, nullable fields) match TS without process failure. Zero, 345 and unset offsets pass; unset also passed under `TZ=Asia/Kolkata` in the previous increment. Usage has no route isolation evidence yet. Frozen quota intentionally discloses named accounts.

Implementation authorizes before opening the bounded read-only report lane; the opening task owns the permit. Lookup is a single verified-session key, never a list or URL identity. Shared summary construction is retained, with lossless display-cell replacement because the existing typed operator reader rejects BLOB labels/prefixes.

## Gates (all waited for and results read)

### Usage increment (2026-11-14, merged Anthropic/OAuth tree)

`manifest.json.usage_increment` records external `/tmp/opencode/a8/rust-usage`, implementation `1d84ed0f`, final driver `327f240f`, SHA256 for Rust and unchanged `/tmp/opencode/a8/ts`. Fresh Rust build is `usage-build.log`; subsequent commits are driver-only. Commands are the commands below with `--rust /tmp/opencode/a8/rust-usage`, `usage-*` evidence directories; targeted runs add `--only client-usage`. All Cargo commands used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0. Every run was waited for and results read. Full admin reran after the daily fixture addition. Drivers clean their own scratch directories; run.ts scratch removed after recording.

| Gate | Result | Log under /tmp/opencode/a8/ |
|---|---|---|
| usage initial RED | 216 equal, 422 failures (404 plus expected-status assertions) | `usage-red.log` |
| usage GREEN | 427 equal, 0 failures | `usage-green.log` |
| expired-session coverage | 487 equal, 0 failures | `usage-expiry.log` |
| daily scoped totals | 487 equal, 0 failures | `usage-daily.log` |
| cargo test --offline --workspace | 1158 passed, 0 failed, 11 ignored; 161 summaries | `usage-workspace.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed | `usage-clippy.log` |
| cargo fmt --all -- --check | Passed | `usage-fmt.log` |
| admin-routes final | 4365 equal, 10 expected divergences, 0 failures, 38 raw keys minted | `usage-admin-final.log` |
| admin-auth | 212 equal, 4 expected divergences, 0 failures, 116 distinct tokens | `usage-auth.log` |
| surface | 616 equal, 61 expected divergences, 0 failures | `usage-surface.log` |
| run.ts | All 47 rows equal | `usage-run.log` |

### Logs increment (2026-11-14)

`manifest.json.logs_increment` identifies external `/tmp/opencode/a8/rust-logs-final`, source `c23a43e2`, and SHA256 for it and the unchanged TS artifact. Full admin/surface ran with `/tmp/opencode/a8/rust-logs` (`20cddcbc`); the final lint-only cleanup `c23a43e2` rebuilt to the IDENTICAL SHA256 `17327efa83db9b082806576e5014df4d6d78c5f91c73baf89f2ee6d91c3630aa` and targeted logs reran against it. Commands follow the commands below with those binary paths; targeted configs use `--only client-logs`. Build logs: `logs-final-build.log`, `logs-rebuilt.log`. Initial workspace command was terminated at its 120-second shell timeout during adversarial tests, then rerun with no timeout (`logs-workspace-final.log`); do not interpret the interrupted `logs-workspace.log` as a completed gate. All Cargo checks use the three required environment settings.

| Gate | Result | Log |
|---|---|---|
| shared summary extraction | 183 equal, 0 failures | `fixture-extract.log` |
| final targeted logs | 379 equal, 0 failures | `logs-degradations-green.log` |
| final lint-clean binary logs | 379 equal, 0 failures | `logs-lint-green.log` |
| cargo test --offline --workspace | 1050 passed, 0 failed, 7 ignored; 117 summaries | `logs-workspace-final.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed after collapsing one nested if | `logs-clippy-fixed.log` |
| cargo fmt --all -- --check | Passed | `logs-fmt-fixed.log` |
| admin-routes full | 3756 equal, 10 expected divergences, 0 failures, 38 minted | `logs-admin-full.log` |
| surface | 614 equal, 61 expected divergences, 0 failures | `logs-surface.log` |

Malformed degradation comparison: `logs-degradations-red.log` against the first logs binary showed TS 500 vs Rust 200 for `{}`, `[1]`, and `null` (6 failures including expected statuses). `20cddcbc` propagates generic internal errors as TS does; invalid JSON also yields 500. The supplemental RED was run against the previous binary after the source fix was written, before its build; it is not claimed as test-first source development.

All runs waited for and results read. Final targeted rerun initially collided with the full driver's port, then passed with `A7_TEST_PORT=18543`. Its empty scratch directory was removed; all completed driver scratch self-removed. Older unrelated scratch was left alone. Admin-auth and run.ts were not rerun in this increment (previous passing evidence below). `progress.md` changed externally during this session and was not staged.

### Summary increment (2026-11-14)

`manifest.json.summary_increment` records commit `2493a8a9`, SHA256 and external binary `/tmp/opencode/a8/rust-summary`; TS is the same `/tmp/opencode/a8/ts` artifact below. Fresh post-commit build: `summary-final-build.log`. Commands use the previous commands with `--rust /tmp/opencode/a8/rust-summary`; targeted configs are `client-summary-0`, `client-summary-345`, `client-summary-host` (also `TZ=Asia/Kolkata A7_TEST_PORT=18543`). All Cargo commands use the three required environment settings.

| Gate | Result | Log |
|---|---|---|
| cargo test --offline --workspace | 1050 passed, 0 failed, 7 ignored; 117 summaries | `summary-workspace.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed | `summary-clippy.log` |
| cargo fmt --all -- --check | Passed | `summary-fmt.log` |
| summary UTC final fixture | 183 equal, 0 failures | `summary-green.log` |
| configured 345 / unset offset (before extra cursor case) | 169 equal each, 0 failures | `summary-offset.log`, `summary-host.log` |
| unset offset, Asia/Kolkata final fixture | 183 equal, 0 failures | `summary-host-nonutc-final.log` |
| admin-routes full, before extra cursor case | 3335 equal, 10 expected divergences, 0 failures, 38 minted | `summary-admin-full.log` |
| admin-routes final rebuilt binary and fixture | 3377 equal, 10 expected divergences, 0 failures, 38 minted | `summary-admin-final.log` |
| surface final rebuilt binary | 612 equal, 61 expected divergences, 0 failures | `summary-surface-final.log` |

RED preceded implementation (`summary-red.log`, Rust 404, 161 failures including status and initial nondeterministic cursor case-name mismatches). Three initial fixture SQL attempts failed before comparison (wrong column names/placeholder count); corrected before RED. The initial green comparison exposed case-name nondeterminism, corrected by naming cursor cases independently of token bytes. Unusual-cell testing observed TS 200 versus Rust 500; corrected and rerun green, overwriting that run's log, so **no durable separate unusual-cell RED artifact is claimed**. `summary-red-final-fixture.log` replays the expanded fixture against the old binary (164 failures); it is supplementary, not the pre-implementation proof. Successful driver scratch is self-removed; own failed fixture scratch was removed. No other agent scratch removed.

### Previous login/logout increment

Evidence root `/tmp/opencode/a8/`; binaries copied outside checkout. `manifest.json` gives full Rust build commit, driver commit, TS artifact provenance and SHA256 for both binaries (plus login-only binary). Rust build commit `6861c046`; later Rust source edit is module ordering only. TS copied from the A7 fix2 artifact whose manifest names `d0c11d29`, unchanged frozen product TS.

| Gate | Result | Log |
|---|---|---|
| cargo test --offline --workspace | 1050 passed, 0 failed, 7 ignored, 117 result summaries incl. doctests | `workspace.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed | `clippy.log` |
| cargo fmt --all -- --check | Passed after module-order fix | `fmt.log` |
| admin-routes (full, with both client configs) | 2828 equal, 10 expected divergences, 0 failures, 38 raw keys minted | `admin-routes.log` |
| admin-auth | 212 equal, 4 expected divergences, 0 failures, 116 distinct tokens | `admin-auth.log` |
| surface final | 610 equal, 61 expected divergences, 0 failures | `surface-final.log` |
| run.ts | All 41 request rows equal; DB logs 37, daily 18, rollup 6, credential health 4 | `run.log` |

Rust build/test/clippy used `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`. Existing slow-reader gate ran in the full admin driver: Rust idle median 4.580ms, loaded median 2.686ms (15 samples, bound 10ms), raw `admin-routes/slow-reader-rust.json`. Other drivers used distinct existing ports; no runs remain outstanding. Successful admin driver removes its scratch itself; removed this session's initial failed client-login scratch and run.ts scratch after recording results. No large fixtures copied.

Commands: `bun conformance/e2e/admin-routes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a8/rust --out /tmp/opencode/a8/admin-routes` (targeted runs add `--only client-login` or `--only client-logout`); analogous admin-auth.ts and surface.ts with their `--out` directories; `bun conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a8/rust`.

## Differences, gaps, concerns

- Two GET routes retain unimplemented behavior: quota, quota/history. Usage and logs use the bounded report reader after authorization and take scope from the verified session. No observed usage differences from TS in tested cases. Usage unusual-cell, empty-table and real-traffic-output comparisons remain coverage gaps; real traffic is seeded but excluded by the deterministic comparison window.
- Existing oversized-body difference is precisely four admin-auth requests: POST `/api/login`, `/api/setup`, `/api/logout` declaring Content-Length 134217729 (128 MiB + 1), and POST `/api/login` sending that many bytes chunked. TS sends status 413 with no headers and an empty body; Rust sends status 413, `content-length: 0`, and an empty body (normalized `413\n\n\n` versus `413\ncontent-length: 0\n\n`). Client-specific oversized/chunked-over-limit cases, configured HTTPS base URL, poisoned limits, Unicode keys and timing measurements remain coverage gaps.
- Coverage gaps: no key-disable field exists; no summary limit-counter fixture or empty-log variant; unusual limits/allowlist cells remain typed and unverified. Shared fixture now supports summary/logs/usage, including expired-session-token callers via libfaketime. It has marked requested/resolved models, error codes, key labels/prefixes and degradation entries, but not every possible visible text column; request logs have no error-message column. Logs filter comparisons use the deterministic SQL time window; real traffic is seeded but its client log output is not compared. These are unfinished acceptance coverage, not claims of complete brief compliance.
- Offset investigation (item 1, no code change): both TS route factories call `deps.dayOffsetMinutes ?? hostDayOffsetMinutes()` per request (client.ts:110, admin.ts:604). However frozen `packages/control/src/config.ts:140` resolves absent/invalid configuration at boot and `apps/gateway/src/index.ts:345` ALWAYS passes that number; app.ts:445–469 forwards it to both factories. Thus the actual frozen binary and Rust both retain the boot value through DST. Changing only Rust for an unset environment variable would introduce a difference. No injectable optional-offset Rust route-factory API exists; no DST simulation was run. The requested change is blocked on reconciling route-factory semantics with frozen executable semantics; operator routes remain unchanged for the same reason.
- Surface had no client GET expected-divergence rows to move. Added anonymous usage in both static configurations, taking equal count from 614 to 616; expected divergences remain 61. Quota/history still need surface cases.
- D4 Postgres must wire scoped own-key lookup/summary counters, scoped log paging and projected rows, scoped usage direct writer, credential/quota-window/sample readers and retained-span/sample-limit behavior to a bounded independent reader lane. Existing session auth must use the Postgres key usability lookup too. No Postgres implementation here.
- `bun.lock`, untracked 2026-10-24 specs, stash and other worktrees untouched. At final status, `progress.md` also appeared modified externally during this session; it was neither edited nor staged here.
