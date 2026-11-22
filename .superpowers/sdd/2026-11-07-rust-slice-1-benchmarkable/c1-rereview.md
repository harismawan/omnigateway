# C1 re-review at 41796e6f — in progress

Verdict: **REQUEST CHANGES** — documentation/acceptance scope mismatch. **I1 and I2 closed**, all required gates pass. Initial checkout clean, HEAD 41796e6ffd6032fe218227219b6e965430a8fc5b, disk 5.9 GiB.

## Findings first

### Important — upstream stop-before-send differences exceed the documented exception

Independent read of `/tmp/opencode/c1/w-r-race/{ts,rust}.rows.json`, row `race/false/5xx/6`: both TS and Rust classifier aggregate attempts are **5 in round 0 and 4 in round 1**, input tokens **10 then 0**, status 503; final parent statuses 502. Round 0 has the same four upstream wires. Round 1 TS has one upstream wire, Rust four. Frozen counts `calls` when starting each worker and adds an aggregate attempt for each uncached segment call (check.ts:286–297,389); if three of Rust's four retry segments had instead hit TS's cache, TS's retry attempts would be one, not four. Thus the evidence does **not** establish the controller's claimed three extra cached sibling verdicts. It is consistent with both starting four uncached workers but TS aborting three before fetch sends, while Rust sends them before the failing result is observed. The final 41796e6f classify/check code is identical to 82617fe3's, and contains no 63daba4c watch-stop pre-poll guard (that guard belonged to the reverted await-sibling design).

`docs/smart-router-compatibility.md` currently says upstream requests for the decisive check are unchanged, and scopes differences to row usage/attempts/cache warmth. This stored-row counterexample has different upstream wires for a retry check without a demonstrated cache difference. Fresh probes below independently confirm that this needs an explicit additional scheduling-difference ruling rather than labeling it proven cache warmth.

Requested change: remove the unsupported guarantee that the same check always sends identical upstream requests, explicitly distinguish started logical calls from actual sent requests, and obtain acceptance for stop-before-send scheduling differences (including on retries), or restore parity for that class. No need to reintroduce awaited siblings merely to address this documentation/acceptance gap. The previously accepted whole-reply cache/usage exception alone does not establish this extra allowance. No classifier text leaks to a different provider in this evidence: the extra requests are to the same configured local classifier.

Paired reproduction: run copied race.ts through race-ns.sh against frozen and 41796e6f, inspect row race/false/5xx/6 in the supplied controller run; exact rows copied to `controller-race-row.json`, concise hashes/markers/counts to `controller-race-summary.json`. Frozen location: check.ts:290 increments calls **after** selecting an uncached segment and before await; :390 writes attempts=calls. Rust location: screening.rs:459–510 constructs up to four futures and drops pending on first failure. Documentation location: docs/smart-router-compatibility.md:6–8. Both first-round rows charge only one complete public reply (10 input / 3 output / $0.000016); no evidence that TS parsed three extra successful replies while charging identical usage. Retry has 4 logical calls on each side, 0 tokens each. This directly refutes the asserted *explanation*; it does not by itself prove the only possible source of each missing wire.

**Fresh independent confirmation beyond the controller's retry:** `/tmp/opencode/c1/w-review2-probes4` (`probes4.log`) has four differences, all client/final rows equal but extra Rust upstream wires on the **first** check:

| Row | TS classifier wires, round 0 | Rust classifier wires, round 0 | Aggregate attempts / input tokens (both) |
|---|---:|---:|---|
| multi/false/5/confidential | 4 | 5 | 5 / 20 |
| multi/false/6/confidential | 4 | 5 | same stored rows |
| multi/false/6/5xx | 4 | 5 | 5 / 10 |
| multi/true/6/5xx | 4 | 5 | same stored rows |

This is not subsequent cache warmth: first checks have clean process caches. Local-only classifier destinations are identical, clients/routing identical; the exceptional behavior is observable extra provider requests even with a slower 20 ms decisive reply and 10/50/70 ms sibling scheduling. The accepted same-moment parsed-reply exception alone does not cover it. Fresh race also reproduces retry wire differences; see counts below. This is one ranked finding, not a reopening of I1/I2 or a demand to await ready siblings.

## Review constraints

No product edits/commits. Reviewer harnesses copied under r2; probes and cargo gates ran sequentially within their own groups, with loopback-only namespaces for gateways.

## Static review conclusions

* **I1 implementation closed:** screening.rs:330–337 computes `reroute` only when selected local model differs from client model. Both paths still use local_only; only genuine reroute rewrites Start. Parent requested_model preservation unchanged. Alias probes 6/6 equal.
* **I2 implementation closed:** judge passes parent api_key_id into dispatch and sets on_route:true (:219–227); ordinary dispatch Begin/Route handles failovers and carries key attribution, JudgeRow still owns one Finish and 499 on cancel. New `pending_failover_is_attributed_sweepable_and_completed_once_on_cancel` test drives 503 on c0 then Hang on c1, flushes writer, verifies pending status0/key/c1, dead-node sweeps it, drops judge and asserts one done 499 row. This is Rust-only lifecycle coverage, not a paired failover black-box probe.
* **Sibling revert verified exactly:** extracted `struct CheckRow` through before VerdictCache, `check_confidentiality`, and `classify` all byte-identical to 82617fe3. No residual await-stop/watch receiver path. 63daba4c's pre-poll guard correctly returned before polling dispatched.events when shared stop was already set; its biased select otherwise still preferred a ready completion, matching its then-intended draining design. Both guard and receiver are absent after 41796e6f; dropping FuturesUnordered now prevents unpolled child transports from being started at stop, but does not promise the same already-started upstream wires as TS.
* **Converted test:** Together barrier makes two HTTP futures ready, confidential is observed first, public sibling gets dropped; test verifies two aggregate attempts but one reply's usage (10/4), and another request for public text makes transport call #3 (no cache). This accurately pins Rust ownership semantics, not TS scheduler equivalence. No longer asserts that readiness implies a sibling must be counted.
* **399065bd line-by-line:** public judge wrapper calls new helper without model override; helper still reads fresh settings for history and timeout, and local classifier wins over optional model override. Nested Option preserves the difference between no override and explicit unconfigured None. screen_first captures guardrail_model before lazy polling; smart combined passes that captured Option, guard-only passes no override. Thus a public smart outcome uses the request's earlier guardrail model and a local outcome uses validated classifier, matching frozen intent. No live coordinated settings mutation test was added or independently run. Separate server smart-enabled and model reads are not proven atomic under arbitrary snapshot updates.
* **63daba4c remaining changes:** lint cleanup and lifecycle test examined; CLI children in anthropic.ts/openai.ts now explicitly use --no-env-file without other argv changes. The watch guard is not in final code, as noted above.
* **Pending probe correction legitimate:** second request is a cache hit and finishes before its 700 ms timer, so a late snapshot measures completed rows or even a stopped process, not a pending judge. r2 copy takes the snapshot only during first, intentionally 2-second delayed classifier request and clears its timer; pending array remains compared exactly along with final logs. We will explicitly inspect the first snapshot rather than allow both empty arrays to pass.

Binary independently verified SHA-256 `96b50dfd38f9ca3e297fd389b9a325699a164d7c3f5074cabb3ea6a5b69ed14a`. No source edits in checkout.

### I1 / I2 paired verification

Alias rerun: six rows generated on each binary. Pending rerun's first 700 ms snapshot inspected independently: **both** contain exactly `{requested_model:"judge",status:0,api_key_id:"20ec7779-4def-4e49-9c8e-712f5d31167f"}`. Final rows both contain one judge done200 and two parent done200, not duplicate judge completions. Thus missing in-flight row is fixed, and corrected probe is not vacuous. Full comparison counts are below.

Additional paired failover probe **1/1 equal**, no oracle-invalid (`failover.ts`, failover.log; scratch w-review2-failover). Cloned local credential at lower priority, first judge request gets 503, second delays 2 seconds then ALLOW. Both first snapshots contain judge/status0/parent key/**credential local2**. Both final rows contain **one** judge completion, status200/attempts2/local2, and two parents. Pending routing update is therefore verified black-box, not just by Rust test. The separate Rust lifecycle test also covers cancel and maintenance sweep.


## Approval boundary / still-unverified items

If the additional wire-scheduling difference is accepted and documented, C1's approval would rest on these explicit limits, not on exact scheduler equivalence:

* Accepted controller difference (subject to user's veto): dropping undecided simultaneous siblings may change aggregate classifier attempts/tokens/cost and cache warmth. Cache-warmth differences may change later calls' wire counts. This is narrower than the separate stop-before-send discrepancy above; do not conflate them.
* Frozen inherited behavior: rolling pool up to four; first decisive observed confidential/failure wins; fixed process-local one-hour insertion TTL and 10,000-entry LRU, no miss coalescing, failures not cached; local-only models validated again by dispatch. Simultaneous scheduler outcomes themselves are not deterministic.
* Inherited unported RTK/ponytail transforms: request_transforms remains API-only. Neither these nor the sibling exception permits external disclosure of confidential input or different destinations.
* Unverified live expiry/concurrent expiry; controlled same-readiness cross-runtime races and simultaneous cache stress; client-disconnect socket-close timing/connection reuse; coordinated settings/locality/snapshot mutation; arbitrary panic-injection/double-panic exactly-once logging; malformed settings bypassing validators. Snapshot model capture inspected, not dynamically mutated.
* No new cost/allocator profiling in r2; round-one no-flags 2,000-request bursts showed no measurable latency regression (mean −0.56%), not statistical proof. Mutex operations remain synchronous, no await under lock; O(n) bounded VecDeque lookup is unchanged.
* Special Anthropic/OpenAI/Antigravity/refresh-transport drivers not independently rerun in r2; all three client surfaces remain covered by copied probes and committed smart driver; general E2E rerun required below.

No additional product behavior was changed by this review. No approval while documentation asserts a narrower contract than its preserved evidence supports.


## Fresh rerun counts (one run each)

| Probe | Equal | Different | Interpretation |
|---|---:|---:|---|
| Alias | 6 | 0 | I1 closed, all three surfaces × stream toggles |
| Pending (corrected first snapshot) | 1 | 0 | I2 closed; snapshot explicitly inspected |
| Pending failover | 1 | 0 | local → local2 pending route; one final judge |
| Pending failover + cancellation | 1 | 0 | Both final parents/classifiers 499; four rows, no duplicate |
| probes-4 | 56 | 4 | Client/log equal in all 60; four upstream request multiset differences, finding above |
| Caps | 15 | 3 | All 18 client/log/upstream **multisets** equal; three raw concurrent arrival-order differences |
| Disconnect | 6 | 0 | Stream/nonstream smart/guard/combined |
| Keepalive | 3 | 0 | All three surfaces, bytes/timings retained |
| Race | 8 | 4 | Three upstream multiset differences, three aggregate-row differences (two overlap); all clients equal |
| Race-repeat | 10 | 2 | Two aggregate usage-only differences; clients/wire multisets equal |
| Committed driver | 102 | 0 | Includes decisive pending snapshot assertion |

All oracle-invalid counts **0**. Added probes total **107 equal / 13 different / 120**; including committed driver **209 equal / 13 different / 222**. Of thirteen: three raw arrival order, three usage-only, seven upstream request-multiset differences (two of these also have aggregate differences). Simultaneous usage-only differences fit the documented exception; first-check stop-before-send wire differences do not fit its text. Fresh race/true/5xx/6, like the controller's race/false/5xx/6, has equal client and stored rows yet TS retry one classifier wire versus Rust four.

No second probe run used to replace these outcomes. Sibling-repeat is not a deterministic 12/12 parity gate: this run 10/12, prior controller run 12/12, consistent with timing dependence. No clients or routing decisions differed in these runs. Raw wires and logs remain in w-review2-* evidence; only copied probes4/race comparison sorts concurrent upstream requests, retaining original order in raw JSON. Caps compares raw order and therefore reports three failures, not semantic request differences.

## Independently rerun gates and command exits

Cargo offline, two jobs, incremental off, debug off, explicit CARGO_HOME/private HOME; one cargo command at a time. Disk checked before each command, minimum final 5.4 GiB, never below stop threshold. Workspace **1328 passed / 0 failed / 37 ignored**; no known flaky test failed, no rerun. Both readiness and pending failover/sweep/cancel tests explicitly passed. Clippy/fmt pass, dispatch **3400 bytes**, general E2E all equal. Every gateway ran in its own loopback-only namespace with explicit environment/private HOME; no default-namespace gateway, no configuration access, no Bun env-file loading.

Exact lines copied from reviewer .exit files (corresponding logs adjacent):

- `workspace.exit`: cargo test --offline --workspace — exit 0
- `clippy.exit`: cargo clippy --offline --workspace --all-targets -- -D warnings — exit 0
- `fmt.exit`: cargo fmt --all -- --check — exit 0
- `size.exit`: cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture — exit 0
- `driver.exit`: bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-driver — exit 0
- `e2e.exit`: env -i PATH=<safe> HOME=<private> TMPDIR=/tmp/opencode/c1-review/r2 unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/c1/r-rust' — exit 0
- `alias.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/alias-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-alias — exit 0
- `pending.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/pending-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-pending — exit 0
- `failover.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/failover-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-failover — exit 0
- `failover-cancel.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/failover-cancel-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-failover-cancel — exit 0
- `probes4.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/probes4-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-probes4 — exit 1
- `caps.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/caps-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-caps — exit 1
- `disconnect.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/disconnect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-disconnect — exit 0
- `keepalive.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/keepalive-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-keepalive — exit 0
- `race.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/race-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-race — exit 1
- `race-repeat.exit`: env -i PATH=<safe> HOME=<private> bash /tmp/opencode/c1-review/r2/race-repeat-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-review2-race-repeat — exit 1


## Restoration proof

Checkout never edited. Final HEAD `41796e6ffd6032fe218227219b6e965430a8fc5b`; `git status --porcelain=v1 --untracked-files=all` empty; `git diff --exit-code 41796e6f` and cached diff exit 0. Saved exact outputs in restoration.txt and command exits in restoration.exit. No commits, subagents, resets, checkout or evidence deletion. The report and harness scripts are exclusively under reviewer evidence directories.
