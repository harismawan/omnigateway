# Rust migration roadmap (remaining work after CLI catalog, 9f22ec23)

Source: read-only inventory ses_e34c713c6ffeLoim0Xtydrbc5o (Nov 11). Implementers opus-pr#high, reviewers gpt-6-astra#high. Serial implementers only (shared gateway binary, no worktrees per repo rule). Each row: brief → implement → review → fix loop → mark done here with commit.

Done so far: slice 1 gateway (custom provider, /v1/*, /health, writer, limiter, benchmarks); CLI keys (8), settings (2), models list/show/put(-f, --from-catalog)/rm/catalog.

## A. Single-node gateway parity
- [x] A1 (S) /metrics + telemetry registry (same series, cardinality cap) — 6e63d9f3+bb6d3401, reviewed clean
- [x] A2 (S) static serving OMNI_STATIC_DIR + SPA fallback; plugin boot warning; /api/plugins* 501 — 6e63d9f3+bb6d3401, reviewed clean
- [x] A3 (M) body capture: OGBA seal, request_bodies files, capture behind the three gates (tee bound to dispatch termination), GET /api/requests/:id/body (raw-cell reader) — merged 7e3c3042, approved after 2 review rounds (a3-review2.md); post-merge gates green; CLI `bodies` stays E3
- [x] A4 (M) admin auth core: argon2, sessions, cookie, /api/status setup login logout, /api router — 369aaf0d+49923524, reviewed clean
- [x] A5 (M) admin keys/models/catalog/settings/password routes — 5da6af7e..9248cd45, reviewed clean (3 fix rounds)
- [x] A6 (M) credentials routes — d2757acb..9624fa13, approved after 2 fix rounds; routing-path bench vs 66020396: no measurable regression; PG gateway leg + live-PG proof + PG row isolation → D4 + encrypted credential writes + health
- [x] A7 (M) usage, logs, logs/export, nodes — 6d2a7a8e..d0c11d29, approved after 2 fix rounds (a7-r2-review.md); bounded read-only readers (export pool 4, report lane 4); usage-large peak RSS 58–69 MB vs TS 153–156 MB; documented difference: HEAD export lacks transfer-encoding; requests/:id/body → with A3; agent-setup → after CLI branch merge; PG readers → D4
- [x] A8 (S) /api/client/* (7) — functional review closed; speed review approved (a8-speed-review.md), five controller E2E rounds faster at cap; bounded eager-reservation tradeoff recorded.
- [ ] A9 (L) /api/stream WebSocket + console live view
- [ ] A10 (M) database routes, quiesce latch, lifecycle restart/shutdown
- [x] A11 (S) maintenance loop (pruning, heartbeat) — merged 669984ca, approved after 3 review rounds (a11-review3.md); post-merge gates green
- [ ] A12 (S) models dry-run (API + CLI)
- [ ] A13 (M) OTLP export
- [x] A14 (S) outbound idle timeout (Bun idleTimeout 255 s parity incl. inference exemption, completed-exempt keep-alive, 10 s initial headers, inbound throughput rule) — merged f9950f56, approved after 3 review rounds (a14-review3.md); post-merge gates green
- [x] A15 (S) /api/connect/* routes (start, finish, poll) over the B1 provider functions — merged 78e322c2, approved after 5 review rounds (a15-review5.md); connect publishes via full snapshot rebuild before ack (user ruling A); post-merge gates green

## B. Providers
- [x] B1 (M) OAuth framework: refresh() with token_version CAS, 60 s sweep, snapshot publication (W→P mutexes) — merged 8f6f84f9, refresh approved after 3 review rounds; /api/connect/* HTTP routes → A15
- [x] B2 (L) anthropic — merged 8f6f84f9, codec approved after 6 rounds (b2-codec-r6-review.md); bench 7 rounds vs 04c3c5af: overhead-c1 +1.5 %, chat-stream −0.8 % (inside base range)   - [x] B3 (L) openai/codex — merged d6238477; codec + integration approved (b3-request-rereview.md, b3-decode-rereview.md, b3-integration-rereview.md); post-merge workspace 1,264 passed, 56 HTTP rows + run.ts 47 rows equal; open, non-blocking: deep native-disconnect case, TS PG write differential, bench load-wait needs Bash 5+; connect routes → A15   - [x] B4 (L) antigravity — merged 11e72751 (+073e866b listing row); request codec approved 998eab1c, decoder 38c7b5de, integration c005c22d (b4-integration-rereview.md); post-merge gates green; usage probe stays with B10
- [deferred] B5 (M) grok  - [deferred] B6 (M) kimi  - [deferred] B7 (M) kilo  - [deferred] B8 (M) muse  - [deferred] B9 (M) qoder — USER focus ruling Nov 15: not being ported now. Consequence to settle before cutover: the Rust gateway refuses requests routed to these providers (dispatch answers INTERNAL for a provider without an adapter) and /api/connect refuses them; credentials of these providers in an existing database stay stored but unserved.
- [ ] B10 (M) quota poller + oauthUsage + quota routes + resets/redeem

## C. Request-path features
- [x] C1 (M) smart router + guardrail (replace screen() stub) — merged 69117cde, approved after 2 review rounds + user ruling on the classifier scheduling difference (c1-rereview.md, docs/smart-router-compatibility.md); post-merge gates green
- [x] C2 (M) RTK with its tests — merged c7fdf1f3 (reviewed)  (C3 ponytail: DROPPED, operator plans to remove the feature)

## D. Cluster
- [x] D1 (L) Postgres store — feat/rust-postgres-store 2a2bcbfb, reviewed clean merged 9b04c3a1 (TLS + gateway wiring are integration gates)   - [x] D2 (L) Redis coordination — feat/rust-redis-coord 5b212de1, reviewed clean merged 51a54e5a (TLS, metrics export, gateway wiring are integration gates)   - [x] D3 (L) cluster rate limiting — feat/rust-cluster-ratelimit b192a1d7, reviewed clean merged f7c48e57 (D4 must honour the 7-point contract in d3-r2-review.md)
- [ ] D4 (M) breaker/health shared queue, /health mode, /api/nodes, cluster bench vs targets

## E. CLI (remaining 49 commands)
- [x] E1 status, admin set-password, db group — merged 4b80b738 + stored-cell parity 6d7c8268 (six fix rounds; cli-stored-json-review5.md); five accepted hand-altered-table differences   - [ ] E2 credentials group + connect
- [ ] E3 logs, logs export, usage, bodies, console, quota group
- [ ] E4 start/stop/restart/service install/uninstall (Rust binary), doctor
- [x] E5 setup claude/opencode, plugin * refusals (exit 1), real --help — merged 4b80b738 + 6d7c8268; post-merge matrix 54/54 green

## F. Packaging and cutover
- [x] F1 CI cargo + release assets — merged 66020396 (arm64/macOS + publish proven only by CI)   - [x] F2 Dockerfile — merged 66020396; k8s Recreate staged on feat/rust-first-rollout d461aba0 for the promotion PR
- [ ] X1 lossless UTF-16 stream text end-to-end (shared IR StreamEvent text, collectors, all egress dialects; parked B2 codec I3/I5; B3 OpenAI decoder: four retained-RED cases in conformance/openai-lossless-blocker.md, test `lone_surrogates_match_ts` ignored until X1; ALSO non-numeric upstream usage counts — TS keeps string/object/array/boolean in Usage, Rust Usage is f64: B2 codec I5-exotic and B3 conformance/openai-coercion.md rows 107/108/131/132/137/138/143/144, test `malformed_usage_matches_ts` ignored until X1; ALSO upstream numbers beyond the double range (`1e309`): serde_json Value cannot hold ±Infinity so the whole event is skipped where TS carries Infinity — B3 decode review finding 1, six reviewer streams as an ignored test; custom and Anthropic decoders share deep::parse and are to be observed)
- [ ] X2 TS-exact credential expiry carrier (fractional/non-finite expires_at as REAL/NULL through store, snapshot, router; reading a TS-written REAL must not drop the credential; PG oracle) — parked from B1
- [x] X3 malformed id cells on operator routes (user option A: coercing operator readers, strict auth/routing/snapshot readers) — merged 0a571053, approved after 3 review rounds (x3-review3.md); corpus 4,106 / 0 unexpected, accepted 94 routing-strict + 15 v1-models-frozen-json (conformance/e2e/x3-accepted.json); post-merge gates green
- [ ] F3 cutover runbook, npm final notice, cross-read gate SQLite+Postgres, full conformance gate
