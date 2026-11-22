APPROVE

# A3 final review — c86aa862

Approval is for **A3 body capture**, across both review rounds, at `c86aa86229a3fb20622fc7f2eeba2885c91ec5b8`. **Zero outstanding Critical/Important/Minor findings.** Round-one I1, I2, and M1 are closed. This is not a blanket approval of unrelated migration features or their accepted divergences.

Reviewed `a253cf04..55ab3a5b`, `660e1872..478294f8`, and merges `d58b82ca` and `c86aa862`. Independent execution used the supplied merged binary, SHA256 independently confirmed as `aa3554543293a98b5cdb413d766021d3b339b7a53f5f861eb53b67741fb6f9fd`. Frozen `apps/` and `packages/` remain identical to `1780bb39` (empty diff). No repository edits, builds, commits, or delegated agents.

## Findings resolved

### I1: termination-bound provider capture — closed

**Code comparison:** Frozen `apps/gateway/src/dispatch/index.ts:1041–1047` aborts the shared dispatch signal in finally; `packages/providers/src/http-client.ts:142–153` destroys the outgoing socket; `apps/gateway/src/bodyCapture.ts:198–225` retains received bytes and marks failed drains truncated.

Rust `crates/omni-gateway/src/dispatch.rs::run` constructs the transport scope **outside** the async-stream body and moves it into that body. Thus dropping even an unpolled generator drops the guard. The guard spans the whole candidate/credential loop, not an individual attempt. `body_capture.rs::{DispatchScope,Observer,CaptureHttp}` uses a retained watch state, scoped by the parent request ID. A classifier scope cannot signal parent termination. `omni-providers/src/http/body.rs::start_stream` races reads against cancellation, prioritizes cancellation, drops the owned source/socket **before** ending/dropping the observer, and then wakes settlement. `CaptureCompletion::persist` also signals termination defensively for pre-dispatch exits.

Termination audit:

| Path | Result |
|---|---|
| Normal terminal event / non-stream client consuming provider SSE | Run returns; scope terminates held tee; partial response marked truncated, as frozen |
| Client abandonment / dropped generator | Guard drops; detached capture no longer owns an unlimited lifetime |
| Fatal upstream error / exhausted candidates | Error return/end drops scope; settle cannot await a remote held tail indefinitely |
| Candidate/credential failover | Attempt cleanup does not drop dispatch scope; later inference still captures |
| OAuth auth retry | Inner retry does not drop scope; refresh remains unwrapped; both inference calls retained |
| Request deadline | Existing dispatch timeout unwinds/drops run; scope terminates tee |
| No-candidate / pre-dispatch rejection | No transport drain; defensive persistence termination is safe |
| Shutdown | Existing request/worker teardown drops dispatch; callback settlement no longer depends on remote EOF |

**Independent paired reproductions, fresh namespaces:**

- Original `tail-ns.sh`: both files **2739 bytes**, row truncated=1; no `TAIL_AFTER_TERMINAL`; attempt truncated=true; client 200. Frozen-reader decryption and both digests checked by the probe. `tail.exit`: **0**.
- Original `stall2-ns.sh` (stub idle timeout disabled, tail held): frozen persists in **0 ms**, Rust **11 ms**; both same 2739-byte/truncated artifact. `stall2.exit`: **0**.
- Original `shutdown-ns.sh`: both persist one body, frozen **0 ms**, Rust **10 ms**; both exit within five seconds on SIGTERM, without SIGKILL. `shutdown.exit`: **0**.
- Added **5xx first candidate → successful second candidate with held terminal tail**: both HTTP 200; two attempts; first buffered error untruncated, second partial stream truncated; exact canonical comparison of artifacts, metadata, files, read routes, client and exit class passes.
- Added **OAuth 401 → refresh → successful retried inference with held terminal tail**: two inference attempts, exactly one refresh, refresh absent from artifact; both captures settle and match. The preceding two cases are **12/12 comparisons**, `extra3.exit`: **0**.
- Added **first candidate emits retryable SSE error but never closes → second candidate succeeds and holds EOF**: two attempts, both truncated, retained error event and final success; **6/6 comparisons**, `miderror.exit`: **0**. This tests independent earlier-attempt draining and final cancellation, not just a buffered 5xx.

Full raw artifacts remain under `tail/`, `stall2/`, `shutdown/`, `extra3/`, and `miderror/`. Additional scripts are evidence-only copies of the driver. Two failed probe setups are retained: `extra.exit` **1** queried nonexistent fixture table `models`; corrected `extra2.exit` **1** incorrectly required the *first buffered error* attempt to be truncated. Corrected `extra3` checks the final held stream. Neither failure is a product mismatch.

### I2: operator body-row cell semantics — closed

Frozen `packages/store/src/sqlite/bodies.ts:36–43,129–147` and `packages/control/src/bodies.ts:43–62` are now reflected by `omni-store/src/bodies/sqlite.rs`, read-side `pg/bodies.rs::BodyReadRow`, and `omni-control/src/bodies.rs`:

- request_id/at/size_bytes retain JS cell projections; strict numeric equality to one determines truncated.
- Unknown/non-string detail state becomes none. Null path short-circuits; otherwise invalid path types fail only when frozen would attempt a path read.
- Null digest disables checking; non-null non-string digest cannot match a hex string. Missing acquisition still takes precedence over digest corruption.
- Write-side metadata stays typed. PG typed values convert to the JS read carrier; no PG-runtime claim.

Original **17-cell** probe rerun: all match, including the three previous blockers. Present admin GETs now return **200** with `at:0.5`, `sizeBytes:10.5`, and `truncated:false` respectively. Viewer/anonymous remain refused. `probe.exit`: **0**.

Four additional independent real-HTTP route cells (`cells.exit`: **0**):

| Mutation after valid capture | Frozen and Rust admin GET |
|---|---|
| at TEXT `operator-text` | 200, same string preserved |
| size_bytes BLOB `41 42` | 200, `sizeBytes:{"0":65,"1":66}` |
| sha256 numeric 1 (TEXT-affinity storage) | 200, corrupt, artifact null |
| detail_state BLOB spelling ready | 200, none, artifact null |

Both files were opened with the frozen reader before mutation. `check.ts` independently asserts these explicit projections and the original three fixes, parses the old probe's route-body strings, then compares with the new narrow normalizer. **24/24 paired cells asserted** = 17 original + 4 new + 3 lifecycle reproductions; `check.exit`: **0**. The legacy probes' printed `DIFFER routes` comes only from raw ID/time strings; their permissive “equal” banners are not used as verdicts.

The new **196-case** repository oracle is structurally independent: actual frozen repository + control handler read the same SQLite file/ciphertext, not Rust-projected metadata. Production-affinity and no-affinity fixtures are both tested. It restores state between readers so frozen missing/corrupt observation writes do not bias Rust. Controller final workspace exercises this test. This addresses the round-one route-oracle circularity.

### M1: overbroad normalization — closed

Read `conformance/e2e/body-capture-normalize.ts` and negative tests. Only the actual minted requestId and identified row/artifact/route times and known response-envelope generated seconds are substituted. Arbitrary nested client timestamp fields and unrelated UUID literals remain significant; SSE data is parsed rather than regex-erasing arbitrary payload timestamps. Independent run: **3 tests / 7 assertions / 0 failures**, `normalizer.exit`: **0**. Fresh strict body-driver run additionally passes using this normalizer, not the round-one broad helper.

## Merge review

- **d58b82ca (I2 → A3):** diff against first parent contains the intended nine I2 files. Shared write preparation/capture lifecycle is unchanged. Read/write metadata separation is preserved.
- **c86aa862 cli_cell auto-merge:** compared against both parents. The former Cell implementation is replaced by `pub use omni_store::operator_cell::Cell`; X3's `table_text`, `scalar_string`, `scalar_number`, json/string/number helpers, and `bind_number` plus its test survive. New Cell::read directly matches ValueRef with the same malformed-TEXT replacement and INTEGER→f64 projection as old bun_cell→Cell. BLOB/object semantics are retained. It remains operator-only, not reused by strict auth/snapshot readers. No semantic conflict found.
- **c86aa862 server.rs auto-merge:** compared against both parents. A14 pathname/static-path versus normalized-route split remains intact; A3's gates, incoming parsed capture, request-local wrapped deps, error/JSON responses, SSE individual frames/keepalives, and held snapshot all survive. Requests route through `api::route` to `admin_routes::route`, which still recognizes RequestBody; static path is not accidentally used as the inference/admin routing key. X3 model-error sanitization survives independently. The live body GETs and all three inference surfaces in the rerun confirm connectivity. No semantic conflict found.

## Gates and evidence

**Independently rerun in this round:**

- Body capture: **186 equal / 0 failed, 31 cells**, `driver.exit`: **0**. Includes the added terminal-tail, held-tail, and SIGTERM cells. Original round-one base-red evidence remains applicable; the implementer's I1 red evidence is additional, not an independently repeated round-two red run.
- Original tail/stall2/shutdown/probe and four new real-route cells: **24 paired cells**, explicitly checked, all equal.
- Three new multi-attempt held-tail cells: **18 equal / 0 failed**.
- Normalizer: **3 passing tests, 7 assertions**.

**Controller evidence inspected, not represented as my own reruns:** all **24** `.exit` files presently under `/tmp/opencode/a3/merged/` contain **0** (the supplied summary said 23; directory also contains both e2e/run records). Workspace **212 successful summaries, 1,375 pass entries, 0 failed, 37 ignored**; clippy `-D warnings`, fmt, dispatch **3480 < 5500**, body driver 186; provider/transport/connect/smart-router/idle/maintenance/run suites and six CLI corpora pass. X3 **4106 pairs: 3997 equal, 109 explicitly accepted, 0 unexpected**. `ctl2/admin.exit`: **0**, **20602 equal / 27 expected divergences / 0 failures**; first controller fixture SQLITE_BUSY attempt is not comparison evidence. These accepted divergences are not erased by A3 approval.

No build was needed: used the exact verified merged binary. Consequently no additional round-two Cargo/workspace command was required or run. Round-one independent workspace/clippy/fmt/run and current merged controller gates are clearly distinguished above.

## Complete differences and unverified boundaries of this A3 approval

1. **No accepted new A3 behavioral mismatch remains.** Random ciphertext/nonces/digests differ intentionally and each digest is validated against its own bytes. Request UUID versions/times are pre-existing dynamic differences; only identified minted/generated occurrences are normalized, not arbitrary input fields.
2. **Frozen behavior, not brief improvements:** filesystem artifacts use recursive mkdir + direct write, not atomic rename; file precedes row upsert; failed SQL can leave an orphan; overwrite may leave an earlier-day artifact until sweep. GET accepts arbitrary decoded IDs, malformed escapes follow existing absent/null handling, and no new no-store header is added. Masking is frozen best-effort (false positives and uncovered secret shapes included), not a credential-leak guarantee. Omission/truncation and retained last frames deliberately lose payload data exactly as frozen.
3. **Failure diagnostics:** log event name/requestId/reason presence match; OS-specific reason strings differ (round-one ENOTDIR wording). Ciphertext/key failure returns corrupt rather than exposing decryption diagnostics. True ENOSPC, real permission denial, and absent-key boot were not independently fault-injected; directory-block and refused-row failure isolation were independently checked in round one. No atomic-write or power-loss guarantee is claimed.
4. **Postgres:** implementation/code paths reviewed, typed read conversion and shared decoder covered by tests; no running PG gateway, server failure/recovery, transaction, or PG administrative route matrix was exercised. Live gateway/control evidence here is SQLite.
5. **X1/pure compatibility:** pure UTF-16, lone-surrogate, masking/bounding, encryption and bidirectional cross-read evidence comes from reviewed differential tests and workspace execution. Independent live probes use scalar Unicode; they do not establish every malformed-code-unit path end-to-end. Existing 32 MiB gateway incoming limit and 1 MiB buffered provider-error limit differ from unbounded frozen paths and predate this item; A3 does not fix or waive those migration limitations.
6. **Request-path scope:** all three surfaces, errors/no candidate/invalid input, retry, fallback (buffered 5xx and mid-stream error), abandonment and held tails now have evidence. All permutations of multiple credentials/providers, RTK-on payloads, classifier/screening paths, every deadline timing, or simultaneous refresh/cancellation were not independently exhaustively exercised. Classifier exclusion and lifetime scoping were audited; existing integration/classifier and smart-router gates supplement but do not replace a complete capture-on classifier matrix. count_tokens and /v1/models intentionally install no collector in frozen or Rust.
7. **Finish ordering/overload:** FIFO fence orders body callback after attempted Finish/debit processing. Pre-existing failed/dropped usage-row debit behavior and unported plugin lifecycle events differ from frozen and remain outside A3. Writer overload, consumer failure, barrier/fence stress, simultaneous shutdown registration, and enabled high-concurrency capture were not fault-injected here. Artifact ceiling is not a total-memory bound: per-attempt buffers and adapter tee queues can exceed it, like frozen tee buffering.
8. **Maintenance/concurrency:** shared Node path join, file-first prune/cap, orphan claim recheck and raw maintenance ID/path cells were audited; existing tests/controller maintenance pass. No independent destructive prune-vs-write race, concurrent corruption/file growth stress, or crash recovery campaign was run. Existing SQL/FS race windows are not strengthened by this item.
9. **Performance:** OFF creates no collector, watch channel, decorator, capture callback or per-chunk allocation. I1 adds a default transport scope virtual call returning None (no allocation) per ordinary dispatch. Reviewed controller seven rotated rounds: median **base 7053.87 vs merged 7047.07 rps** (−0.10%), individual ranges base 5946–7869 / merged 6321–7710; zero body rows. This noisy debug host measurement does not confirm the implementer's −5.18% result and does not prove release throughput/latency/memory parity. No independent second burst was run.
10. **Driver limitations:** grouped comparison counts are not independent behavioral cases; final driver is 31 cells × 6 comparison groups. It uses frozen mask/bound transformations for independent wire-output assertions, so cannot establish fidelity of content intentionally removed before storage. Special abandonment compares artifact/drain behavior rather than arbitrary transport chunk boundaries. New negative normalizer tests close the specific M1 blind spot but are not a proof for all possible generated-envelope lookalikes.
11. **Unrelated migration acceptance:** controller X3/admin/connect expected divergences and existing unsupported-provider/provider-list behavior remain their owning items' documented exceptions, not A3 capture parity. CLI body-reader feature remains E3, not implemented by this approval.

Final worktree check: clean, detached at **c86aa862**. Nothing to restore. All round-two evidence is under `/tmp/opencode/a3-review/r2/`; original reports/evidence were only read (new probe scripts and summaries stayed under reviewer evidence).
