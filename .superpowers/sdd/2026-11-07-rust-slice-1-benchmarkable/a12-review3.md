# REQUEST CHANGES

A12 at **`3e4ff33f884d9260f91b0560a152e1b2d1b65d69`**, reviewed across all three rounds. Round-2 reproductions now pass or fall within the documented manifest. **Three remaining findings** below: 3 unexpected HTTP pairs and 6 unexpected CLI pairs in new probes. A separately discovered, pre-existing settings-normalization difference is disclosed, not attributed to this patch. The shared live-router NaN-cost correction is **not a regression**.

Evidence paths below are relative to `/tmp/opencode/a12-review/r3/`. Implementer evidence was read-only; no product edits, builds, commits or configuration changes were made.

## Findings

### P1 — Literal overflowing JSON numbers still cause an INTERNAL response

**Frozen:** `packages/store/src/sqlite/config.ts:65–75` uses JSON.parse; `packages/control/src/dryRun.ts:47,76–98` ranks and projects its result. JS accepts JSON numeric literal `1e400` as Infinity. Arithmetic and JSON output do not require rejecting the entire operation.

**Rust:** `crates/omni-control/src/dry_run.rs:223–225` first serializes parsed JS values through JSON, losing nonfinite values; the output-restoration path at **130–131** then reparses the original stored JSON using `serde_json::from_str`, which refuses its overflowing literal. String-form `'1e400'` was fixed, but the literal form still fails.

Reproduction, independently reset the ordinary seed for each SQL:

```sql
UPDATE virtual_models
SET targets=replace(targets,'"tier":1','"tier":1e400')
WHERE id='score';

UPDATE virtual_models
SET targets=replace(targets,'"input":1','"input":1e400')
WHERE id='score';
```

Operator POST `/api/models/score/dry-run` with `{"tools":true}`:

| Mutation | Frozen | Rust |
|---|---|---|
| tier literal Infinity | 200; `expired,ok,kilo`, tiers `[null,null,null]`, scores `[18.5,18.5,18.5]` | 500 INTERNAL |
| price literal Infinity | 200; `expired,ok,kilo`, tiers `[1,1,1]`, scores `[18,18,18]` | 500 INTERNAL |

Rust body is exactly `{"error":{"code":"INTERNAL","message":"internal error"}}`.

CLI human and `--json`, same SQL: frozen exit **0**, ordinary stdout, empty stderr; Rust exit **1**, empty stdout. Tier stderr: `number out of range at line 1 column 52\n`; price stderr: `number out of range at line 1 column 88\n`.

Evidence: `overflow/run-2dKbuT/rows.json`, `cli-overflow/rows.json`; reproducible drivers `overflow.ts`, `cli-overflow.py`. This is 2 HTTP and 4 CLI unexpected pairs, not an accepted rendering difference. Preserve JS numeric parsing through both arithmetic and output projection without altering strict live readers or router types.

### P2 — Excluded BLOB credential IDs are not restored to their raw output value

**Frozen:** `packages/store/src/sqlite/credentials.ts:152–155,198–211` preserves credential ID; `packages/control/src/dryRun.ts:104–108` directly projects it from the router's exclusion.

**Rust:** `crates/omni-control/src/dry_run.rs:154–168` restores IDs/labels only on candidates. The exclusion restoration block at **182–201** restores only `model`, not `credentialId`; thus exclusions expose the coerced routing ID.

Reproduction:

```sql
PRAGMA foreign_keys=OFF;
UPDATE credentials SET id=x'6162',enabled=0 WHERE id='ok';
```

Operator POST `{ "tools": true }` to the selected model, and CLI `models dry-run score --json`:

- Both HTTP statuses **200**; both CLI exits **0**, stderr empty.
- Frozen `/body/excluded/2/credentialId` is **`{"0":97,"1":98}`** (CLI `/excluded/2/credentialId`).
- Rust value is **`"97,98"`**.
- Candidate sets, order, scores, reasons and other exclusions match.

Neither identity nor exclusion path is listed in the manifest; this is an unapproved echo difference. The corresponding human CLI correctly returns the frozen table error, so it does not excuse JSON/HTTP drift.

Evidence: `new/run-ef4rVo/rows.json`, `cli-new/rows.json`, drivers `new.ts`, `cli-new.py`.

### P2 — Human-table validation visits cells in a different order from frozen

**Frozen:** `apps/cli/src/commands/models.ts:379–386` passes raw candidate label then raw model into the table. `apps/cli/src/output.ts:81–84` measures **column-major across all rows**. The first invalid raw candidate column is CREDENTIAL, before MODEL. Excluded rows similarly visit CREDENTIAL before MODEL (`models.ts:392–395`).

**Rust:** `crates/omni-control/src/dry_run.rs:36–55` validates **row-major, model first**, then label/id. With multiple invalid cells, it reports the wrong first error.

Reproduction (both mutations on the same seed):

```sql
UPDATE credentials SET label=x'6162' WHERE id='ok';
UPDATE virtual_models
SET targets=json_set(targets,'$[0].model',NULL)
WHERE id='score';
```

Run human `models dry-run score`. Both exit **1**, stdout empty:

- Frozen stderr exactly: `text.replace is not a function. (In 'text.replace(/\u001b\[[0-9;]*m/g, "")', 'text.replace' is undefined)\n`
- Rust stderr exactly: `null is not an object (evaluating 'text.replace')\n`

JSON output of this case matches; this is specifically error precedence in the human renderer, not a plugin or allowed echo difference. Validate in the same table/column/row order as frozen.

Evidence: `cli-extra/rows.json`, case `two-invalid`; driver `cli-extra.py`.

## Shared live score change: correct latent bug fix, not a finding

`crates/omni-router/src/score.rs:117–120` now sends NaN own-cost through `ratio` when a best positive cost exists. Frozen `packages/router/src/score.ts:145` uses `ownCost <= 0 || bestCost === null ? UNKNOWN : ratio(...)`. Since NaN <= 0 is false, **the new branch matches frozen**, including live requests. NaN with no positive peer still yields UNKNOWN in both. Finite negative/zero/positive and ±Infinity behavior of this conditional is unchanged. `ratio` uses JS-compatible `math_min`, so NaN propagates rather than being treated as an unknown neutral cost.

**Reachability:** strict live model readers require numeric fields, but do not prevent arithmetic overflow of finite f64 prices. A stored numeric price pair `{input:1e308,output:-1e308}` and ordinary token estimates can yield `Infinity + -Infinity = NaN`. This passes structural live reading. Catalog/smart-router paths share the ranker, but built-in finite, nonnegative ordinary prices do not by themselves create this overflow/cancellation; no claim of a catalog-only reproducer or exhaustive smart-model configuration sweep.

**Paired real live experiment:** a scratch adaptation of `run.ts` creates a stored score-strategy model with two custom-provider targets, same credential: first `model:"nan-cost"`, finite prices above; second `model:"ok"`, ordinary prices. A namespace-local upstream records real gateway requests. Both gateways choose **`nan-cost`** and send **byte-identical upstream requests**, status 200, for the selected `chat buffered` row. Evidence: `live-ranked.ts`, `live-ranked.json`, `live-ranked.log`. This confirms the NaN branch is reachable despite strict readers and final live ranking matches frozen, not merely dry-run.

Do **not** represent that targeted overflow run as a clean end-to-end gate: its altered prices also expose a pre-existing usage/logging issue, Rust `NOT NULL constraint failed: request_logs.cost_usd` and shutdown exit 1. The collector intentionally records exchanges after that exit; its own exit 0 is not a gateway-pass claim. This failure is downstream of selection and outside the one-line scoring conditional; the first, unhandled-upstream-script attempt (`live-nan.log`, exit 1) and full successful-upstream attempt (`live-nan-ok.log`, exit 1) are retained. First attempt had streaming transport-header differences on the unknown-script error and scenario assumptions invalidated by the changed model. Those attempts are **not** counted as parity successes. The focused recorded upstream comparison establishes only the claimed ranking fact.

**Strict-reader boundary:** diff `fb11d613..3e4ff33f` contains no store, gateway or gateway-core edits; router types unchanged. The only shared-router logic edit is the NaN-cost guard. No evidence that it changes live behavior away from frozen. The unmodified namespaced **run.ts passes all 49 table rows**, separately from the altered-price experiment.

## toFixed(3) and human raw columns

Reviewed `crates/omni-cli/src/models.rs:120–154`: exact binary-significand scaling, ties away from zero; bounded magnitude below 1e21 fits u128 at three digits; NaN explicit, infinities/large values use JS number text; `n < 0` suppresses negative-zero sign as JS does. The function also remains the two-decimal price helper, now parameterized.

End-to-end paired CLI tests make only tier score weight nonzero and directly produce these scores:

| Score | Both human renderings |
|---|---|
| 0.0005 | `0.001` |
| 1.0005 | `1.000` |
| 123.4565 | `123.457` |
| -0.0 arithmetic result | `0.000` |
| 1e21 / -1e21 | `1e+21` / `-1e+21` |

Both human and raw-format JSON comparisons match for those six values (**12 pairs** in `cli-new/rows.json`). Raw -0 formatting is additionally supported by source inspection (the weighted sum may eliminate the sign). Credential weights ±Infinity and NaN now preserve human `Infinity`, `-Infinity`, `NaN`, with JSON null as frozen. Subnormal weight `5e-324` also matches (`cli-numbers`, `cli-extra`). Not an exhaustive binary rounding sweep or an isolated call to a private Rust function.

Raw-table columns in frozen are candidate **credentialLabel, model** and excluded **credentialId, model, reason**. Candidate index/tier/score and provider are already strings; exclusion reason is always a router-produced string. Existing final corpus tests malformed label/provider/id and target model individually; my BLOB-label/model cases and excluded BLOB ID tests confirm individual type-error behavior, with the **multi-error ordering exception** above. No caller-authorized malformed reason source was found. Correct individual validation is not sufficient to claim correct first-error precedence.

## Verification counts and classifications

| Independently rerun on final binaries | Result |
|---|---|
| HTTP committed corpus | **795 records**, 785 actual pairs + 10 constraint-rejected records; **2 accepted, 0 unexpected**, exit 0 |
| CLI committed corpus | **312 records**, 298 executed pairs + 14 rejected-update pairs; **2 accepted, 0 unexpected**, exit 0 |
| Original probes/probes2/probes3 | **70 pairs**, 1 accepted BLOB-strategy echo, 0 unexpected; 10 seed-error records excluded |
| Heterogeneous rank matrix | **318 pairs**, all equal |
| Original live poison-row discrimination | both real requests 503, both dry-runs 200, equal |
| R2 `more` ranking-cell matrix | **31 pairs**, all equal |
| R2 CLI gaps/more/numbers/render | **28 pairs**, 27 equal, 1 accepted BLOB-strategy echo |
| New HTTP cells | **7 pairs**, 6 equal, 1 finding |
| New literal-overflow HTTP cells | **2 pairs**, both findings |
| New CLI cells/score values | **20 pairs**, 15 equal, 1 finding, 4 legacy settings differences below |
| Further CLI cells (multi-error, -Infinity, subnormal) | **6 pairs**, 5 equal, 1 finding |
| Literal-overflow CLI | **4 pairs**, all findings |
| Plugin probes | **10 pairs**, plugin-excluded differences |
| Actual committed CLI acceptance mutation test | **7 cases passed**, exit 0 |
| HTTP acceptance mutation test | **6 cases passed**, exit 0 |
| `cargo fmt --all -- --check` | exit 0 |
| Unmodified namespaced `run.ts` | **49 rows all equal**, exit 0 |

All mismatches from requested R2 reruns are now either equal or explicitly manifest-accepted; no plugin cases were included in non-plugin counts. Supplemental collectors exit 0 after collecting rows even when they differ, so row comparisons, not collector exits, determine the classifications above. `probes2.log` prints failures 8 due to rejected NULL constraints, not differential mismatches. Final corpus red-on-fb11d613 discrimination was not independently rerun this round (prior rounds independently verified original corpus base-red).

No cargo build was needed. **Workspace/clippy/dispatch/X3/six broader CLI suites were not rerun in round 3**; implementer's final-head results are not claimed as mine. Round 1 independently passed workspace (1,351 tests), clippy and fmt at its older HEAD. Disk remained 7.9–7.7 GiB free, above the stop threshold; no builds. Gateways were namespaced, Bun calls used `--no-env-file`, private HOME was `r3/home`, all execution was from the designated worktree or scratch. Worktree clean at required HEAD; no real .env/config used. Probe outputs that defaulted a seed path read only the previous review seed, not implementer-mutated DBs.

Final artifact SHA-256:

- gateway: `b39a5b331266e1c003d0332f73e719aca12f55742509d1ab4f74c19cc5233e89`
- CLI (supplied CLI-alone build): `08b2993de2ad73f2f8fcc20b812446324bd108188099cf20930028f929f617d5`

## Documented differences / legacy observations / limits

### Manifest class actually exercised

The current manifest has **16 entries** (the earlier seven plus controller-retained null/-0/array tier entries, including human table paths). Most are no longer used because output-only raw restoration now matches frozen. Final HTTP corpus accepts only:

- `UPDATE virtual_models SET strategy=x'73636f7265' WHERE id='score'`, `[200,200]`, `/body/strategy`.
- `UPDATE virtual_models SET strategy=x'6162' WHERE id='score'`, `[200,200]`, `/body/strategy`.

Frozen echoes byte-index objects; Rust echoes strings `115,99,111,114,101` or `97,98`; both are deterministic true and preserve unknown-strategy order. Final CLI accepts **two executions of the same** `cli:UPDATE virtual_models SET strategy=x'6162' WHERE id='score'`, exits `[0,0]`, `/strategy` (stored-case and cross-product duplicate). No other manifest path is actually exercised as a difference in these final runs. BLOB-label/string-tier/null-tier/-0-tier/array-tier output now matches and is not counted as accepted drift. The new excluded ID echo is **not** covered.

The committed CLI helper now compares insertion-order-preserving JSON serialization after masking allowed leaves. Its seven tests reject top-level order, nested order, extra key, status, stderr and score mutations; positive allowed echo accepted. Extracted HTTP checker rejects status/score/header/extra-key/property-order mutation, accepts only allowed leaf. The prior order hole is fixed. Neither mask gives permission to add new identities/paths. rankedAt remains checked within 120 seconds then masked; corpus JSON parsing still masks whitespace differences, while my supplemental CLI raw-format comparisons preserve whitespace/property order except timestamp.

### Plugin exclusions (reverified on final CLI)

User excludes plugin behavior. Evidence `cli-probes/rows.json`, `cli-plugin-valid/rows.json`, `cli-plugin-loadable/rows.json`, ten pairs across five fixture classes, human and JSON each:

1. **Loadable API-3 provider:** frozen exit 0 with ordinary output; test plugin registers no descriptors. Rust stdout empty, exit 1, stderr exactly `plugin providers are not supported by this Rust CLI; bad in /tmp/opencode/a12-review/r3/cli-plugin-loadable/home/plugins declares one\n`.
2. **Invalid JSON manifest `{`:** frozen human warning exactly `plugin bad: manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'\n`; normal stdout/exit 0. JSON has `pluginFailures:[{"id":"bad","reason":"manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'"}]`, stderr empty. Rust exit 0, normal stdout without warning, JSON `pluginFailures:[]`.
3. **Missing manifest:** same pattern; frozen reason ends `no omni-plugin.json`, Rust omits failure/warning.
4. **Schema-invalid apiVersion manifest:** same pattern; frozen reason ends `api: Invalid input: expected number, received undefined`, Rust omits it.
5. **API 1 on host API 3:** frozen reason `declares a provider but will not load: plugin api 1 is not supported by this host (api 3)`, human `plugin bad: <reason>\n`; Rust omits it, both exit 0.

The `none` test label actually denotes a plugin directory with missing manifest. `cli-plugin-valid` denotes API 1/host incompatible, not loadable; API 3 is separately tested. No plugin registration/transport parity claimed.

### Additional pre-existing settings discrepancy (not charged to the R3 diff)

`cli-new` includes settings JSON with score tier weight literal `±1e400`, other weights zero. Frozen normalizes only that nonfinite field to its default and scores **10**. Rust resets the whole settings object and scores **18.5**; both human and JSON differ (four pairs). Repeated against the supplied **fb11d613** CLI: same four mismatches (`cli-settings-base/rows.json`). `omni-store/src/settings.rs` is unchanged; this is not a toFixed failure or an introduced R3 regression, but A12's shared settings normalization is not fully JS-exact. Listed explicitly rather than silently counted equal or manifest-accepted.

### Remaining unverified items

No exhaustive cell/identity collision/capability/quota/pricing shape cross-product, PostgreSQL dry-run, isolated Rust-function rounding sweep, PTY/color/locale sweep, concurrent output-restoration DB race, fractional-now injected boundary, exhaustive huge literals/surrogates, timeout/body boundary or smart-model/catalog overflow sweep. NaN can arise live from finite arithmetic as demonstrated; malformed literal live targets remain subject to strict snapshot parsing, unchanged. Usage persistence failure for deliberately extreme prices is disclosed above, not fully investigated or assigned to A12's rank change.

Frozen dry-run intentionally uses fresh control rows, explicit stored virtual models, rand 0, no load/recent, no API-key allowlist/classifier. These remain deliberate differences from a loaded/smart live request, not migration exceptions. Do not relax live readers or change router types to resolve the remaining control/output findings.
