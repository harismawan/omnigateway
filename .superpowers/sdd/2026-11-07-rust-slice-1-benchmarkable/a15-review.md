# A15 independent review — REQUEST CHANGES

Reviewed frozen `1780bb39` against `665ca7e5..0e4a07f9`. No product changes, builds, commits, or subagents. Evidence root: `/tmp/opencode/a15-review/` (paths below relative to it). The implementer handoff was treated as claims.

Binary: `/tmp/opencode/a15/verify-3/rust-final`, SHA256 `910c6f05ec12c68d25ebb19f29be611338c8b97ad8c537f00c79f6f3bb9160b6`; frozen `/tmp/opencode/a8/ts`, SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. `git diff --stat cf3f9600..0e4a07f9` confirms only connect.ts driver changes, 114 insertions/11 deletions. Controller `gates-1/rust` was absent at probe startup. All execution used private HOME, explicit gateway environments, Bun `--no-env-file`, and loopback-only network/mount namespaces. Copied driver imports/CLI cwd point to the worktree, never the main checkout. Scripts and databases remain in evidence.

## Important findings

### I1. A disconnected poll persists successfully but leaves the flow reusable

Frozen: `packages/control/src/connect.ts:289–298,417–433`: `pollOutcome` continues to take the flow after the exchange, regardless of the HTTP client's interest. Rust: `crates/omni-gateway/src/connect.rs:76–86,91–103`: the spawned exchange owns completion, but consumption remains in the cancellable HTTP waiter. When its last waiter disappears, the task removes the flight and saves the credential without removing pending state.

Paired reproduction, both anthropic and openai:

1. Authenticated `POST /api/connect/start`, body `{"provider":"anthropic","label":"anthropicpoll-disconnect"}` (repeat openai).
2. `POST /api/connect/poll`, body `{"flowId":F,"code":"review-code#S"}`; stub delays 500 ms then returns 200 `{"access_token":"review-access","refresh_token":"review-refresh"}`. Abort the HTTP fetch at 100 ms; wait another 700 ms.
3. Both: one token request and one saved credential.
4. `POST /api/connect/finish` with that same body. Frozen: **400** `{"error":{"code":"BAD_REQUEST","message":"unknown or expired authorization"}}`. Rust: **200** `{"id":"<new UUID>"}`, another token request and another persisted credential.

Evidence: `poll.ts`, `poll-ns.sh`, `poll/{ts,rust}.rows.json`, `poll/{ts,rust}/{anthropic,openai}-wire.json`, `poll/{ts,rust}/omni.db`. Repeated at maximum supported debug logging in `poll-debug/`, same result. UUID masking is only for presentation; raw IDs are in the DB. Fix ownership of consumption, including failure and no-waiter paths, without losing shared-poll semantics.

### I2. Successful connect/reconnect is not immediately visible to routing

Frozen: `packages/control/src/connect.ts:247–258,267–281`; `packages/store/src/sqlite/credentials.ts:248,278,306` emits routing changes. `apps/gateway/src/dispatch/snapshotCache.ts:39–66,68–87` marks stale synchronously and rebuilds on the next routing read. Rust: `connect.rs:383–405` acknowledges only storage; `crates/omni-gateway/src/lib.rs:477` polls every **500 ms**; `crates/omni-gateway-core/src/snapshot.rs:461–505` checks SQLite `data_version` and rebuilds on that tick.

Paired reproduction: start/finish with `{"provider":"anthropic","label":"inference","credentialId":"anthropic-full"}`, code `code#S`, token response 200 `{"access_token":"anthropic-inference-access","refresh_token":"inference-refresh","expires_in":3600}`. A previously configured model `preexisting` is pinned to that credential. Disable the credential and allow 600 ms for publication before reconnect. Immediately after finish, POST `/v1/chat/completions` with bearer fixture key and `{"model":"preexisting","messages":[{"role":"user","content":"hello"}],"max_tokens":32,"stream":false}`.

Frozen first request: **200**, assistant content `fixture answer`. Rust first request: **503** `{"error":{"message":"no eligible credential for model \"preexisting\"","type":"server_error","code":"service_unavailable"}}`. **20/20 trials each side**: frozen first request succeeds; Rust first request fails. Model/key admin calls still occur between finish and inference, so this is not an artificially zero-delay race. Model already exists; this isolates credential visibility rather than newly created model visibility.

Evidence: `extra.py`, `extra.ts`, `extra/{ts,rust}/anthropic-{0..19}-routable.json`, including every attempt, final wire and answer. The stub confirms successful inference uses the new access token. This is inherited snapshot architecture, but materially affects A15's acknowledged operation and is not one of its documented differences.

### I3. Non-scalar account email leaks the binding error instead of frozen's generic error

Frozen: `packages/providers/src/anthropic/oauth.ts:87` forwards `account.email_address`; store binding throws; `apps/gateway/src/routes/http.ts:147–153` maps non-GatewayError to INTERNAL `internal error`. Rust: `connect.rs:374–378` propagates `refresh.rs:350–360` as an already classified GatewayError, bypassing that sanitization.

Paired reproduction: authenticated start anthropic, then finish `{"flowId":F,"code":"review-code#S#ignored"}`. Token stub returns 200 `{"access_token":"review-access","refresh_token":"review-refresh","account":{"email_address":{}}}`. Frozen **500** `{"error":{"code":"INTERNAL","message":"internal error"}}`; Rust **500** `{"error":{"code":"INTERNAL","message":"Binding expected string, TypedArray, boolean, number, bigint or null"}}`. Neither creates a credential. Same difference for `[]` and `[1]`.

Evidence: `probe-first.ts`, `run/{ts,rust}.rows.json` rows `anthropic/email-{}`, `anthropic/email-[]`, `anthropic/email-[1]`, gateway logs and databases in `run/`. Exact fixture and request construction retained in script. This does not reveal token contents, but violates the frozen error contract.

### I4. Workspace gate fails on unreviewed public API inventory additions

Controller gate completed before review delivery. `workspace-test` exits **101**: `owner_reexports_are_pinned` and `public_boundary_inventory_matches` fail in `crates/omni-ir/tests/public_json_boundary.rs:244,101`. The new `pub use super::oauth_start::start` in `crates/omni-providers/src/openai/oauth.rs` and public start function in `openai/oauth_start.rs` are absent from the pinned inventories. Evidence: `/tmp/opencode/a15/gates-1/workspace-test.log:1161–1189`. This is a build-contract finding, not a frozen HTTP difference; paired HTTP reproduction is inapplicable. Review/update the intended public boundary and rerun the workspace gate.

## Minor findings

### M1. Driver does not enforce its expected-divergence count or first-request routing parity

Frozen source expectation is the synchronous invalidation described in I2; Rust driver `conformance/e2e/connect.ts:349–367` retries and records only eventual success. Its stock result is **187 / 0 failed / 18 expected**, while paired evidence in I2 shows all 20 first requests differ. Delay evidence is useful, but the passing comparison does not establish immediate visibility parity.

At `connect.ts:403–413`, exception classes are broader than the handoff implies: some unsupported providers accept either successful TS start or an upstream failure; kimi/kilo assert message but not frozen status/code. At `416–417` the count is printed, never asserted to equal 18. There is no general all-rows-vacuous finding: other checks can fail, and the baseline negative control fails loudly. Tighten the expected classes and count, and explicitly compare the first inference outcome.

Evidence: `driver-final.log`, `driver-final/{ts,rust}.rows.json` versus `extra/{ts,rust}/anthropic-0-routable.json`. Negative control `baseline.log`: base binary exits the driver nonzero at `validateStart` in successRows (`invalid flow id`). It fails loudly but crashes before writing its comparison tables; it does not produce the intended comprehensive red-row summary.

## Snapshot measurements

Measured from finish response through model/key operations to first successful inference; retries every 50 ms. These are observed latency distributions, not an exact bound on publication itself.

| Scenario (20 trials/side) | TS min / median / max ms | Rust min / median / max ms | First-request TS / Rust |
|---|---:|---:|---|
| Fresh credential + fresh pinned model | 5 / 9 / 38 | 471 / 479.5 / 542 | 20 success / 20 failure |
| Reconnect disabled credential, pre-existing model | 3 / 5 / 8 | 55 / 362 / 413 | 20 success / 20 failure |

Fresh model failure is `model "inference-anthropic-0" is not a configured virtual model and its provider could not be inferred`; the second experiment removes this confounder and gets `no eligible credential`. Raw samples: `run/` and `extra/` respective `*-routable.json`. Worst observed Rust latency 542 ms. Nominal refresh lag up to one 500 ms tick plus scheduling/rebuild/observation overhead; code provides no absolute worst-case wall-clock bound under contention or failed rebuild.

## Line-by-line semantic audit and faithful inherited behavior

- Start validation ordering matches for these two providers: provider, reconnect type/trim/read/provider/auth type, label, PKCE, pending put. `credentialId: null` is invalid; absent is skipped. JSON has no present-but-undefined value. Frozen HTTP `readJsonRecord` rejects arrays/primitives as records; Rust field lookup yields no named fields, producing equivalent route errors for tested inputs.
- Label trim uses UTF-16 JS whitespace handling before storage. Lone surrogate `x\ud800y` and astral ` x😀y ` paired successfully through persistence; both SQLite paths replace the lone surrogate at string encoding. No finding merely from Rust's lossy conversion.
- Flow IDs use 32 random bytes, unpadded base64url (43 chars), on both sides. Rust `oauth.rs:14–20` uses OS-seeded cryptographic thread RNG, not a deterministic PRNG seed. Credential UUID: SHA256 of independent 256-bit random state, first 16 bytes, version nibble 4 and RFC variant bits 10 (`omni-crypto/src/codex.rs:25–30,55–57`). Valid v4 layout, approximately 122 random output bits; adequate entropy despite different construction.
- Pending key, JSON field order, nested pending field order, optional credentialId, and 600,000 ms TTL match. At exact expiry both memory coordinators use `expiresAt <= now`. Rust unit test covers exact boundary, but was not run by reviewer. Neither memory KV caps starts or globally sweeps expired KV entries; expired unqueried starts retain memory. This is inherited, not a new defect.
- Finish consumes before callback normalization and token exchange. Missing/wrong-type flow/code validation happens before consume. Poll intentionally sends empty code. Normal concurrent polls share a task. Two simultaneous finishes in the probe produced one token request/one credential and one unknown-flow response on both sides. KV take itself is get+delete, not an atomic shared-coordinator primitive, in both implementations.
- Simultaneously launched poll+finish differed once: frozen two token requests/two credentials, Rust one with poll unknown-flow. Evidence `extra/*.rows.json` row `poll-finish`. Rust defers peek into a spawned task, changing scheduling opportunities. This single unordered concurrency observation is **not ranked as a deterministic defect**; impose barriers after peek/first upstream request to characterize ordering before claiming one.
- Callback matrix (10 pairs) matched: host case, userinfo, trailing slash, leading-zero port, IPv6 mismatch, special-scheme URL acceptance, opaque URL, plus/percent decoding, invalid UTF-8 percent bytes, empty-first duplicate code, whitespace trim and raw multi-`#`. Both compare origin/path only, take first query value, and ignore later split segments after pasted state. Userinfo is not forwarded as credentials; callbacks are parsed, not fetched, so these inputs create no callback SSRF/open-redirect destination. Full WHATWG/Rust URL-parser equivalence beyond this matrix is not established.
- Start response order and constants are aligned: flowId, authorizeUrl, userCode=null, kind=pkce, supportsManualPaste=true, pollIntervalMs=5000. Cargo enables serde_json preserve_order. Stock driver compares parsed JSON/content type, not raw response key ordering; code inspection supplies that part.
- Reconnect disabled/changed-provider/malformed-provider_data-before-or-after-start all matched (8 pairs, `reconnect/`). Malformed JSON errors do not reach exchange; changed provider is not revalidated at finish, and its prior provider_data is withheld. This inherited permissiveness is not a defect here. Stock driver independently rerun verifies deleted rows, token-version increment, replacement provider_data and preserved metadata.
- 31-second token delay: both timeout with 502 UPSTREAM `anthropic oauth exchange threw`, consumed afterward. 10 MiB token body: same 502 and consumption. Rust text reader bounds at 1 MiB (`http/body.rs:256–270`). 40,000-deep ignored token JSON: both 200, no crash. Non-UTF-8 response byte: both 200. Carrier deep-safe Drop/Clone is present; these probes do not exhaust every deeply nested retained account/claims shape.
- `expires_in` absent, 0, negative, fractional, string, null exercised. For `1e21`, both finish 200 but TS stores ~`1.0000000000017947e24`, Rust `9223372036854775807` (Bun JSON read displays 9223372036854776000). This is the **documented X2 integer-carrier difference**, not an A15 blocker: progress.md:669 and migration-roadmap X2. Near-now expiry was masked in the exploratory probe, so it does not prove fractional persistence precision.

## Security and lifecycle

- `serve` calls require_admin before body read; both helpers admit only Admin, not Viewer. Anonymous/admin GET, HEAD, OPTIONS, POST on all three paths paired; unsupported methods do not redeem flows. Viewer rejection confirmed by code, not a minted viewer-session HTTP probe.
- Shared request reader reused. Six paired large/deep-body cases: 40,000-deep arrays produce route validation errors; a 2 MiB padded valid start succeeds on both. This is depth-safety evidence, not proof that every size-bound edge was tested.
- Maximum supported level is **debug**, not trace. Initial exploratory runs configured trace; dedicated reruns corrected this. `debug/` stock driver and `poll-debug/` custom probes contain no tested tokens/ID token/code/verifier/state in logs. `debug-scan.json`: 11 literal secrets/side for stock, 9/side for disconnect wires, zero hits. Success logging names provider and credential ID only. This is a finite secret scan, not a proof of all possible provider error inputs.
- Rust spawned finish/poll exchanges are not registered in a connect-specific shutdown drain. `lib.rs:582–614` drains connections, refresh jobs and publications, not these detached tasks. Frozen lifecycle waits for Bun stopServer/deadline (`lifecycle.ts:79–85`, index.ts:445), with no explicit connect task registry either. Connected waiters benefit from connection draining; disconnected tasks' comparative shutdown behavior requires a signal-timed probe and is not certified here.

## Driver quality / counts

The stock driver was rerun independently: **187 pairs, 169 equal, 18 documented divergences, 0 unexpected** (`driver-final.log`); debug rerun same. No inherited `...process.env`; explicit base environment plus PATH/cert fixture. Random masks generally validate shapes, challenge/verifier relation, original content length, UUID/persistence relation, and time bounds before replacement. Reconnect data is unmasked. Eventual inference equality is insufficient as described in M1. Expected-class assertions do not uniformly check frozen status/code/count.

Independent exploratory record pairs (excluding repeats):

| Evidence | Pairs | Equal | Different |
|---|---:|---:|---:|
| run | 78 | 73 | 5 |
| extra | 47 | 45 | 2 |
| security | 30 | 28 | 2 |
| reconnect | 8 | 8 | 0 |
| poll | 2 | 0 | 2 |
| **Total** | **165** | **154** | **11** |

Of these 11 differences: 3 account-email errors, 3 disconnected-poll observations, 1 unordered poll/finish race observation, 2 X2 expiries, 2 documented provider-list texts. Snapshot **40 additional paired timing/first-outcome observations, all different**, are reported separately rather than hidden by eventual-success rows. Scratch first/extra driver names repeat the start row across trials; tables above count array records, not their smaller Set-of-names console count. Direct JSON analysis compared every array record; the stock 187 row names are distinct. Repeat debug/negative-control runs excluded from pair totals.

## Remaining verification and extensibility

Not verified: explicit TCP RST; live HTTP TTL boundary/restart; viewer-cookie probe; per-byte raw response header/key-order matrix; all WHATWG URL cases; shutdown signal during disconnected task; controlled coordinator take/peek interleavings; deep retained ID-token/account-email/provider_data shapes; exact body-size boundary; OpenAI-specific slow/deep/huge-body variants. TTL/shutdown controlled unit experiments needing a Rust build were intentionally not run: inject a clock at TTL−1/TTL and gated HTTP/coord futures, cancel the final waiter, advance/release, then inspect KV and saves. This review obeyed the no-build restriction.

Controller gates became available at final evidence verification (no waiting/polling). Read `/tmp/opencode/a15/gates-1/summary.txt`: workspace-test exit 101 (I4); clippy, fmt, build, dispatch-size, connect, openai-ns, e2e, admin exit 0. `dispatch-size.log` reports **5496 bytes**, ceiling unchanged. Controller binary SHA256 equals the reviewed binary. Scope is not certified exhaustive despite substantial paired coverage.

Third PKCE provider: extend a typed provider dispatch/flow executor, not only `(id, callback)`. Current `complete` performs one request then token_result; antigravity needs sequential userinfo/loadCodeAssist/onboardUser with intermediate state, per-step transport/error/timeout handling and final persistence only after completion. Its callback label must also become provider-specific (currently OpenAI errors are hardcoded). This is an extensibility note, not a blocker for the two-provider ruling.
