# X3 final narrow review — 478a974f

Verdict **APPROVE**, subject to the complete documented differences and verification limits below. **No outstanding Critical/Important/Minor finding established across the three rounds.** All five original findings closed in r2; remaining strict-zero/relational burn finding closed here. No build needed: using supplied gateway SHA256 `d7c9f855b1b4bc09880ec931a8b4902015a9a2790f358d0062b94544ce87cdb4`; checkout clean at `478a974fa9580e10a86e2c1f06b93e0ab09c96fe`. Disk initially 5.9 GiB; no cargo invocation.

## Final measured outcome

* Independent burn probes: **176 pairs / 176 equal / 0 differences**.
* Final X3 corpus: **4,106 pairs / 3,997 equal / 94 routing-strict + 15 v1-models-frozen-json / 0 unexpected**, evidence `/tmp/opencode/x3/operator-a6vr09zm`.
* `x3.exit`: `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/j-gateway-478a974f python3 conformance/e2e/x3-operator.py ; exit=0`.
* `audit.exit`: `python3 /tmp/opencode/x3-review/r3/audit.py ; exit=0` — independently checked all 109 unchanged manifest identities occur exactly once with their accepted class, and no other unequal row is excused. Captures `accepted-actual.json`, `probe-counts.json`, `audit.log`.

## Burn branch review

Frozen `quota/burn.ts:72-127` vs Rust `credentials.rs:247-342`: stale observedAt<=0 and age compare each have one numeric operand, therefore numeric ToNumber, matching raw scalar decoding. Reset<=now rollover likewise numeric. windowMs>0 numeric; subtract reset-duration coerces both numerically; unknown nominal durations become NaN. elapsedHours<=0 numeric. `used===0` now checks raw JsValue numeric zero (both +/-0 equal), not TEXT/BLOB/NULL coerced zero. limit<=0 and rate<=0 numeric; null ceiling/rate retained separately. Math.max/subtract/divide numeric and NaN propagation preserved. observedAt+delta uses JS ToPrimitive: TEXT and BLOB concatenate; numeric/null add numerically. Final exhaustsAt>=reset uses UTF-16 lexical comparison **only when both primitives are strings**: TEXT/BLOB observedAt generates string, and TEXT/BLOB reset becomes string; all other pairs numeric. New BLOB reset case is therefore correct. Null exhaustion/reset short-circuit survives=true; stale/rolled suppress output consistently. No arbitrary object-valued ToPrimitive required: projected objects are known Uint8Array BLOBs. Quota identity/window type raw outputs preserved.

Initial copied r2 harness failed before any gateway startup because new corpus prepare added a seventh `burn` parameter; corrected reviewer-only adapter and retained failures as `*-harness-error.log`. Not a product failure. Final rerun command/exit lines in `.exit` files.

Extra cross-cell observed/reset primitive matrix: **64/64 equal**, all 8×8 combinations of BLOB NaN, TEXT NaN, numeric TEXT, TEXT -0, REAL -0, empty BLOB, ASCII-zero BLOB, NULL. `cross.exit`: `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/j-gateway-478a974f python3 /tmp/opencode/x3-review/r3/cross.py ; exit=0`. Raw captures in `operator-0dh9pz3j/results.json`.

Prior burn reproductions now pass: burn-zero **3/3 equal** (`operator-1ck6gjgr`), burn-active **107/107 equal** (`operator-vxdo2qdk`), shipped-schema **2/2 equal** (`operator-gauhvjyf`). Total this round's independent burn probes: **176 pairs / 176 equal / 0 different**. All four commands exit 0 (exact command/exit lines in `burn-zero.exit`, `burn-active.exit`, `burn-shipped.exit`, `cross.exit`). This closes the r2 Important finding, including the unmodified-schema empty-BLOB case.

## Documented differences / verification limits for final verdict

* **94 `routing-strict` rows**: 65 client auth/login refusals; 16 `/v1/models` typed-key/auth diagnostics (12 frozen 200/Rust 500, 4 both 500); 13 `/v1/models` strict snapshot model skips (both 200 but missing model). Gateway typed auth/routing/snapshot readers deliberately stay strict. No operator-admin exception; invalid-UTF8 client display failure removed/fixed in r2.
* **15 `v1-models-frozen-json` rows**: frozen 500 / Rust 200 on `/v1/models` retained intentionally. Includes parser errors **and valid-JSON wrong shapes** (null property access, noniterable target, non-callable includes). Nine virtual-model targets, five credential provider_data, one allowlist. Not a blanket permission for unknown model-route differences.
* Manifest unchanged in this range (`manifest.exit` 0, empty diff). Its 109 entries were individually audited against actual results in r2; synthetic mutation tests proved unknown identity/status/body differences fail. JSON-order/generated-clock/id masks remain in the corpus; own supplemental probes also use its canonicalization. No claim of universal all-byte/all-schema equivalence.
* **Postgres operator readers unverified.** SQLite scope only. No live upstream/provider integration exercised; no arbitrary JSON object ToPrimitive emulation attempted or approved. SQLite BLOB typed-array conversion is finite, explicit scalar behavior, not a new approximation to arbitrary JS objects.
* Current round uses controller's supplied copied gateway with verified stated SHA256, **not an independent reviewer build at 478a974f**. No cargo build or workspace test rerun required by narrow request. Own r2 build tested 1,315 workspace tests and six CLI corpora (9,471 pairs), clippy/fmt/run.ts; those are prior-commit evidence, **not independent gate results for final 478a974f**. Controller/implementer report final current gates; not independently rerun here. No admin-routes invocation, as directed; controller's 20,602/27/0 remains externally supplied evidence.
* CLI hand-altered-schema/human-rendering accepted differences do **not** extend to HTTP. Option-A coercion remains operator-only beside strict gateway readers; boundary diff from 487feadd for store/core is empty (`boundary.exit` 0). Prior callgraph review remains valid; final code change only credential health projection/derivation.

## Restoration

No checkout edits/commits/subagents. `checkout-head.txt` = `478a974fa9580e10a86e2c1f06b93e0ab09c96fe`; `checkout-status.txt` and checkout.diff empty; `checkout.exit`: `git diff --exit-code HEAD ; exit=0`. Evidence-only harness files outside checkout. Original x3/r1/r2 evidence not modified; committed corpus writes its own new output under x3 as designed.
