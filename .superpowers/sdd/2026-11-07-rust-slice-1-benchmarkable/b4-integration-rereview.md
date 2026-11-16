# B4 integration re-review — c005c22d

## Verdict
**APPROVE** B4 integration at c005c22d. Both R1 findings closed; no new Critical/Important/Minor findings. Complete carried-forward differences, inherited behaviors and verification limits below are part of this approval.

Prior findings: **Important closed**, **Minor closed** by independent source review, red/green unit tests, real HTTP probes and mutation bite control. No product edits requested.

## Source assessment
Only production change is refresh.rs two transport/deadline map_err sites plus refresh_threw helper. Token parsers, AUTH disable, singleflight/lock/CAS and token/metadata persistence are byte-unchanged. All three providers now move NETWORK/TIMEOUT to frozen UPSTREAM `<provider> oauth refresh threw`. This intentionally improves Anthropic/OpenAI parity too; not a byte-preservation claim for their previous erroneous transport failures.

Google driver assertions use literal fixture expectations, not Rust output or cross-side derived expected values: status, UUID/reconnect id, typed timestamps and persisted tokens/email/project/tier/version. Existing differential comparison remains additional. load-failure expects onboard-project + legacy-tier: frozen oauth.ts project bootstrap treats non2xx load as null, chooses default legacy-tier, then accepts onboard response project.

## Scope/provenance
Checkout clean detached c005c22d33e77778ddefd33dfd37054974771fb5; initial disk17GiB. All Rust sources touched before workspace build. No product edits/commits/subagents; isolated archived red checkout at r2/red-checkout is beb40ebf (old production mapping + new nine tests), not a mutation of review checkout. All provider drivers sequential in loopback-only namespaces with private HOME, scrubbed environment, /usr/sbin and Bun in PATH, wrapper adding --no-env-file to nested calls. Frozen sources diff-equal1780bb39. Supplied c005c22d binary SHA256 verified cbb6d8947eace5063c58e0c65fc5dbde4c59942845fe2d7b3222e5ad3602ad2c; frozen f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63.

## Failure-map reasoning
Frozen pluginFlow.ts:71 MAX_STEP_TIMEOUT_MS=30000; :268–270 applies min(request.timeoutMs or30000,30000). All three refresh generators yield postJsonRequest with no timeoutMs; that builder has none. Antigravity userinfo's15000ms GET is exchange-only. Send/body exceptions go into gen.throw and rethrow; none of three token/refresh generators catches them. Hence UPSTREAM `<provider> oauth refresh threw` is correct for all three, not merely Antigravity. Token non2xx/error parsing and AUTH disable branches are after the changed map_err and unaffected; singleflight/CAS/persistence untouched by exact diff. Generic host tests and other-provider drivers independently gate these preservation claims.

## Verification plan (executed results below)
Fresh workspace; positive lint/fmt/size and archived red unit build serially; reviewer close+real30s timeout six-row probe and committed close/truncated/timeout nine-row probe; Antigravity/connect/Anthropic/OpenAI drivers; Google success-fixture mutation expected to fail on frozen before Rust executes. Red/green controls count independently, not as positive tests.

## Frozen fallback independently executed
`frozen-load.exit`: `bun --no-env-file frozen load500 scripted exchange => 0`. Scripted frozen source (diff-equal1780bb39) token200, userinfo200, load500 carrying a deliberately tempting wrong allowed-tier, onboard200 project. Frozen ignores failed load body, sends onboarding tier_id legacy-tier, returns providerData `{projectId:"onboard-project",tier:"legacy-tier"}`. Requests and result retained in frozen-load-failure.json. No network or binary-derived expectation. Positive connect driver additionally reruns exact load-failure HTTP row on frozen.

## Whole-provider acceptance basis (carried forward, not new codec/decoder review)
### Documented differences/rulings
1. X1: Rust carriers reject/replace lone UTF-16 surrogate values/keys and numbers outside double range; Unicode/vendor enumeration consequences remain the earlier approved carrier difference.
2. Request depth engine-threshold band: earlier approved39,990-level comparisons and39,996 input band; Rust can serialize where frozen JS hits its engine stack threshold. No new universal exact stack threshold inferred.
3. Upstream nesting above40,000 refused as retryable UPSTREAM `antigravity codec decode threw`; earlier emitted events remain and open blocks may lack blockEnd.
4. u32 block-index bound (including final permitted fc_4294967295 tool and STOP, then no further allocation); actual billions of frames represented by seeded tests.
5. Global maxOutputTokens65536 ceiling, even where catalog limits are higher.
6. Cloak-before-request-id internal order, no observed external effect.
7. rustls TLS fingerprint; UUIDv7 generated request ids versus frozen UUIDv4; upstream connection reuse1 versus2 sockets.
8. Shared integer persisted expiry truncation/saturation (source labels X2), not a new numeric acceptance invented by this repair.
9. Connect refusal list names Rust-served anthropic/openai/antigravity (12 provider-list differences;5 unported providers). Process-local pending state with frozen oauth:pending key/JSON/600000ms TTL. Full snapshot rebuild before acknowledgment per ruling.
10. Branch's single listing-pending row remains separate shared main listing work; no merge test here. Usage quota is B10 and excluded.
11. **Repaired behavior, not an allowed divergence:** Antigravity, Anthropic and OpenAI refresh send/body/30s deadline exceptions now all map UPSTREAM `<provider> oauth refresh threw`; previously Rust NETWORK/TIMEOUT and bare token-request messages were wrong. Timeout final response moves504→frozen503 under exhausted sole credential; old non-error token behavior unchanged.
### Inherited frozen behaviors
Start has exactly six fields (no label/pasteHint). Hosted callback origin/path and trimmed first query code/state validated; bare non-URL garbage/code passes to upstream, second#state checked, third ignored. Poll uses empty code even for PKCE. Finish consumes pending flow before callback normalization. Reconnect same-provider OAuth check at start, re-read missing credential error, changed-after-start provider only withholds prior data; preserves id/label/tier/weight/creation while replacing token/project data, enabling and clearing disable reason. Snapshot rebuild failure logging/ack behavior inherited.
Token→userinfo→loadCodeAssist→optional onboard; max4 sends;30s token/load/onboard,15s userinfo,150s exchange wall. URLs closed literals; allow-list adds no reachable built-in difference. HTTP userinfo failure/invalid/blank email degrades to null; transport failure fatal. Load failure/malformed/missing project triggers onboarding, uses legacy-tier on failed load; onboarding non2xx/missing project still succeeds empty-project. Credential refreshable but inference refuses blank project until reconnect. Expiry computed after all bootstrap calls. String access_token (including empty) required, refresh string or fallback/null, expires_in number only. isFlowResult checks secrets/providerData, not email/expiry. Successful refresh retains project/tier and email, never re-reads project. AUTH disables tokenRejected, transient host failure does not. Singleflight by credential id, lock/re-read/token_version CAS; loser returns stored winner secrets.
### Unverified / scope limits
Approved request codec/decoder not independently reopened; existing workspace coverage only. Earlier R1 paired probes remain basis for Google bootstrap failures/timeouts, immediate inference, successful refresh after connect, client-disconnect exactly-once persistence and SIGTERM within grace; not all rerun here. Full successful huge-bootstrap-body parse parity remains inconclusive (all attempted frozen variants returned502), despite source1MiB Rust body cap; not counted a proven defect. Fifth request/off-origin/150s wall fault mutation not done (closed graph max105s request waits); no claim for plugin-controlled requests. No actual billions of blocks, live Google OAuth/provider/TLS fingerprints, two-live-process Antigravity CAS race, external pending coordination, post-grace or disconnect+SIGTERM combined case. PostgreSQL/service tests ignored, quota B10/admin routes excluded, no actual merge with main listing. Earlier large-body and codec-depth conclusions are not broadened by approval.

Independent refresh checks include six reviewer-filtered close/timeout rows and additionally six literal adapted R1 probe rows (two modes x three providers). Adaptation changes provider/model/hosts and success validator to require frozen503/error text/log class. All retain ordered token bytes and persisted equality; committed9-row driver adds truncated body and real timing validation. Their controls are separate from workspace unit tests.

## Preservation evidence to check in fresh workspace
refresh integration `success_coalesces_and_stale_views_deduplicate`:2 concurrent waiters→one send, stale view dedup, token_version1. `failures_are_shared_but_not_cached_and_rejection_disables`:400 AUTH disables tokenRejected with unchanged version,429 RATE_LIMIT and503 UPSTREAM leave enabled, error flights not cached. `openai_local_endpoint_retry_id_token_and_cas_loser` / unavailable-lock CAS tests check winning tokens/metadata retained. Exact production diff leaves these paths unchanged. Nine new tests use actual local sockets for close/truncated, pending transport with Tokio pause for timeout; assert UPSTREAM/message and whole credential equality/enabled. Archived red version contains original mapping and exactly same tests, no compile-red substitution.

Red test module identity independently checked (`unit-identity.txt`): byte-equal between archived beb40ebf and current c005c22d, SHA256 bb61b7e0cda92aa91492b3fef98cafeaadbdd7c5111f4aee78facf4ab7d2db42. Red checkout source original TIMEOUT/NETWORK mappings preserved. Shared target reused serially to avoid duplicate artifacts; no source changes.

No new non2xx token success/error behavior can reach refresh_threw: timeout wraps only send + body text; Ok(status,body) still invokes exactly prior per-provider token_result code, including429 before4xx AUTH mapping and sanitized token error text. This explains why accepting the shared all-provider repair does not broaden the product change to ordinary refusals. Provider-specific identities and request bodies also byte-unchanged.

## Driver quality notes
Committed refresh driver expects nine fixed rows (three providers x three modes), each independently valid503/exact provider+refresh step message/server_error, one wire request, whole decrypted before/after credential equality and enabled, one ALL_CANDIDATES_FAILED log. Only elapsed is removed for cross-side equality, after timeout29–40s validation; ordered raw token requests and all unmasked credential/log fields compare. Stub's non-refresh traffic returns{}, only refresh-token body faults; every case uses fresh DB and process, expired after boot, excluding boot scheduler contamination. A missing/extra send fails wire count. Request_log dynamic id/time/duration/node fields are masked conventionally; error class not masked. Equality alone cannot pass two erroneous statuses.
Google new checks remove the previous demonstrated equal-failure pass: start status/PKCE validated before branch skip; scenario success status and UUID/reconnect id required before persistence; stored tokens/email/project/tier/type/enabled/version/disable state fixed, timestamp integer/range exact. Independent mutation targets only URL token fixture, not gateway code or expected outcome. Residual test-quality limitations inherited: some other-provider connect rows remain differential-only; listing-pending is broad inequality+alias check and deliberately excluded listing surface. These are not the now-repaired Google success-row finding.

Review response covers both prior ranked findings only plus narrow regression reach. Unproven bootstrap-size concern from R1 is not silently upgraded to an allowed difference; remains an explicit verification gap. No broad request-codec/decoder changes in c6899adc..c005c22d; their prior approvals remain relied on, not recreated here.

Controller/implementer claim check: reported binary hash, load-failure expectation, old-mapping9/9 failures and workspace1310 total independently verified in results below. Summary counts computed from complete test-result lines, not reused report numbers.

All source edits for harnesses are confined to r2. Archived red checkout is read-only for execution; no mutation/restoration of product files necessary. Positive driver binary is hash-verified implementer final artifact; reviewer compiles its own workspace/tests for independent source gates, not a separately built replacement runtime binary. No live provider traffic, default real HOME or .env access.

## Fresh workspace result
`workspace.exit`: `cargo test --offline --workspace => 0`. Independently summed **1310 passed /0 failed /37 ignored**, matching implementer count (rather than tentative R1+9 arithmetic). All nine new transport tests passed. No retry required; named WAL/reconciliation/drain flakes passed.

## Fresh HTTP refresh results
`reviewer-refresh.exit`: `bash reviewer-refresh-ns.sh frozen rust-c005c22d (close+30s timeout x3) => 0`:6/6 equal with independent frozen/Rust validity. `committed-refresh.exit`: `bash conformance/e2e/refresh-transport-ns.sh frozen rust-c005c22d => 0`:9/9 equal, all three providers close/truncated/real timeout. All rows require503, exact frozen message, server_error, ALL_CANDIDATES_FAILED request_log, one ordered token request, enabled and fully unchanged decrypted credential row. Actual timeout elapsed validated29–40s on each side before elapsed masking. Thus previous503/504 and wrong-message regressions are closed in HTTP evidence, not merely unit code.

## Fresh unit negative control / static gates
`unit-red.exit`: `cargo test --offline --manifest-path red-checkout/Cargo.toml -p omni-gateway --lib refresh::transport_tests => 101`. Archived beb40ebf compiles successfully, then **0 passed /9 failed**, six actual NETWORK vs expected UPSTREAM and three TIMEOUT vs expected UPSTREAM. No compile-red. Test module byte-identical. This independently verifies claimed9/9 failure on old mapping, not implementer logs. Fresh positive workspace has9/9 green; focused current-source green rerun additionally scheduled after archive test.
`clippy.exit`: `cargo clippy --offline --workspace --all-targets -- -D warnings => 0`; `fmt.exit`: `cargo fmt --all -- --check => 0`; `size.exit`: `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture => 0`, concrete3400 bytes under5500 ceiling. Cargo commands strictly serial; source gates ran in clean actual checkout, archive red uses same target only after them. Disk17GiB, never near5GiB floor.

### Shared-target artifact collision disclosed
Immediate focused green rerun (`unit-green.exit`101) reused red archive artifact: Cargo finished0.12s without compiling and failure line529 belongs to archived source, while current source assertions are537 and map_err refresh_threw present. This is reviewer harness target reuse, not product regression (initial full workspace green before archive). Touched only current refresh.rs mtime and forced rebuild (`unit-green-rebuild.*`). Red result remains real and valid; final green must be read from rebuild. No content edit or deletion. A dedicated target would avoid this Cargo same-package artifact collision; full duplicate dependency build was avoided for disk/runtime.

`unit-green-rebuild.exit`: `touch refresh.rs; cargo test --offline -p omni-gateway --lib refresh::transport_tests => 0`:9 passed/0 failed. This resolves the artifact issue with actual current compilation. Initial green9→archived red9→rebuilt green9 sequence independently demonstrated. Additional focused existing refresh integration suite runs after final rebuild for AUTH/non2xx/singleflight/CAS/persistence preservation.

## Findings closure criteria
Important closed when all3 providers' refresh close/body/timeout are503 with exact frozen message/log class and no credential mutation; committed9/9 and reviewer6/6 already satisfy, literal adapted R1 repeats are supplemental. Minor closed when URL-success mutation is rejected on frozen while normal Google scenarios (including load-failure) pass with per-side fixed assertions. Ordinary Anthropic/OpenAI refresh behavior assessed by unchanged production diff plus fresh preservation tests and drivers; their transport failure behavior intentionally changed toward frozen, explicitly included in overall approval basis.

`refresh-preservation.exit`: `cargo test --offline -p omni-gateway --test refresh => 0`; existing host integration suite passes after rebuilt current source, covering AUTH disable,429/503/non2xx, success coalescing/stale-view dedup, CAS winner metadata, fail-open lock and expiry/providerData persistence. No parser/persistence change required.

## Approval basis
No additional product finding in repair range. Prior R1 Important error mapping has direct9-row HTTP equality and9-test behavioral red/green proof. Ordinary handling supported by fresh14 refresh integration tests, full workspace1310 and unchanged token/persistence diff. Prior Minor repair is fixture-independent; mutation evidence is the remaining bite check. Final whole-B4 verdict uses original approved codec/decoder plus R1 integration evidence, narrowed repair proof and explicit acceptance/limits inventory above, not a claim all provider boundaries were re-reviewed.

## Fresh connect / fallback results
`connect.exit`: `bash conformance/e2e/connect-ns.sh frozen rust-c005c22d => 0`:429 rows/0 failed/17 expected (412 equal;12 provider-list+5 unported). New fixed per-side assertions passed every Google case. Independently inspected `ts/google-load-failure.raw.json` and Rust counterpart: provider_data exactly `{"projectId":"onboard-project","tier":"legacy-tier"}`, enabled1/token_version0. This verifies corrected c005c22d expectation on frozen binary, not only pure scripted source.
`anthropic.exit`: `bash conformance/e2e/anthropic-ns.sh frozen rust-c005c22d => 0`:30 cases/0 failed. OpenAI and mutation follow sequentially.

R2 counter methodology: committed refresh9 unique provider/mode inputs; independent filtered6 and literal R1 repeats6 duplicate those close/timeout inputs and are additional paired executions, not21 distinct failure classes. Green unit9 and archived red9 count tests, not HTTP rows. Connect429 retains same row names/count and17 accepted divergences. Mutation expects an assertion exception/exit1 before any Rust run, not a counted differential failure matrix. This prevents inflating coverage by repeated drivers.

The requested “single ordered token request / credential unchanged” property is exact in committed refresh driver: whole row equality includes token_version, access/refresh/id/API token bytes, project/tier, email, label, expiry, enabled and created/updated timestamps. One log and one wire are mandatory before paired equality; send/body exceptions do not persist failure metadata or disable. No skipped missing-row path exists in this driver.

Interim scan364 stdout/stderr/log files:46 expected ALL_CANDIDATES_FAILED diagnostics,40 matches all within intentional archived unit-red and stale-artifact unit-green logs; no unexplained match in passing gates. No stack overflow/SIGSEGV/SIGABRT. Final scan includes mutation and all R1 repeats after completion.

Actual committed timeout measurements (`timeout-measurements.json`): frozen Antigravity30010ms/Anthropic30010ms/OpenAI30008ms; Rust30005/30005/30004ms. All503 and ALL_CANDIDATES_FAILED. No artificial clock advance or shortened runtime timeout in HTTP rows; only the unit pending futures use Tokio pause.

## Scope of overall approval
The whole B4 integration judgment relies on the frozen-oracle ruling plus independent request codec approval998eab1c and decoder approval38c7b5de, reviewed integration b6461d61..c6899adc and this repair c6899adc..c005c22d. No remaining previously ranked finding after successful per-side mutation control; this is not approval of B10 or shared listing merge. Historical report at ../review.md remains REQUEST CHANGES for old c6899adc and is not overwritten. This r2 report supersedes only its verdict for the new commit.

The R1 base-binary72 failed rows remain historical negative control of integration dispatch/connect/catalog; not rerun for this narrow transport repair. New archived nine-test negative and Google validity mutation provide direct new repair controls. Driver names/counts are unchanged429 Google+existing connect rows, no removal to make assertion pass.

### Security/transport scope
New refresh mapping cannot leak upstream body or credentials: message built only from provider from validated credential plus literal oauth refresh threw. Old provider state/request content is not included. Error remains retryable UPSTREAM; no AUTH misclassification or token rejection disable. New helper does not spawn work or change cancellation ownership. Existing detached shared refresher and deadline30s retained; transport socket/body dropping semantics unchanged. Other changes are test-only; connect product path exactly unchanged.

No fresh run.ts custom matrix requested in this short re-review; unchanged dispatch/custom paths and R1 all-equal run.ts evidence are relied on. Implementer run.ts claim is not represented as reviewer-rerun evidence. No fresh standalone gateway build requested/run here; source test+clippy gates and hash-verified supplied final binary explicitly distinguished.

Refresh request bytes remain frozen across all provider identities: Antigravity form includes masked-public installed client data, Anthropic JSON includes its client id, OpenAI form scope/client id. Drivers retain full wire bytes for comparison but report does not print token/client secret literals. No real credential or provider config accessed.

## Findings closed
**Important closed:** committed9-row refresh plus independent6-row HTTP controls green; old-mapping9 red→current9 green; ordinary14 refresh host tests green.
**Minor closed:** `mutation.exit`: `bash mutation-ns.sh frozen rust-c005c22d url-token-500 => 1`; changed ONLY URL-success token fixture to500, same as R1 vacuity reproduction. Hardened driver now aborts on **frozen** with `error: Google url expected 200` at independent expected-status assertion before Rust runs. This proves assertion bites and is not calculated from the binary under test; old driver mutation had exited0. Normal429 rows green and load-failure expectation independently validated.
`openai.exit`: `bash conformance/e2e/openai-ns.sh frozen rust-c005c22d => 0`:56 rows/0 failed. Anthropic30 and OpenAI56 unchanged ordinary scenarios pass; refresh transport failure behavior intentionally corrected to frozen for both.

Literal adapted R1 Antigravity close and real30s timeout probes now both exit0 as well (R1 had failed client equality in both). This independently confirms original exact reproduction no longer fails, with explicit503/frozen error/log validator replacing inapplicable original success-inference check. Anthropic/OpenAI literal adaptations follow, supplemental to already green committed9 and reviewer6 matrices.

No new documented exception is needed for this repair: it removes a difference rather than authorizing one. The explicit carried-forward carrier/depth/block/identity/connection/listing/connect rulings remain the entire exception basis; successful large-response parsing and external live-service details remain unverified, not normalized away.

Old mapping tests are behavioral assertions (code/message), not test compilation failures; all nine test functions compiled in archive before failures. Their whole-credential/no-disable asserts execute only after code/message pass in green. HTTP9 independently verifies persisted equality even with actual socket/body truncation, complementing unit coverage.

The Google start/finish assertion additions do not alter expected divergence classes;12 provider-list and5 unported-provider remain pinned. Success labels/account/project rows continue full paired comparison after independent status/token/data assertions, preserving R1 byte/order evidence rather than replacing it with booleans.

Final approval will not claim anonymous/uncounted response differences: Antigravity45 has44 equal+1 exact counted listing-pending, connect429 has412 equal+17 exact refusal classes; refresh failure matrices have no expected divergence classes. The provider guard/boxed future dispatch state remains3400 bytes and byte-unchanged in repair range.

## Final fresh gates / counts
- `workspace.exit`: `cargo test --offline --workspace => 0`.
- `clippy.exit`: `cargo clippy --offline --workspace --all-targets -- -D warnings => 0`.
- `fmt.exit`: `cargo fmt --all -- --check => 0`.
- `size.exit`: `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture => 0`.
- `unit-green-rebuild.exit`: `touch refresh.rs; cargo test --offline -p omni-gateway --lib refresh::transport_tests => 0`.
- `refresh-preservation.exit`: `cargo test --offline -p omni-gateway --test refresh => 0`.
- `reviewer-refresh.exit`: `bash reviewer-refresh-ns.sh frozen rust-c005c22d (close+30s timeout x3) => 0`.
- `committed-refresh.exit`: `bash conformance/e2e/refresh-transport-ns.sh frozen rust-c005c22d => 0`.
- `antigravity.exit`: `bash antigravity-ns.sh frozen rust-c005c22d => 0`.
- `connect.exit`: `bash conformance/e2e/connect-ns.sh frozen rust-c005c22d => 0`.
- `anthropic.exit`: `bash conformance/e2e/anthropic-ns.sh frozen rust-c005c22d => 0`.
- `openai.exit`: `bash conformance/e2e/openai-ns.sh frozen rust-c005c22d => 0`.
- `r1-antigravity-transport.exit`: `bash r1-antigravity-transport-ns.sh frozen rust-c005c22d => 0`.
- `r1-antigravity-timeout.exit`: `bash r1-antigravity-timeout-ns.sh frozen rust-c005c22d => 0`.
- `r1-anthropic-transport.exit`: `bash r1-anthropic-transport-ns.sh frozen rust-c005c22d => 0`.
- `r1-anthropic-timeout.exit`: `bash r1-anthropic-timeout-ns.sh frozen rust-c005c22d => 0`.
- `r1-openai-transport.exit`: `bash r1-openai-transport-ns.sh frozen rust-c005c22d => 0`.
- `r1-openai-timeout.exit`: `bash r1-openai-timeout-ns.sh frozen rust-c005c22d => 0`.
- `unit-red.exit`: `cargo test --offline --manifest-path red-checkout/Cargo.toml -p omni-gateway --lib refresh::transport_tests => 101`.
- `mutation.exit`: `bash mutation-ns.sh frozen rust-c005c22d url-token-500 => 1`.
- `frozen-load.exit`: `bun --no-env-file frozen load500 scripted exchange => 0`.

Positive HTTP refresh: committed9/9 equal (3 modes x3 providers), reviewer-filtered6/6 equal, literal R1 adapted6/6 equal: **21 paired executions,9 distinct mode/provider inputs,0 differences**. Real30s timeout for all3 providers returns503/exact frozen message/ALL_CANDIDATES_FAILED, credential fully unchanged/enabled, one ordered token request. Unit old-mapping **0/9 pass** then rebuilt fixed **9/9 pass**; ordinary refresh preservation **14/14 pass**. Shared-target stale-artifact attempt disclosed above, not hidden.
Workspace **1310 passed/0 failed/37 ignored**, no flaky retry. Clippy/fmt/dispatch_size pass; state3400 bytes. Antigravity **45 rows/44 equal/0 failed/1 listing-pending**; connect **429/412 equal/0 failed/17 expected**; Anthropic **30/0 failed**; OpenAI **56/0 failed**. Frozen fallback source and HTTP row both confirm onboard-project/legacy-tier. Mutation expected exit1 before Rust proves fixed per-side validity assertions bite. No outstanding ranked findings. No new exceptions introduced.

Final scan: 449 log/stdout/stderr files; 58 expected ALL_CANDIDATES_FAILED diagnostics; 41 other matches all intentional archived-red assertion panics/failures, disclosed stale-artifact rerun, and expected Google mutation assertion. No unexplained FAILED/panicked/^error in positive logs; zero stack overflow/SIGSEGV/SIGABRT.

Restoration: `restoration.txt` contains only c005c22d33e77778ddefd33dfd37054974771fb5; status/diffs empty. All6 restoration command/check exits0 in restoration.exit. No product edits, commits or subagents; only mtimes touched. Disk remained17GiB, no cleanup/deletion.
