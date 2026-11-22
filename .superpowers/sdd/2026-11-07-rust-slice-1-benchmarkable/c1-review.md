# C1 independent review — in progress

Verdict: **REQUEST CHANGES**. Checkout began clean at 82617fe3c64d030582266f88edd684aa29100543.

## Findings

### Important — already-local aliases incorrectly relabel the client model

Frozen `apps/gateway/src/routes/proxy.ts:719–724,758–764` distinguishes an already-local request from a reroute: when the local model equals the client model it dispatches local-only **without** relabel. Rust `crates/omni-gateway/src/screening.rs:397–401,317–323` returns `Some(client model)` for already-local and then unconditionally rewrites every Start model to that alias. A local virtual model whose target has another model name therefore exposes a different response model on all three surfaces, stream and nonstream.

Paired reproduction: `/tmp/opencode/c1-review/alias.ts`, alias-ns.sh, scratch `/tmp/opencode/c1/w-review-alias`. Set virtual local-model's custom target to local-underlying; send already-local requests. Frozen response model is `local-underlying`; Rust is `local-model`. Upstream bytes and final rows match; **0 equal / 6 different / 0 oracle-invalid**. Only relabel a genuine reroute, retaining local-only revalidation for already-local.

### Important — guardrail classifiers disappear from in-flight request logs

Frozen `apps/gateway/src/guardrail/judge.ts:128–147` installs an onRoute callback and awaits beginLog (and routeLog on failover). Rust `crates/omni-gateway/src/screening.rs:204–224` sets `on_route:false`, then only `JudgeRow::drop` at :126–141 publishes the final row. Smart-router aggregate calls deliberately have no pending rows, but the independent guardrail does have one in the frozen oracle. This loses in-flight classifier visibility and crash recovery of its pending row; final-only comparisons cannot catch it.

Paired reproduction: `/tmp/opencode/c1-review/pending.ts` via pending-ns.sh, scratch `/tmp/opencode/c1/w-review-pending-3`. Guard-only key, nonstream request, local judge responds after 2,000 ms, deadline 5,000 ms; read request_logs at 700 ms. TS has `{requested_model:"judge",status:0,api_key_id:<parent key>}`; Rust has `[]`. Both client responses and final logs match. `pending-3.log`: 0 equal / 1 different / 0 oracle-invalid. Restore the guardrail's pending/route lifecycle, keeping its key attribution and exactly one final completion. Initial pending attempts had overly short client aborts and timer contamination; only pending-3 is the decisive evidence.

Investigation (not yet a separate finding): frozen workers await stopped siblings and cache whole replies already received; Rust drops remaining FuturesUnordered entries immediately on first decisive result.

## Scope and evidence

No product edits or commits authorized or made. Evidence is reviewer-owned under this directory; namespace wrapper scratch uses /tmp/opencode/c1/w-review-*.

## Effectful comparison

Reviewed screening.rs:1–623, full server/dispatch diff, and frozen check.ts/judge.ts/proxy.ts counterparts. Frozen scoped source files have no diff against 1780bb39. Verified frozen/final binary SHA-256 values match the supplied full hashes (`f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`, `022e08ad5bbf351efe15d24c94dbebe3b43f33c577922ce5e6bf066c7698abff`).

* Local validation: both configured models validated before already-local bypass, matching frozen check.ts:224–248. Dispatch options revalidate locality against dispatch's own snapshot (:494–500), including rerouted and already-local requests; on_route:false intentionally correct for smart segment calls. Transforms false is API-only, inherited unported RTK/ponytail; not newly implemented here.
* Cached confidential wins before oversize; threshold is **uncached count >64**, not total count; exactly 64 dispatches. Cache failures not inserted. Keys match structured SHA-256 tuples: smart `(classifier,policy,text)` shared across keys, guard `(key,policy,model,capped system,human[],toolResults[])`. Both verdicts cached, process-local static caches, one-hour insertion TTL, 10,000-entry LRU; hits move recency but do not extend expiry; `expiresAt <= now` misses.
* Scheduling is a **rolling pool**, not batches. Frozen check.ts:286–311 has four looping workers. Rust :445–480 refills FuturesUnordered to four after each completion. First observed confidential/failure decides; subsequent work is stopped. Distinct implementation: frozen composes client/shared-stop/per-call timeout signals and awaits Promise.all of workers; Rust uses future ownership/drop for client/shared stop, tokio timeout for each call, and immediately drops pending siblings. Whole replies already received can affect observed tokens/cache around the stop race; see race evidence below. Do not claim exact simultaneous scheduling equivalence from unordered wire comparison.
* Smart aggregate: one owner after cache/oversize bypass, classifier requested_model, key attribution, first routed call in call order supplies provider/model/credential, attempts count started calls, five usage/cost fields summed including observed stopped-call usage. RAII cancellation writes 499/interrupted. Frozen :311–336 waits for all stopped-call logs first; Rust :352–377 reads logs on drop after pending futures drop. Child dispatches have no Finish owner; only aggregate writes completion. Independent guard JudgeRow carries dispatch attempts/target/usage plus guardrail:classifier; its missing pending lifecycle is a finding above.
* Guard outcomes agree in tested cases: allow proceeds; deny gives 400 CONTENT_FILTER fixed refusal; garbage/timeout/5xx give 502 UPSTREAM fixed unavailable; missing classifier gives 500 INTERNAL fixed unconfigured. Timeout row is corrected to 504/TIMEOUT when dispatch was interrupted or unfinished. Notes allowed/denied/unavailable/unconfigured and truncated are gateway-authored. Policy and classifier free text do not reach refusal messages.
* Combined: smart first; unavailable/unconfigured stops judge. Public uses guardrail model; confidential/oversize/already-local uses validated smart classifier local-only. Judge sees original request, before reroute. Deny/failure wins over smart proceed; notes concatenate. Ordinary cache-miss successful smart+judge yields two classifier rows, cache hits none. Rust re-reads guardrail_model in judge for public outcomes whereas frozen proxy.ts:715 uses the earlier settings snapshot: concurrent settings changes are not verified here and no paired mutation reproduction is claimed.
* Streaming is lazy: SSE HTTP 200 precedes classification; no x-omni-route; refusals arrive as surface-specific errors. Nonstream drains first and returns refusal's HTTP status; successful smart decisions carry x-omni-route local/external. Both settings-off and no-flag use ordinary dispatch. Start-event relabel is correct for genuine reroutes but not already-local aliases (finding).
* Keepalives: exact bytes `: keepalive\n\n`. Delayed guard-deny test (12.5 seconds) matches on all surfaces. Chat/Anthropic first comment TS 10,008/10,012 ms versus Rust 10,002/10,002 ms; Responses TS 4,004/8,004/12,005 ms versus Rust 4,003/8,009/12,009 ms. Final surface-specific refusal frames match, around 12.5 seconds. `keepalive.log` records frame bytes/timings.
* Disconnect: six stream/nonstream smart/guard/combined cases each send twice, abort at 60 ms while classifier delays 200 ms. Every final parent and classifier row is 499/interrupted in both implementations; exactly four final rows per case. One streaming smart raw-wire count differs at the abort race (TS first round started no wire, Rust started one), not a persistent extra row. Child release inferred from dropped Rust futures and matching row cancellation; upstream socket-close timing/connection reuse was not instrumented.

## Independent probes

Each named script is copied/adapted from the driver into this evidence directory, importing only checkout helper modules by absolute path. It runs inside its own loopback-only network/mount namespace, uses explicit gateway environments and private HOME, and writes raw TS/Rust rows in the named w-review-* scratch. Two sequential requests share caches unless specified.

| Class / decisive evidence | Equal | Different | Notes |
|---|---:|---:|---|
| Committed driver, driver.log | 102 | 0 | 54 smart / 36 guard / 12 combined; no oracle-invalid |
| Negative control, base-driver.log | 18 | 84 | Exactly expected baseline failures, no oracle-invalid |
| Multi/combined, probes-4.log | 60 | 0 | 40 multi (2–6 segments × public/confidential/timeout/5xx × stream toggle), 4 exact 64/65, 16 public/local × allow/deny/garbage/5xx combined; no oracle-invalid |
| Large text/caps, caps.log | 17 | 1 | All 18 client/log/wire **multisets** equal; one concurrent arrival-order difference |
| Bisected UTF-16 system caps, surrogate.log | 4 | 0 | Anthropic, guard-only/combined, stream toggle; 3991 ASCII + emoji + 9000 ASCII; raw wire preserves capped escape |
| Disconnect, disconnect.log | 5 | 1 | All six client/final stored rows equal; one raw-wire start-versus-disconnect race |
| Keepalive, keepalive.log | 3 | 0 | All three streaming surfaces |
| Already-local alias, alias.log | 0 | 6 | Confirmed client model mismatch |
| Guard pending, pending-3.log | 0 | 1 | Confirmed missing in-flight row |
| Simultaneous smart finishes, race.log | 11 | 1 | One aggregate usage difference, discussed below |
| Repeated four-call simultaneous finish, race-repeat.log | 12 | 0 | Twelve independent processes; no oracle-invalid |

`probes-4` sorts only concurrently arriving upstream calls before comparing; every raw header/body remains compared, and original arrival order is retained in rows. Unique segment bodies put SEGnn markers at 8000-unit boundaries; subtract seven final units for the `[user]\n` wrapper, so counts really are 64 and 65. Per-segment reply delays 70/20/50/10/40/30 ms exercise rolling refills; segment 1 is decisive confidential, timeout, or 5xx. One-second classifier timeout avoids fixture load sensitivity. Failure repeats dispatch classifiers again while successful sibling verdicts can hit cache. Combined garbage/5xx repeats call the judge again; allow/deny repeats do not. Initial probes had an off-by-seven segmentation fixture and overly tight 100 ms deadlines, then a variant stripped the first marker: these superseded attempts are preserved, not counted as product failures. Initial probe/cost syntax failures are also preserved.

Cache expiry boundary: no frozen-supported settings knob changes the fixed hour. I did not advance host time or wait an hour. Source comparison plus passing pure oracle tests cover <= expiry and LRU; live expiry/concurrent expiry is not independently black-box verified.

## Concurrency and safety

Cache mutex guards are confined to synchronous get/set statements; no await while held. VecDeque lookup/removal is O(n), cloning strings under the lock: bounded but less scalable than frozen Map. Static process-local ownership does not coalesce misses; neither does frozen. No dedicated simultaneous cross-request cache stress was performed.

CheckRow/JudgeRow Drop emits one final row and telemetry per constructed owner, including cancellation; direct disconnect probes confirm this normal cancellation path. Rust uses poison recovery, not panicking lock unwraps. Existing expects/unreachable refer to locally generated IR/JSON/field shapes; upstream response parsing uses fallible try_collect, option access and safe serde_json indexing, not upstream-data unwraps. Runtime timeout conversion uses from_secs_f64 on validated settings; malformed/nonfinite configuration bypassing validation was not fuzzed. Panic-unwind exactly-once logging and double-panic safety were not injected/tested.

In `race.log`, four simultaneous replies (segment 1 confidential) gave TS aggregate 20 input tokens versus Rust 30, both attempts=4 and client/wire equal. Other eleven cases equal. This is **not promoted to a deterministic product finding**: independent executions have different readiness schedules, and the frozen explicitly counts whatever siblings actually spent/observed. An identical readiness-controlled transport harness is needed to prove whether drop-vs-abort loses whole replies/cache entries. A twelve-process repeat of that four-segment confidential case (`race-repeat.log`) was 12/12 equal. It remains a review limitation, not evidence of full race equivalence.

## Request-path cost

Custom-local provider, key with **smart_routing=0 and no guardrail**, 2,000 sequential nonstream requests; all client/wire/final-log comparisons equal. `cost.ts` includes fetch/normalization, recording, DB logging and local stub overhead, not a microbenchmark of server allocations. Timer-based stub is shared by both binaries. First order baseline 4764.960 ms (2.382 ms/request), final 4596.687 ms (2.298 ms/request). Reverse order final 4749.724 ms (2.375 ms/request), baseline 4633.809 ms (2.317 ms/request). Mean final 4673.205 ms versus baseline 4699.384 ms: **−0.56%**, i.e. no measurable regression in these short samples. No allocator profiler was run. Code off path adds no new heap allocation/cache access; it replaces the old screen stub call with a short-circuited boolean and ordinary dispatch. Size remains **3400 bytes**, under 5500.

Earlier `cost-2`/`cost-reverse` measured a smart-flag key with settings disabled instead: mean final +5.6% versus baseline under heavier concurrent review workload. These are retained separately, not substituted for the requested no-flags measurements. Shared-host short bursts are not rigorous latency significance evidence.

## Driver assessment

Not vacuous on ordinary failures: both endpoints must normalize non-null, frozen and Rust scenario validity must pass; explicit client status, dispatch/no-dispatch, local target, cache absence and classifier/log count invariants apply. Expectations are code constants independent of Rust binary. Baseline's 84 failures independently reproduced. Limitations: default data has only one smart segment, local alias equals target name, final-only logs hide the pending lifecycle, timing columns are masked, and complete response.text() does not assert early headers/keepalive timings. Oversize default is actually 66 segments due role wrapper, still valid >64 test but not exact boundary. Extended probes separately cover the boundary, aliases and pending row. Independent strict raw concurrent arrival ordering is inherently scheduling-sensitive, hence explicit multiset accounting above. Driver does not compare usage_daily/rollup (general E2E does).


## Gates independently rerun

Environment: CARGO_HOME=/home/homebrew/.cargo, jobs=2, incremental=0, dev/test debug=0, private HOME; safe PATH includes Bun, brew, /usr/sbin. One cargo command at a time; disk checked before each cargo invocation, remained above 5 GiB (8.6 GiB at final check). No cleanup/deletion. All Bun invocations use --no-env-file; all gateway/provider probes used loopback namespaces. General E2E was repeated with env -i because its child env inherits process.env; the scrubbed run below is authoritative. No default-namespace gateway started.

Exact lines below are copied from reviewer .exit files (same basenames as logs):

- `workspace.exit`: cargo test --offline --workspace — exit 0
- `clippy.exit`: cargo clippy --offline --workspace --all-targets -- -D warnings — exit 0
- `fmt.exit`: cargo fmt --all -- --check — exit 0
- `size.exit`: cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture — exit 0
- `driver.exit`: bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-final — exit 0
- `base-driver.exit`: bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/rust-base /tmp/opencode/c1/w-review-base — exit 1
- `e2e-scrubbed.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home TMPDIR=/tmp/opencode/c1-review unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/c1/g-rust-final' — exit 0
- `probes-4.exit`: bash /tmp/opencode/c1-review/probes4-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-probes-4 — exit 0
- `caps.exit`: bash /tmp/opencode/c1-review/caps-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-caps — exit 1
- `surrogate.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home bash /tmp/opencode/c1-review/surrogate-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-surrogate — exit 0
- `disconnect.exit`: bash /tmp/opencode/c1-review/disconnect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-disconnect — exit 1
- `keepalive.exit`: bash /tmp/opencode/c1-review/keepalive-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-keepalive — exit 0
- `alias.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home bash /tmp/opencode/c1-review/alias-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-alias — exit 1
- `pending-3.exit`: bash /tmp/opencode/c1-review/pending-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-pending-3 — exit 1
- `race.exit`: bash /tmp/opencode/c1-review/race-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-race — exit 1
- `race-repeat.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home bash /tmp/opencode/c1-review/race-repeat-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-race-repeat — exit 0
- `cost-2.exit`: bash /tmp/opencode/c1-review/cost-ns.sh /tmp/opencode/c1/rust-base /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-cost-2 — exit 0
- `cost-reverse.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home bash /tmp/opencode/c1-review/cost-ns.sh /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/rust-base /tmp/opencode/c1/w-review-cost-reverse — exit 0

- `cost-noflags.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home bash /tmp/opencode/c1-review/cost-ns.sh /tmp/opencode/c1/rust-base /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-review-cost-noflags — exit 0
- `cost-noflags-reverse.exit`: env -i PATH=<safe> HOME=/tmp/opencode/c1-review/home bash /tmp/opencode/c1-review/cost-ns.sh /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/rust-base /tmp/opencode/c1/w-review-cost-noflags-reverse — exit 0
Workspace totals **1,326 passed / 0 failed / 37 ignored**; no flaky rerun necessary, no FAILED/panicked/error matches. Dispatch state 3,400 bytes. General E2E all client/upstream/scenario and final DB comparisons equal (37 request_logs, 18 usage_daily, 6 usage_rollup, 4 credential_health).

## What remains unverified

* Live cache hour-boundary/concurrent expiry, coordinated same-readiness finish-versus-stop, simultaneous cross-request cache stress, snapshot/locality mutation races, panic-injected owners, socket-close timing and classifier failover pending-route updates. Pending absence already reproduced without failover.
* No independent Anthropic/OpenAI/Antigravity/refresh-transport special-driver rerun (outside the explicitly requested gate list); committed smart driver covers all three client surfaces and general E2E passes.
* No heap allocator measurements or isolated-host latency conclusions; no full proof of every scheduler interleaving. Pure helper corpus ran through workspace tests; effectful comparison is the fresh review focus, not a claim to have manually rederived all 279 pure cases.
* Approval is not given; neither confirmed difference is documented as an allowed migration difference. Inherited missing RTK/ponytail transforms do not justify them.

## Restoration

No checkout file was ever edited, including harnesses: all added scripts/report reside outside it. Final HEAD: `82617fe3c64d030582266f88edd684aa29100543`; status --porcelain=v1 --untracked-files=all empty, diff against 82617fe3 exit 0, cached diff exit 0. Exact proof saved in restoration.txt / restoration.exit. No commit/reset/checkout/delete operation performed.


Final counted differential inventory (excluding baseline control, superseded harness attempts, latency bursts, and intermediate probes-3): **122 independent added rows = 112 equal / 10 different** under each script's comparison rules. Seven differences are the confirmed alias/pending findings; two are arrival/start timing observations (caps/disconnect), one is the unconfirmed simultaneous usage race. With the committed driver: **224 rows = 214 equal / 10 different**. The 60-row corrected multi/combined run and the twelve-case repeat of the simultaneous finish probe are entirely equal.
