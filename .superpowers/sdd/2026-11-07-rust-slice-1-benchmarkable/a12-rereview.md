# REQUEST CHANGES

A12 at `fb11d6132b26248c017071a9ac5ca43117115c8c`. The original three findings are resolved within the new user-approved `dry-run-malformed-render` boundary. Additional probes find **14 unaccepted HTTP pairs and 8 unaccepted CLI pairs**, plus a mutation-test hole in CLI acceptance. These are not plugin differences. No product edits or builds were made.

All evidence below is relative to `/tmp/opencode/a12-review/r2/` unless explicitly stated.

## Findings

### P1 — TEXT/null target prices still turn a routable model into INTERNAL

**Frozen:** `packages/control/src/dryRun.ts:47,76–84`; `packages/store/src/sqlite/config.ts:65–75`; `packages/router/src/score.ts:76–85,108–110,155–167`. The stored prices are not schema-validated; arithmetic coerces them.

**Rust:** `crates/omni-control/src/dry_run.rs:121–129,139`: only tier, weight and capabilities are normalized before deserializing into typed `Target`; prices are not. `crates/omni-store/src/models.rs:49–52` requires f64 input/output prices.

Reproduce against the normal seed:

```sql
UPDATE virtual_models
SET targets=json_set(targets,'$[0].costPerMTok.input','2')
WHERE id='score';
```

Operator `POST /api/models/score/dry-run` with `{"tools":true}`:

- Frozen: **200**, candidates in order `kilo, expired, ok`; scores `18.5, 18.490677134445534, 18.490677134445534`.
- Rust: **500**, `{"error":{"code":"INTERNAL","message":"internal error"}}`.

CLI `models dry-run score`, both human and `--json`:

- Frozen: exit **0**, normal ranking stdout, empty stderr.
- Rust: exit **1**, empty stdout, stderr **`invalid type: string "2", expected f64\n`**.

All six tested price cases (input/output × TEXT `'2'`, TEXT `'oops'`, JSON null) are frozen 200 / Rust 500. This is not an accepted echo difference. In particular, even a numeric string or null price still crashes the diagnostic.

Evidence: `more/run-z1KCCY/rows.json`, `cli-more/rows.json`; drivers `more.ts`, `cli-more.py`. Apply the same operator-local coercion principle without changing router types or strict live readers.

### P1 — Nonfinite target coercions are serialized to null and then rejected

**Frozen:** `packages/store/src/sqlite/config.ts:65–75`; `packages/router/src/score.ts:14–16,104–106,155–167`; result projection `packages/control/src/dryRun.ts:86–98`. NaN/Infinity can participate in ranking; JSON serialization renders nonfinite results as null rather than failing the operation.

**Rust:** `crates/omni-control/src/dry_run.rs:122–124` evaluates ToNumber but immediately writes it through `json!`; NaN/Infinity become JSON null, which typed deserialization at **line 139** refuses as f64. Thus evaluating ToNumber is insufficient to preserve its result.

Reproduction:

```sql
UPDATE virtual_models
SET targets=json_set(targets,'$[0].tier','oops')
WHERE id='score';
```

- HTTP with `{"tools":true}`: frozen **200**, candidate IDs `expired, ok, kilo`, scores `[null,null,null]`; Rust **500** INTERNAL.
- CLI human and JSON: frozen exit **0**, normal stdout; Rust exit **1**, empty stdout, stderr **`invalid type: null, expected f64\n`**.

Also reproduced with tier `'1e400'`, weight `'oops'`, weight `'1e400'`, and tier `{}`. All are status differences, not covered by the manifest. These five cases plus the six price cases above are **11 new HTTP 200→500 mismatches**.

Evidence: `more/run-z1KCCY/rows.json`, `cli-more/rows.json`.

### P2 — Further malformed echoes differ outside the exact seven-row manifest

**Frozen:** `packages/control/src/dryRun.ts:91–98` echoes the original target tier. **Rust:** `crates/omni-control/src/dry_run.rs:122–124,83` echoes the coerced number. The manifest `conformance/e2e/models-dry-run-accepted.json:3–10` allows only its enumerated identities and paths; it does not authorize every malformed tier.

Independently update `targets` using `json_set(targets,'$[0].tier',VALUE)` for each VALUE below, then POST `{"tools":true}`:

| VALUE | Frozen tier | Rust tier | Exact differing paths |
|---|---|---|---|
| `NULL` | null | 0 | `/body/candidates/0/tier`, `/body/candidates/1/tier` |
| `'-0'` | string `"-0"` | 0 | same |
| `json('[2]')` | `[2]` | 2 | `/body/candidates/1/tier`, `/body/candidates/2/tier` |

All have matching candidate sets/order/scores/exclusions, but **none of these identities is listed**. They are findings under the explicit rule “any render-only difference outside the manifest is a finding,” not implied additions to the accepted class. For the null-tier case, CLI human and JSON output also differ (both exit 0): frozen human TIER is `null`, Rust `0`; JSON candidates carry null versus 0.

A separate **score rendering** difference is not a malformed echo at all: `UPDATE credentials SET weight=1e400 WHERE id='ok'`. Frozen human CLI ranks `ok` first with **`Infinity`**; Rust ranks it first but prints **`NaN`**. JSON agrees because both serialize that score as null. Frozen references: `packages/router/src/score.ts:167`, `apps/cli/src/commands/models.ts:385–394` (score.toFixed); Rust `crates/omni-control/src/dry_run.rs:83` loses Infinity through JSON, then `crates/omni-cli/src/models.rs:785–787` prints NaN for null. This is neither a plugin difference nor an approved manifest path.

Evidence: `more/run-z1KCCY/rows.json`, `cli-more/rows.json`, `cli-numbers/rows.json`; `classifications.json` enumerates every supplemental HTTP difference with its paths.

### P2 — BLOB credential label changes human CLI exit/stderr, not just its accepted JSON echo

**Frozen:** `apps/cli/src/commands/models.ts:369–396` passes the raw label into the table; `packages/control/src/dryRun.ts:93` preserves it. **Rust:** `crates/omni-control/src/dry_run.rs:163,178` stringifies the BLOB label, then `crates/omni-cli/src/models.rs:781` prints it successfully.

```sql
UPDATE credentials SET label=x'6162' WHERE id='ok';
```

Run **human** `models dry-run score`:

- Frozen: exit **1**, stdout empty, stderr exactly:

  `text.replace is not a function. (In 'text.replace(/\u001b\[[0-9;]*m/g, "")', 'text.replace' is undefined)\n`
- Rust: exit **0**, stderr empty, normal ranking stdout with credential label `97,98`.

The approved CLI BLOB-label entry has statuses `[0,0]` and JSON path `/candidates/1/credentialLabel`; it applies to `--json`, not to this exit-code/stderr/human-output difference. The human case is absent from the 210-case corpus (BLOB label is only in its JSON cross-product).

Evidence: `cli-render/rows.json`; `--json` of this same case was separately checked and **is** manifest-accepted.

### P2 — CLI manifest acceptance masks unlisted JSON property-order changes

**Frozen contract:** result order is explicitly constructed in `packages/control/src/dryRun.ts:86–108` and spread into CLI output at `apps/cli/src/commands/models.ts:365`. User requires property-order parity outside exact accepted paths.

**Rust-side corpus:** `conformance/cli/models-dry-run.py:59–66` parses both outputs, masks allowed values, then uses Python dictionary equality. That equality ignores insertion order at every object depth.

Mutation test extracted the actual acceptance block, used the listed CLI BLOB-label identity/statuses, and additionally reordered **unlisted top-level keys** `strategy,candidates` to `candidates,strategy`. The checker sets **`accepted: true`**. A mutation containing only the approved echo is accepted as expected; score, exit status, stderr and extra-key mutations are rejected. HTTP's extracted checker rejects property-order, score, status, header and extra-key mutations.

Evidence: `mutation-cli.py`, `mutation-cli.json` (`mutation: "order"`), `mutation-http.ts`, `mutation-http.json`. **12 mutation cases total**: the one CLI order case is an erroneous acceptance. Preserve ordered comparison after masking only the approved leaf paths. No claim that final binary currently reorders those keys; this is a verified enforcement gap.

## Original findings / boundary review

- My original `probes` rerun: **28 pairs, 3 differences**, each exactly manifest-accepted: BLOB label, BLOB `score` strategy, numeric-string target tier. Paths/statuses independently compared to the manifest.
- `probes2`: **28 pairs, 0 differences**, plus 8 seed-error records (four NOT NULL mutations rejected independently on each DB). Its printed `failures:8` counts these seed errors, not mismatched pairs.
- `probes3`: **14 pairs, 0 differences**, plus 2 rejected-update records. BLOB and `'null'` provider_data now return frozen's 500, and fractional disabled_at no longer drops the candidate.
- `cli-gaps`: **12 pairs**, one difference, exactly the accepted JSON string-tier echo. No unexpected differences.
- `live`: both real inference calls 503 with identical bodies; both dry-runs 200 with identical empty pools/exclusions despite the unrelated poison row.
- `rank`: **318 pairs, 0 differences** (heterogeneous prices, tiers, weights, capabilities, health; all four strategies and unknown strategy).
- Diff from `63e0ae42` changes only control dry_run and the three corpus/manifest files. **No changes** to `omni-router`, `omni-store`, `omni-gateway-core`, or `omni-gateway`; strict live readers and router types really are unchanged. Relevant frozen TS files have no diff from `1780bb39`.

Source review: capability normalization uses JS truthiness, correctly matching frozen `packages/router/src/filters.ts:209` (`need[cap] && !target.capabilities[cap]`), not strict true equality. Tests of TEXT `'false'`, 0 and 1.0 capability values match with tools requested. BLOB health IDs use comma-joined decimal bytes, matching String(Uint8Array); the original health-key probe now matches. Expiry compares f64 before encoding its predicate, so no fractional floor is introduced; NaN-producing TEXT expiry correctly does not expire OAuth. Disabled_at TEXT does not remove a candidate. Credential TEXT/BLOB numeric weights, NaN/Infinity credential weight JSON ranking, huge integer target tier/weight and negative zero numeric cases tested here match. However, this is **not** proof every coercion is JS-exact: target nonfinite values and prices fail as shown above. There is no need or authorization to modify strict live readers or introduce a raw router carrier to address these findings.

## Independently executed verification

| Check | Result |
|---|---|
| Final committed HTTP corpus | **747 records**, 737 actual pairs + 10 constraint-rejected records; 5 accepted, **0 unexpected**, exit 0 |
| Final committed CLI corpus | **210 records**, 200 executed pairs + 10 constraint-rejected pairs; 3 accepted, **0 unexpected**, exit 0 |
| Original supplemental HTTP probes | 70 pairs, **3 accepted**, 0 unexpected; 10 rejected-update records excluded |
| Original heterogeneous rank matrix | 318 pairs, all equal |
| Original live discrimination | 2 gateway observations, equal |
| Additional ranking-cell matrix | **31 pairs: 16 equal, 1 manifest-accepted, 14 findings** |
| Original CLI gaps + new CLI probes | **28 pairs: 17 equal, 3 manifest-accepted, 8 findings** |
| Plugin probes | **10 pairs**, all differences plugin-excluded; see list below |
| Acceptance mutations | 12 tests, one erroneous acceptance (CLI key order) |
| `cargo fmt --all -- --check` | exit 0 |

Supplemental collectors intentionally exit 0 after collecting mismatches; classifications/counts above use rows, not their exit status. `classifications.json` covers all 18 differing supplemental HTTP pairs (4 accepted, 14 findings). `classifications-cli.json` covers all 11 differing supplemental non-plugin CLI pairs (3 accepted, 8 findings). All other pairs are equal; plugin rows are separately classified below. Committed drivers perform their own manifest classification.

No build was needed; **workspace/clippy/dispatch/X3/six other CLI corpora/run.ts were not rerun in round 2**, and implementer claims for them are not presented as independent verification. Round 1 workspace/clippy/run results apply to the earlier HEAD, not this revision. Red-on-63e0ae42 f2 counts were not rerun; prior original-corpus base-red discrimination remains recorded in round 1. Gateways ran namespaced, Bun used `--no-env-file`, tools ran from the clean designated worktree with private HOME under `r2`; no real .env/config was used. Disk started at 13 GiB free, no build performed. Worktree remains clean at required HEAD.

Final binaries independently hashed:

- gateway `/tmp/opencode/a12/f2-final2-gateway`: `b19320e5e97bea52ca8eb05dcf8945b3d1c21d201f108127304c8cbbfe3023d6`
- CLI `/tmp/opencode/a12/f2-final2-omni`: `e3a8a5dc317d97db4cd6fb89ebe6dfd209f7ff5100944a3576c480fe48602c86`

## Accepted / excluded differences and remaining limits

### `dry-run-malformed-render` (only these seven manifest entries)

1. HTTP strategy BLOB `x'6162'`: only `/body/strategy`, statuses `[200,200]`.
2. HTTP strategy BLOB `x'73636f7265'`: same path/statuses.
3. HTTP label BLOB `x'6162'` on credential `ok`: only `/body/candidates/1/credentialLabel`, `[200,200]`.
4. HTTP selected target tier string `'2'`: only `/body/candidates/1/tier`, `/body/candidates/2/tier`, `[200,200]`.
5. JSON CLI strategy BLOB `x'6162'`: only `/strategy`, exits `[0,0]`.
6. JSON CLI label BLOB `x'6162'`: only `/candidates/1/credentialLabel`, `[0,0]`.
7. JSON CLI tier string `'2'`: only `/candidates/1/tier`, `/candidates/2/tier`, `[0,0]`.

For strategies/labels frozen echoes byte-index objects while Rust echoes comma-joined strings; for string tier frozen echoes the string while Rust echoes a number. Ranking/set/order/scores/exclusions must still match. None of the new finding identities is silently added to this list.

### Plugin rows (user-excluded, reverified on final CLI)

Evidence: `cli-probes/rows.json` (six pairs), `cli-plugin-valid/rows.json` (two), `cli-plugin-loadable/rows.json` (two). The misleading `none` label in the first driver means a plugin directory with **missing manifest**, not a plugin-free root; `provider` in that driver is a schema-invalid apiVersion manifest. The API-1 driver is host-incompatible; the API-3 driver is the genuinely loadable manifest. All run human and JSON modes.

- **Loadable API-3 provider:** frozen exit 0, normal output (test setup registers no descriptors); Rust exit 1, stdout empty, exact stderr `plugin providers are not supported by this Rust CLI; bad in /tmp/opencode/a12-review/r2/cli-plugin-loadable/home/plugins declares one\n`.
- **Invalid JSON manifest** containing `{`: frozen human stderr exactly `plugin bad: manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'\n`; normal stdout, exit 0. Frozen JSON stderr empty, `pluginFailures:[{"id":"bad","reason":"manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'"}]`. Rust exit 0, normal stdout without warning; JSON has `pluginFailures:[]`.
- **Missing manifest:** same pattern; frozen reason is `manifest could not be read, so whether it supplies a provider is unknown: no omni-plugin.json`; Rust omits warning/failure.
- **Schema-invalid apiVersion manifest:** same pattern; frozen reason is `manifest could not be read, so whether it supplies a provider is unknown: api: Invalid input: expected number, received undefined`; Rust omits it.
- **API 1 on host API 3:** frozen reason `declares a provider but will not load: plugin api 1 is not supported by this host (api 3)` and human warning `plugin bad: <reason>\n`; Rust omits it and returns `pluginFailures:[]`. Both exit 0.

No plugin transport/registration parity is claimed. Those exclusions do not cover BLOB-label human exit changes or other findings above.

### Other limits

No exhaustive malformed JSON/cell/identity/weight/quota cross-product, property-access getter semantics, PostgreSQL dry-run, PTY/color/locale/rounding boundary sweep, concurrency/publication race, active-load prediction, or new fractional-now injected boundary test was executed. BLOB/NULL **credential tier** constraint limits remain; target tier nested JSON null is legal and tested. Prices used TEXT/null, not every possible object/array shape. rankedAt is still validated within 120 seconds then masked; corpus JSON parsing masks whitespace differences. HTTP checks content-type and parsed-property order, not every transport header. CLI baseline/raw-format and several supplemental human cases retain byte comparison except timestamp, but JSON acceptance has the order hole above.

Frozen dry-run still intentionally uses fresh control rows, explicit stored virtual models, rand 0 and no load/recent/classifier/API-key allowlist; it need not predict live load or smart routing. These intentional semantics are not new accepted parity differences.

**Conclusion:** the original regressions are fixed, but the finite typed target projection is not yet sufficient for the newly requested cell classes. Keep the stated architecture boundary; resolve the remaining crashes and unapproved output differences, and tighten the CLI manifest checker before approving A12.
