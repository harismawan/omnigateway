# A15 independent re-review — REQUEST CHANGES

Range `0e4a07f9..7ad389ce`. No product edits, commits, subagents or builds. Prior review and implementer handoff left untouched. Evidence `/tmp/opencode/a15-rereview/`; all paths below relative to it unless absolute. Probes use copied scripts, isolated loopback namespaces, explicit gateway/CLI environment, private HOME and Bun `--no-env-file`.

Reviewed binary `/tmp/opencode/a15/fix-2/rust-final-2`: SHA256 `3131d187c14aec77fd51bb3d78164df2ddf06f2b55eb56c52c8806adcb5c8b96`. Frozen `/tmp/opencode/a8/ts` unchanged from first review.

## Earlier findings

| Finding | Disposition | Evidence |
|---|---|---|
| I1 disconnected poll reusable | **Closed** | Independent success, refusal, delayed transport-close and 31-second timeout probes, both providers, last HTTP waiter aborted. All consumed; success one credential, failures zero. `lifecycle/`, `close/`; stock disconnected finish/poll coverage also rerun. |
| I2 reconnect publication | **Not closed** | Ordinary reconnect now passes; immediately reconnecting a fresh credential still fails routing. R1 below. New-connect lag accepted under controller ruling. |
| I3 email error text | **Closed** | Independent 196-pair field/type/route matrix, including arrays/objects: identical generic 500 INTERNAL. `matrix/`. |
| I4 public inventories | **Closed** | Exact two intended TSV additions inspected; final workspace logs 1271 pass/0 fail/19 ignored. No builds by reviewer. |
| M1 driver classes/first request | **Closed for requested scope** | Explicit class counts, statuses, error texts, successful reconnect-first assertion. Independent baseline negative control 353 rows/349 failures, full tables written. Remaining coverage gap is R1, not weakened first-request assertion. |

## Important — R1: Reconnect publication silently skips credentials missing from the snapshot

Frozen `packages/control/src/connect.ts:247–258` updates secrets and credential metadata; store emits credentialsChanged (`packages/store/src/sqlite/credentials.ts:278,306`); `apps/gateway/src/dispatch/snapshotCache.ts:39–66,68–87` rebuilds stale snapshot on next request.

Rust new call `crates/omni-gateway/src/connect.rs:426–432` awaits `SnapshotHolder::refresh_credential`, but `crates/omni-gateway-core/src/snapshot.rs:369–379` only replaces an entry found in `next.routing.credentials`. A non-null database row with no matching snapshot entry is silently ignored and returns Ok. Thus a credential created in the last polling interval remains absent even after successful reconnect acknowledgement.

**Paired reproduction:** preconfigure a virtual model targeting the provider (no credential pin) and create a client key; disable all other credentials and wait 650 ms for publication. POST `/api/connect/start` with `{"provider":"anthropic"}`, finish with `{"flowId":F,"code":"code#S"}`; immediately start again with `{"provider":"anthropic","credentialId":ID,"label":"inference"}`, finish with its fresh F/S. Both exchanges receive 200 `{"access_token":"anthropic-inference-access-0","refresh_token":"inference-refresh","expires_in":3600}`. Immediately POST `/v1/chat/completions` with fixture bearer key and `{"model":"inference-anthropic-true","messages":[{"role":"user","content":"hello"}],"max_tokens":32,"stream":false}`.

Frozen: **200**, assistant `fixture answer`, correct new bearer on upstream. Rust: **503** `{"error":{"message":"no eligible credential for model \"inference-anthropic-true\"","type":"server_error","code":"service_unavailable"}}`, no inference wire. OpenAI same result with model `inference-openai-true`.

**20 trials per provider per side:** frozen 20/20 first-request successes each; Rust 0/20 each. Evidence `missing.py`, `missing.ts`, `missing/{ts,rust}/{anthropic,openai}-true-{0..19}-routable.json`, DBs and response rows. Each start/finish succeeded; model existed before the initial connect. This violates the controller's explicit reconnect-before-ack requirement, not the accepted fresh-connect lag. Fix publication to include a newly read credential absent from the held snapshot, while preserving its existing deletion/concurrent-publication safeguards.

Scratch `missing.log` reports 43 failures: 40 real first-request mismatches plus three irrelevant stock class-count assertions retained in this focused script. Count only the 40 result mismatches; start rows agree.

The same sequence completed through `/api/connect/poll` instead of finish also fails: `missing-poll/`, one trial/provider, frozen 200 valid=true, Rust 503 valid=false. This is the same missing-snapshot publication defect in both completion workers.

## Minor — R2: New shape rows mask credential IDs without validation

Frozen `packages/control/src/connect.ts:266–286` returns the UUID of the saved credential. New driver `conformance/e2e/connect.ts:287–290` replaces any truthy `r.body.id` with `<uuid>` without checking type, UUID syntax, or correspondence to the saved row. Its SELECT reads account_email by label only. Consequently `{"id":"broken"}` and a real UUID normalize identically even if the DB was saved correctly under a different ID. This is a harness finding, not an observed product mismatch; paired actual responses in `matrix/` return valid IDs, but the committed shape-row assertion cannot detect this corruption. Retain UUID/persisted-row validation before masking, as successRows already does. It does not make the whole row vacuous; status, body structure and stored email remain compared.

Mutation evidence `shape-mask-negative.json` records original UUID response versus `{"id":"broken"}`, both becoming `{"id":"<uuid>"}`. No binary or committed driver was modified for this check.

## FlowResult contract and matrix

Frozen `packages/control/src/oauth/pluginFlow.ts:316–318,532–541` applies `isFlowResult` after generator completion, before persistence. It requires an object, non-null object secrets, each of accessToken/refreshToken/apiKey/idToken **null or string**, and non-null object providerData (arrays technically satisfy this). It does **not** validate expiresAt or accountEmail. Both finish and poll call provider.exchange, hence step name **exchange**, not poll.

OpenAI's frozen `oauth.ts:95–103` converts non-string refresh/id tokens to null; Anthropic `oauth.ts:77–89` retains non-null refresh values. Thus the differing host rejection is frozen behavior, not a Rust parser artifact. Access token is already checked by each provider; apiKey is constructed null; Anthropic idToken is constructed null; OpenAI idToken normalized string/null; providerData constructed as an object. The new Rust refresh-token check is sufficient for the remaining variable secret type in these two built-ins; it is not a general implementation of isFlowResult for future providers.

Independent **196 pairs, all equal**: two providers × finish/poll × seven fields × seven types. Full responses and decrypted selected persistence fields: `matrix/{ts,rust}.rows.json`; compact `matrix-summary.json`. Every table cell below applies to **both finish and poll**, all comparisons equal. A=absent, N=null, S=string, #=number, B=boolean, []=array, {}=object.

| Provider / token input | A | N | S | # | B | [] | {} |
|---|---:|---:|---:|---:|---:|---:|---:|
| both access_token |401|401|200|401|401|401|401|
| anthropic refresh_token |200|200|200|502|502|502|502|
| openai refresh_token |200|200|200|200|200|200|200|
| both id_token |200|200|200|200|200|200|200|
| both expires_in |200|200|200|200|200|200|200|
| anthropic account.email_address |200|200|200|200|200|500|500|
| openai ID-token email claim |200|200|200|200|200|200|200|
| both providerData / apiKey input fields |200|200|200|200|200|200|200|

401: AUTH `token endpoint returned no access_token`; 502: UPSTREAM `anthropic oauth exchange returned something the host cannot use`; 500: INTERNAL `internal error`. OpenAI non-string email becomes null. Top-level providerData/apiKey token fields are ignored by these built-ins: their probes **cannot inject arbitrary FlowResult fields** and are not evidence of arbitrary plugin-result validation. JSON cannot express undefined/functions/symbols/bigints; absent covers undefined property access. No claim to all possible numeric magnitudes or nested variants; prior X2 expiry ruling remains.

The `.map_err(|_| internal())` applies only to email_text, whose only current error arm is SQLite arrays/objects. Postgres arms return Ok; no new swallowing of a PG conversion error is present by inspection. A live Postgres differential was not run.

## Lifecycle and concurrency

I1 consumption now belongs to the detached task after complete/failed peek and before flight removal/publication. Last-waiter cancellation no longer skips it. Both providers, success/refusal/transport-close/timeout: one token request; success one credential, failures zero; subsequent poll 400 BAD_REQUEST `unknown or expired authorization`. `lifecycle/` has 10 equal pairs. Its initial close happened immediately; separate `close/` (2 equal pairs) delays transport close 1 s, guaranteeing waiter already gone. Timeout uses 31-second delayed reply, abort at 100 ms and observation after 30.6 s. Detached finish retention is also exercised by the expanded stock driver.

**Deterministic held-request race**, `race.ts`: start poll; wait until first token request observed; call finish; stub holds first response until second token request arrives, then releases both. Both providers/binaries: **two requests, two credentials, two 200 responses**, then poll unknown/expired. `race/` 2 equal pairs. This is inherited frozen behavior, not a defect. Earlier unordered race observation is superseded by this controlled ordering.

**SIGTERM:** send signal 200 ms into 1 s token exchange, keep client connected. All eight processes exited 0 with exactly one persisted credential:

| Provider / route | TS shutdown ms | Rust shutdown ms |
|---|---:|---:|
| anthropic finish |822|822|
| anthropic poll |834|819|
| openai finish |817|815|
| openai poll |819|816|

Evidence `signal-<provider>-<route>/{ts,rust}/signal.json`, DB/logs. Four response/persistence pairs equal; duration is an observation, not equality-masked semantics. SIGTERM after disconnect is not measured.

A waiter entering Rust after pending deletion but before flight removal still subscribes to the existing flight and gets its result. Frozen deletes its flight in finally before pollOutcome takes pending, so that precise internal phase is not identical; frozen a poll starting after take sees unknown. This micro-window was not forced in a unit test. In the current synchronous MemoryCoord delete path there is no intentional await suspension between delete completion and flight removal, though another runtime thread can enter. After completion/removal a new poll is unknown on both (measured). No deterministic defect claimed from the unforced window.

Publication is persist → authoritative re-read/patch → answer, not a transaction covering request routing. Requests during the interval can observe old state; only post-ack is ruled here. On concurrent deletion the helper removes the entry if re-read returns None. If deletion occurs after its read, ordinary subsequent config publication semantics apply. Publication failure warns and returns success; no failure-injection proof of a strict unconditional visibility guarantee. Spawn-blocking queue/writer lock wait has no explicit timeout; saturation could delay acknowledgement indefinitely, as with the existing refresh path. Not load-tested. No new cancellation regression observed in stock probes, but reconnect-specific cancellation under deliberately blocked publication was not forced.

## Independent visibility measurements

Clean isolated visibility run `visibility/`: **20 trials per side per provider per mode**, unique virtual model per trial, 650 ms pre-publication wait for reconnect setup, first request without retry for reconnect. Fresh-connect retry sampling every 50 ms; measured latency includes model creation and HTTP overhead. All final successful wires carry the expected new bearer and answer `fixture answer`.

| Mode / provider | TS first success | Rust first success | TS min / median / max ms | Rust min / median / max ms |
|---|---:|---:|---:|---:|
| fresh / anthropic |20/20|0/20|3 / 5.5 / 14|311 / 361.5 / 466|
| fresh / openai |20/20|0/20|3 / 4 / 8|312 / 316 / 517|
| ordinary reconnect / anthropic |20/20|20/20|3 / 4 / 17|2 / 3 / 5|
| ordinary reconnect / openai |20/20|20/20|3 / 4 / 13|2 / 4 / 8|

Worst observed fresh lag **517 ms**, all within the accepted 1 s bound. These results do not repair R1's separate absent-entry case. Full sample lists `visibility-summary.json`; raw attempts/wires in `visibility/{ts,rust}/*-routable.json`. Reported fresh lag includes newly pinned model publication, as the committed driver does.

Earlier exploratory long runs are preserved, not silently discarded: `driver/` reused model names between fresh trials, so stale pins selected prior credentials; `unique/` corrected names but long-lived shape-test credentials triggered background refresh wires, producing one extra-wire failure and one start-wire mismatch. `visibility/` isolates visibility from those shape fixtures and uses distinct models. No product change was made between these runs; ordinary reconnect first-request success was 20/20/provider throughout.

## Driver review details

Expected classes now counted exactly: provider-list 12, unported-provider 6, fresh visibility-lag 2. Frozen refusal status/code/message asserted. Frozen kimi/kilo/muse 502 UPSTREAM begin-threw; grok start-threw. Antigravity/qoder pinned to 200/no error/URL string/43-char flow, but not the complete authorize URL/response payload; their exact payload is outside ported-provider scope. Successful reconnect-first rows explicitly require both status 200 and valid=true, so identically broken sides cannot pass.

Visibility class requires frozen first status 200 and valid result; Rust valid result plus delay <=1000 ms. Never-routable yields valid=false; a successful response at 5 s has delay>1000, also fails. It does not require Rust first failure. Fetch itself lacks a per-call timeout, so a hung inference response can hang the harness instead of printing a bounded failure (pre-existing harness characteristic).

Negative control independently rerun: `baseline.log` **353 rows / 349 failures / 0 expected**, including three failed class counts; both tables exist, no validateStart crash. Row-name comparison `row-name-diff.json`: only four old inference start/result names removed and replaced by visibility/reconnect rows; 183 old names preserved. Existing disconnect rows strengthened with post-consumption request/credential counts; delay shortened to 500 ms with abort at 100 ms. No wholly vacuous new row identified. Existing success/timestamp masks retain validation; new shape-row ID mask has R2's gap.

## Gates and limitations

### Faithfully reproduced inherited behavior

- Poll on these PKCE providers exchanges an empty authorization code.
- A poll already inside exchange and a simultaneous finish can each exchange and create a credential; the held-request test proves this on both sides.
- Anthropic retains non-string refresh values until the host rejects them; OpenAI normalizes them to null first.
- Scalar Anthropic email values can reach SQLite; object/array email fails generically. OpenAI ignores non-string email claims.
- Connected finish/poll exchanges drain during the measured graceful SIGTERM sequence.
- New-connect polling lag remains an explicit controller-approved difference, not faithful timing parity; X2 expiry representation remains separately parked.

No cargo builds/tests run by reviewer. Read implementer `fix-2/*-2.log` and adjacent exit files, independently parsed in `gate-scan.json`: workspace **185 summaries, 1271 passed, 0 failed, 19 ignored**, exit 0; clippy/fmt exit 0 with zero FAILED/panicked/error lines. TSV diff matches intended single reexport and single string-only function. Dispatch-size gate passed, 5496 bytes under unchanged 5500.

Controller `gates-2/done` existed at final check; read logs: connect 353/0/20; openai-ns 56/0; run.ts all equal; admin 20602 equal/27 expected/0 failures. All four exit 0. Summary copied to `controller-gates.txt`. Independently rerun stock driver also exits 0 (`stock.log`). No controller completion was awaited or polled.

Additional limitations: no blocking-pool saturation, forced failed-publication test, controlled deletion exactly during snapshot read, or injected delete/flight-removal interleaving; no live PG. These are not represented as passes. Controller new-connect visibility ruling accepted; reconnect missing-snapshot counterexample remains blocking.

## Probe counts

Final selected executions (array/row pairs, not individual HTTP calls):

| Evidence | Pairs | Equal | Different |
|---|---:|---:|---:|
| stock |353|333|20 expected|
| matrix |196|196|0|
| lifecycle |10|10|0|
| delayed-close |2|2|0|
| held race |2|2|0|
| SIGTERM |4|4|0|
| visibility |160|120|40 expected|
| missing snapshot finish |80|40|40 unexpected|
| missing snapshot poll |4|2|2 unexpected|
| **Total** |**811**|**709**|**102 (60 expected, 42 unexpected)**|

Counts include separately executed lifecycle/held-race confirmations, exclude negative-control and superseded exploratory runs, and compare normalized result semantics (timings reported separately). Negative control: 353 names/349 failures, of which three are class-count failures rather than response pairs. R2 is a separate mask mutation experiment, not an extra gateway pair.
