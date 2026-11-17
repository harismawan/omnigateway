# X3 re-review at 921c3196

Verdict **REQUEST CHANGES**. All verification finished. Source changes close all five original findings; one additional Important burn mismatch confirmed. No product edits, commits, or subagents. Own CLI built alone, copied before gateway build; private environments/HOMEs. Original evidence untouched.

## Findings first

### Important: burn zero test loses SQLite class before strict equality

Frozen `packages/control/src/quota/burn.ts:105` tests `window.used === 0`; Rust `credentials.rs:265` tests coerced `q.used == 0`. On a copied seed with a no-affinity quota_windows table:

```sql
INSERT INTO quota_windows VALUES('510df117-69fe-48d1-af6d-74a4856ea35f','daily',1700000000000,1,10,4800000000000,4800000000000,86400000);
UPDATE quota_windows SET observed_at=X'7178', used='0';
-- independently replace used='0' with used=NULL
```

Authenticated `GET /api/credentials/health` returns 200 on both sides. Frozen burn: `ratePerHour:null,exhaustsAt:"113,120NaN",survives:false`; Rust: `ratePerHour:0,exhaustsAt:null,survives:true`. Full exact response bodies/SQL in `operator-haxi1zlu/results.json`; minimal `burn-zero.py` gives **3 pairs / 1 equal / 2 different**. Not auth/routing or a /v1/models exception; not open-ended object emulation (only known raw SQLite scalars). Keep raw numeric-class zero check separate from ToNumber for arithmetic, add multi-cell active/NaN burn corpus cases. Original BLOB correction is valid but incomplete branch coverage left this strict-equality gap.

Independent broader active-branch sweep: **107 pairs / 105 equal / 2 different**, every quota column across 13 classes plus the three cross-cell cases; the two differences are the same zero-test issue. Existing single-cell expansion seeds observed_at in the past, suppressing burn calculations for most rows; it does not exercise this live/NaN combination. No other arithmetic mismatch found in that sweep.

Also reproduced on **unmodified shipped schema**: `UPDATE quota_windows SET observed_at=X'7178',used=X''` gives the same frozen-vs-Rust burn divergence. Empty BLOB ToNumber is zero, but it is not JS numeric zero. `burn-shipped.py`, `operator-s8ntjq6h/results.json`: 2 pairs, 1 difference (TEXT '0' is coerced by shipped REAL affinity and correctly matches; BLOB remains BLOB and fails). No hand-altered-table exemption could excuse this case.

## Original finding closure

Minimal closure suite `operator-5d7gxvxz`: **6/6 equal** covering quota raw ids/window types, BLOB/empty BLOB observedAt, credential weight write-back, POST tokenVersion=0. Dedicated invalid-UTF8 client summary `operator-044zs9ie`: **1/1 equal**. These establish all five **original** reproductions closed; the additional used strict-equality mismatch is separate. Full original probe rerun completed **2,409/2,409 equal**.

## Number binding audit

Own Bun sqlite oracle `numbers.log`: -0 REAL; 0/2/safe max INTEGER; 2^53 and 2^53+1 (same rounded JS number), 2^63, 1e20 REAL; NaN NULL; +/-Infinity REAL. `bind_number` matches these classes (SQLite converts bound REAL NaN to NULL). HTTP credential positive schemas exclude -0/NaN/-Infinity; large finite values and +Infinity parser/schema behavior require route checks. Model PUT target numbers, settings, key limits/allowlists are JSON-encoded TEXT rather than individually bound SQLite numbers, so bind_number is not applicable there. Credential PATCH is the only new caller. Key expiry still uses i64 binding and needs boundary probing.

Own HTTP PATCH number probe **9/9 equal** (`operator-wp0rdyjw`): -0, 0, 2, 2.5, 2^53-1, 2^53, 2^53+1, 2^63, 1e20, including exact resulting SQLite classes. Key create/edit expiry is bounded by `MAX_INSTANT=8_640_000_000_000_000`, below safe max, strictly positive integer: i64 binding agrees with Bun for every accepted value. Key/credential created/updated/revoked timestamps are integral epoch ms, generated in Rust as i64; flags are integer 0/1. Models PUT strategy/id/targets JSON and alias integer flag; settings PUT entire encoded JSON; key limits/model allowlist entire encoded JSON; none require bind_number. Thus no unconverted numeric user field in the audited operator HTTP writers remains except JSON-content numbers (must stay TEXT). Credential tier/weight both use bind_number. NaN/Infinity cannot arrive as standard JSON literals; overflow numeric token can produce Infinity, requiring schema rejection behavior rather than binding; not claimed as a standard supported finite input.

## Manifest verification

Own final corpus `operator-ae9h_ztd`: **3,697 pairs / 3,588 equal / 94 routing-strict + 15 frozen-models / 0 unexpected**. `x3.exit`: `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3-review/r2/gateway python3 conformance/e2e/x3-operator.py ; exit=0`. Every manifest identity checked against this actual run (`accepted-actual.json`, all 109 present exactly once), statuses and strict model skips/auth bodies verified; none are operator-admin failures or client display-reader failures.

`manifest-test.py` runs **the actual run_case classification block** with synthetic sides and a private in-memory manifest, no gateway: 109 unique case/request identities; each class predicate checked; unknown identity and removed entry classify as unaccepted; changed status (500/201 instead of 500/200) unaccepted; routing auth body drift asserts. Consequently unknown differences feed final `failures` and `assert not failures`, not a path-wide exception. Original corpus/manifest never edited. Manifest reason strings are not trusted as proof; final actual rows will be checked against prior callgraph and responses.

Mutation harness additionally executes the copied corpus's final assertions verbatim with all **109** expected differences plus **1 unknown**: accepted-count assertion passes (94/15), then `assert not failures` throws exactly `1 unexpected differences`. Missing entry, changed auth body, and changed status also rejected. Scratch copies `corpus-copy.py` / `manifest-copy.json` retained; `manifest-test.exit` = 0 means all negative tests behaved as expected.

Manifest routing identity set is exactly previously individually audited 95 minus invalidutf client-summary display case. **94 legitimate**: 65 client login/auth denied (200/401), 12 /v1/models typed-key 200/500, 4 /v1/models 500/500 typed-key differences, 13 /v1/models snapshot model skips (200/200). Separate **15 legitimate** frozen 500/Rust 200 /v1/models snapshot/allowlist rows; valid JSON wrong-shape errors included by explicit 15-row ruling. Identity/status checking is stricter than prior broad route predicate, and no genuine operator admin row can be accepted. For 200/200 model-skips the manifest does not pin the whole response (generated IDs vary), but these specific snapshot skip identities are documented; unexpected new identities cannot hide.

## Boundary and restoration

`git diff --exit-code 487feadd..921c3196 -- crates/omni-store crates/omni-gateway-core ; exit=0` (`boundary.exit`, empty boundary.diff). No new coercing dependency in auth/dispatch/snapshot; prior callgraph proof still applies. Client summary is a post-auth display path, not auth, and now shares cell ToString decoding correctly. `checkout-head.txt` is 921c3196834469874fe3e8f56913f48999e47224; `checkout-status.txt` / checkout.diff empty, `git diff --exit-code HEAD ; exit=0`. No checkout edits to restore.

## Gates / limits

`workspace.exit`: `cargo test --offline --workspace ; exit=0` — **1,315 passed**, first attempt, no flaky retry; includes dispatch_state_machine_size. `clippy.exit`: `cargo clippy --offline --workspace --all-targets -- -D warnings ; exit=0`. `fmt.exit`: `cargo fmt --all -- --check ; exit=0`.

run.ts namespace gate exit 0, all rows equal. CLI and gateway own build exit 0. Own binary SHA256 in binaries.sha256 (gateway 62154f3f..., CLI 89aa9559...). All six CLI and original probe suites finished. No admin-routes invocation per instruction; controller's 20,602/27/0 not independently rerun. No PostgreSQL/provider validation; no universal all-byte/all-schema proof. Prior documented strict auth/routing and 15 frozen-error/Rust-success model differences retained; CLI accepted classes do not excuse HTTP differences. No open-ended object-valued-field JS emulation added.

## CLI corpora — complete

Own CLI built **alone** at 921c3196 and copied before any combined build. All six exit 0, **9,471 pairs / 0 failing**:

| Corpus | Pairs | Failing |
|---|---:|---:|
| stored-cells | 1045 | 0 |
| neighbors | 3806 | 0 |
| neighbors-targeted | 8 | 0 |
| wide | 4236 | 0 |
| extra | 180 | 0 |
| quota-json | 196 | 0 |

Existing neighbors exclusions `random-create:2`, `unimplemented-credentials:4`; quota-json accepted `human-quota:45` retained. No harness timeout or rerun needed in r2. Full logs private. CLI command/exit lines from corresponding files:

* `cli-stored-cells.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/r2/home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/r2/omni python3 conformance/cli/stored-cells.py ; exit=0`
* `cli-neighbors.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/r2/home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/r2/omni python3 conformance/cli/neighbors.py ; exit=0`
* `cli-neighbors-targeted.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/r2/home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/r2/omni python3 conformance/cli/neighbors-targeted.py ; exit=0`
* `cli-wide.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/r2/home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/r2/omni python3 conformance/cli/wide.py ; exit=0`
* `cli-extra.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/r2/home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/r2/omni python3 conformance/cli/extra.py ; exit=0`
* `cli-quota-json.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/r2/home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/r2/omni python3 conformance/cli/quota-json.py ; exit=0`

## Full original probe rerun — completed

All ten original suites **2,409 / 2,409 equal** (including creation checks with generated-value masks). Extended 1543, health-extra 182, quick 2, mutations 474, shipped-health 3, multirow 91, tier-weight 2, settings-writes 35, settings-full 35, mixed-quota 42. `audit-final.exit`: `python3 /tmp/opencode/x3-review/r2/audit-final.py ; exit=0`. Every individual suite command `.exit` is 0; complete command lines collected in `exits.md`. Typed POST tokenVersion=0 assertions included in finalize-evidence.py. The reporter's earlier premature exit 1 was resolved after final suite completion, not a product failure. Fresh checkout proof still empty at 921c3196.

## Burn branch audit

Raw credential/window identities now retained. All quota fields use known SQLite scalar ToNumber, with BLOB's Uint8Array comma ToString; observedAt `+` retains TEXT/BLOB concatenation. Stale check <=0 and age, rolled reset <= now, start from reset minus positive duration else nominal, rate from elapsed, limit threshold, Math.max remaining, and final string/string vs numeric comparison are structurally aligned. **Exception found:** used strict equality after coercion, above. No arbitrary JSON object-valued ToPrimitive introduced: objects here originate only in byte-index BLOB projection. WindowType nominal lookup on non-string BLOB cannot match known names (decimal byte list), so empty fallback yields NaN appropriately. A theoretical inherited property key such as `toString` resolves to a function in TS nominal object and ToNumber NaN, same Rust unknown nominal result.
