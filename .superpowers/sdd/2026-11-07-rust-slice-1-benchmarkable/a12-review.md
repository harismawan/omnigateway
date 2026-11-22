# REQUEST CHANGES

Reviewed `a24941af..63e0ae42`, final HEAD `63e0ae42668a7be310803d617679719ce08e6c7f`. Three blocking findings below. The supplied HTTP/CLI matrices pass, but supplemental probes reproduce 11 HTTP and 6 CLI mismatches outside those matrices. Plugin differences are reported separately, not treated as blockers under the user's exclusion.

## Findings, by severity

### P1 — One unrelated, JSON-valid model row breaks every dry-run

- **Frozen:** `packages/control/src/dryRun.ts:47–48`; `packages/router/src/snapshot.ts:11–20`; `packages/store/src/sqlite/config.ts:65–75`. `listModels` parses JSON without validating Target[], and dry-run only ranks the selected model.
- **Rust:** `crates/omni-control/src/dry_run.rs:50–54` converts *every* per-model parse failure into a failure of the operation, before selecting the requested model. The typed reader at `crates/omni-store/src/models.rs:192–236` also rejects values frozen accepts.
- **Reproduction:** in the HTTP matrix's seed, execute `INSERT INTO virtual_models(id,targets,strategy) VALUES('broken','{}','score')`; request operator-authenticated `POST /api/models/score/dry-run` with `{}`.
- **Paired output:** frozen **200**, normal result with candidate IDs `["expired","ok","kilo"]`; Rust **500**, `{"error":{"code":"INTERNAL","message":"internal error"}}`.
- **CLI reproduction:** same DB mutation, `models dry-run score`, with and without `--json`. Frozen exit **0**, normal stdout, empty stderr. Rust exit **1**, empty stdout, stderr `virtual model broken: virtual_models.targets of broken: not a Target[]\n`.
- **Live-routing discrimination:** with all credentials disabled and the unrelated row present *before boot*, both gateways' actual `/v1/chat/completions` calls return **503** with exactly `{"error":{"message":"no eligible credential for model \"score\"","type":"server_error","code":"service_unavailable"}}`. Frozen dry-run returns **200**, empty candidates and the expected exclusions; Rust dry-run returns **500**. Thus the new dry-run is not even using the same model-row failure isolation as Rust live routing (`crates/omni-gateway-core/src/snapshot.rs:220–232`, which skips the unrelated unreadable row).
- **Additional paired repros:** `UPDATE virtual_models SET targets=json_set(targets,'$[0].tier','2') WHERE id='score'`: frozen **200**, selected OpenAI candidates retain `tier:"2"`, score `8.5`, after kilo; Rust **500**. CLI frozen exit 0 versus Rust exit 1, stderr `virtual model score: virtual_models.targets of score: not a Target[]\n`. Replacing the selected target's `capabilities.tools` with number `1` also produces frozen 200 / Rust 500 even for `{}` (no capability requested). A BLOB strategy `x'73636f7265'` is returned by frozen as `{"0":115,"1":99,"2":111,"3":114,"4":101}`, deterministic true, but Rust returns 500.
- **Required change:** preserve frozen operator dry-run's raw/coercive read semantics and isolate unused JSON-valid rows appropriately. Do not weaken strict gateway snapshot/routing reads to fix this control operation.
- **Evidence:** `probes/run-aEzuAf/rows.json`, `cli-gaps/rows.json`, `live/run-HupBEk/rows.json`. Full reproduction drivers: `probes.ts`, `cli-gaps.py`, `live.ts`.

### P2 — Strict credential reads silently remove candidates or suppress frozen errors

- **Frozen:** `packages/control/src/dryRun.ts:47`; `packages/router/src/snapshot.ts:13`; `packages/store/src/sqlite/credentials.ts:152–168,198–211`. Credential metadata is projected raw (except explicit enabled equality and JSON.parse); unused metadata does not disqualify a credential.
- **Rust:** new `crates/omni-control/src/dry_run.rs:56` calls strict `credentials::list_routing`; `crates/omni-store/src/credentials.rs:238–265,288–310` drops the entire row on type errors. That existing routing-hardening policy is not frozen dry-run behavior.
- **Reproduction:** independently apply any of these to the seed, then POST `{}` to the selected model:
  - `UPDATE credentials SET tier='oops' WHERE id='ok'`
  - `UPDATE credentials SET label=x'6162' WHERE id='ok'`
  - `UPDATE credentials SET expires_at=1.5 WHERE id='ok'`
  - `UPDATE credentials SET disabled_at=1.5 WHERE id='ok'`
- **Paired output:** both return **200**, but frozen candidates are `["expired","ok","kilo"]`; Rust candidates are `["expired","kilo"]`, without an exclusion explaining the missing credential. The BLOB label is returned by frozen as `credentialLabel:{"0":97,"1":98}`. The fractional API-key expiry is particularly misleading: frozen intentionally ignores API-key expiry during eligibility, while Rust removes the row before ranking.
- **CLI:** TEXT credential tier reproduces the missing candidate in both human and JSON output, both exit 0; this is not an HTTP-only presentation difference.
- **Error-direction repros:** `UPDATE credentials SET provider_data=x'7b7d' WHERE id='ok'` gives frozen **500** INTERNAL, Rust **200** with the credential omitted. `provider_data='null'` also gives frozen **500**, Rust **200**, this time retaining `ok`. Frozen's error must not be silently changed into a successful diagnostic.
- **Required change:** give this admin/control operation a frozen-compatible read/projection path; do not broaden the X3 routing-strict exception to operator output, or change the live gateway's strict policy as a side effect.
- **Evidence:** `probes/run-aEzuAf/rows.json`, `probes2/run-XrwIDc/rows.json`, `probes3/run-Uz3hvd/rows.json`, `cli-gaps/rows.json`; drivers alongside them at the review root.

### P2 — A BLOB health identity turns a harmless unrelated health row into 500

- **Frozen:** `packages/store/src/sqlite/credentials.ts:54–61,315–316`; `packages/router/src/snapshot.ts:8,20`. Health identities are retained and string-coerced when constructing the composite key.
- **Rust:** `crates/omni-control/src/dry_run.rs:57` uses `list_health`, whose `health_from_row` requires TEXT identities (`crates/omni-store/src/credentials.rs:482–485`) and fails the entire read (`499–520`). Live snapshot reads instead call `list_routing_health` and isolate unaddressable rows (`crates/omni-store/src/lib.rs:145–146`).
- **Reproduction:** `PRAGMA foreign_keys=OFF; UPDATE credential_health SET credential_id=x'6162'`; operator POST `{}` to `/api/models/score/dry-run`.
- **Paired output:** frozen **200**, candidates `["expired","ok","unhealthy","kilo"]` (the old unhealthy credential no longer has a matching health key). Rust **500**, `{"error":{"code":"INTERNAL","message":"internal error"}}`.
- **Required change:** reproduce frozen control-side health key construction without changing strict gateway snapshot behavior. Merely swapping in routing isolation is not a general substitute for frozen coercion when a coerced identity can match a real key.
- **Evidence:** `probes/run-aEzuAf/rows.json`, case named by the exact UPDATE, generated by `probes.ts`.

## X3 boundary / ranking analysis

Dry-run is an operator-authenticated **control read of fresh database rows**, not an inference request against the published gateway snapshot. Frozen `dryRun.ts:45–84` validates needs, builds a fresh snapshot, explicitly looks up a stored virtual model, and calls the shared ranker with rand 0, no load, no recent-use state. Thus X3's admin/control compatibility requirement applies to this output; strict live routing/snapshot policies must remain separate. The three findings concern the new call sites, not a request to undo existing strict gateway policy.

Rust correctly reuses `omni_router::rank`, the same function invoked by live `crates/omni-gateway/src/dispatch.rs:514–523`. It supplies the same capabilities probe, current time and provider descriptors; intentionally different inputs are fresh DB rows rather than the holder's cached snapshot, rand 0 rather than a draw, and absent load/recent rather than active request accounting. These differences also exist in frozen dry-run. No API-key allowlist or smart-router classifier participates in frozen dry-run; concrete catalog/provider shorthand is not resolved, only explicitly stored virtual-model IDs. Do not “fix” those deliberate semantics into live-request resolution/classification.

The committed ranking fixtures are weak: all targets have equal pricing/capabilities, both matching providers share tier 1, so capability filtering, nontrivial score ordering and strategy differences are barely exercised. My separate `rank.ts` matrix uses different model IDs, prices, tiers, weights and capabilities, half-open/degraded health, all four recognized strategies plus an unknown strategy (frozen preserves it and retains default order). **318/318 paired rows match**. The live poison-row probe above demonstrates the remaining input-construction divergence directly without contacting any provider.

## Verification performed independently

All evidence paths here are under `/tmp/opencode/a12-review/`; implementer evidence was read-only. Gate exits were read from `.exit` files, not inferred from the outer shell exit.

| Verification | Result |
|---|---|
| Committed HTTP driver, base binary | 273 rows, **273 mismatches**, exit 1 |
| Committed HTTP driver, final binary | 273 rows, **0 mismatches**, exit 0 |
| Committed CLI corpus, base CLI artifact | 100 cases, **100 mismatches**, exit 1 |
| Committed CLI corpus, final CLI artifact | 100 cases, **0 mismatches**, exit 0 |
| Expanded heterogeneous ranking/auth/schema matrix | 318 pairs, **0 mismatches**, exit 0 |
| Supplemental HTTP schema/stored-cell/header probes | 70 pairs, **11 mismatches**; includes 5 baseline pairs after constraint-rejected updates, not claimed as NULL-cell coverage |
| Live inference versus dry-run poison-row probe | 2 gateway observations, both live 503; frozen dry 200 / Rust dry 500 |
| Supplemental non-plugin CLI probes | 12 pairs, **6 mismatches**; empty pool, baseline/raw JSON formatting and invalid secret cases match |
| Supplemental plugin CLI probes | 10 pairs, all differ; details/exclusion below |
| `cargo test --offline --workspace` | exit 0; **1,351 passed, 37 ignored**, no retry |
| `cargo clippy --offline --workspace --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all -- --check` | exit 0 |
| Namespaced `conformance/e2e/run.ts` | exit 0, **49 table rows**, all equal |

`probes*.exit` being 0 means the probe collected evidence; those scripts deliberately do not fail the process for differential mismatches. Counts above come from their `rows.json`, excluding seed-error records. NULL updates to NOT NULL credential tier/enabled, model targets/strategy and health model were rejected by SQLite and are **not** claimed as successful malformed-cell tests. REAL/BLOB/TEXT and nullable health timestamp cases were exercised. The three named load-sensitive workspace tests all passed on the first run; no flaky rerun was needed.

HTTP body/auth checks: base/green matrix includes strict extra-key/type/default parsing, raw invalid/missing JSON, arrays/null, concrete/unknown IDs, anonymous/viewer/operator. Independently confirmed **90 anonymous 401**, **90 viewer 401**, and operator 36×200 / 36×400 / 18×404, plus 3 raw-body 400s. Anonymous/viewer error is exactly `{"error":{"code":"AUTH","message":"admin session required"}}`; viewer is not 403. Extra probes cover primitives, multiple invalid fields/extra keys, duplicate JSON keys, 10,000-element arrays, 2 MiB and 8 MiB bodies, plain-text/form/missing content-type. Tested error bodies and stable response headers match in those schema/header cases. The 8 MiB JSON object reaches schema validation on both (400 unrecognized key), rather than an invented size limit.

Fresh-row observation is black-box verified: stored-row probes mutate both databases after gateway startup and frozen/Rust dry-runs reflect those changes. Breaker/cooldown future/elapsed and half-open/failure-count ranking were probed; API-key expiry, expired OAuth, disabled credentials and provider:missing are covered. Plugin/provider transport execution is not required or exercised.

Environment: final worktree was clean at the required HEAD; no product/test edits, commits, merges, plugin installation outside scratch, or real configuration access. Cargo ran serially with the prescribed private HOME/offline/job/debug environment; disk stayed above 5 GiB (16 GiB initially, 15 GiB later). Gateways ran in isolated `unshare -Urn` namespaces, Bun calls used `--no-env-file`. No controller/admin-routes corpus was run. No rebuild was needed: tested supplied artifacts after independently hashing them. Frozen `apps/` and `packages/` have no diff against `1780bb39`, including the source CLI oracle used by its corpus.

Verified SHA-256:

- Frozen `/tmp/opencode/a8/ts`: `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.
- Final gateway: `049c0bfc514f346df9101e25624dbb7110641540ec79a0c0ec480126ad9615a9`.
- Final CLI: `b3aff20fb69c984476118c6b3144c7c9d3ed120c58775908f4d44ca62da9d9b8`.
- Base CLI artifact `/tmp/opencode/a12/cli-base`: `368be9f5a9d22f787dec044e61eed8b0e185cbffe5510492a473b837108a2c2a`. Artifact provenance was supplied rather than independently rebuilt; its red discrimination was independently executed.

## Plugin differences (excluded by user ruling, exact outputs recorded)

`cli-probes.py`'s initial label `none` means **plugin directory present but manifest missing**, not a plugin-free root. The separate `cli-gaps.py` baseline is actually plugin-free. `cli-plugin-valid.py` uses API 1 and is host-incompatible, not loadable. `cli-plugin-loadable.py` uses API 3 and verifies the accepted refusal. Each was tested in human and JSON mode.

1. **Loadable provider manifest:** frozen exits 0 and prints the normal result (this test plugin's setup registers no descriptors); Rust stdout is empty, exit **1**, stderr exactly:

   `plugin providers are not supported by this Rust CLI; bad in /tmp/opencode/a12-review/cli-plugin-loadable/home/plugins declares one\n`

   This is the explicitly accepted unsupported-plugin refusal.

2. **Invalid JSON manifest**, file `plugins/bad/omni-plugin.json` containing `{`: both exit **0**. Frozen human stdout is the normal ranking, with stderr exactly:

   `plugin bad: manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'\n`

   Frozen JSON stdout carries:

   `"pluginFailures": [{"id":"bad","reason":"manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'"}]`

   JSON stderr is empty. Rust human stdout is the normal ranking **without that stderr warning**; Rust JSON stdout instead has **`"pluginFailures": []`**, stderr empty. Frozen references: `apps/cli/src/commands/models.ts:337–365`, `packages/control/src/pluginProviders.ts:548–574`. Rust: `crates/omni-cli/src/models.rs:561,571–575`. This is a real output difference, not merely an unexecuted plugin limitation.

3. **Missing manifest:** same exit/output pattern; frozen warning/reason ends `no omni-plugin.json`, Rust omits it and returns `pluginFailures: []`.

4. **Manifest API 1 on host API 3:** frozen human warning `plugin bad: declares a provider but will not load: plugin api 1 is not supported by this host (api 3)\n`; JSON failure is `{"id":"bad","reason":"declares a provider but will not load: plugin api 1 is not supported by this host (api 3)"}`. Rust emits neither and returns `pluginFailures: []`; both exit 0.

## Corpus limitations / remaining unverified items

- Both supplied corpora discriminate red on base, but do not cover the blocking stored-cell classes. The HTTP driver checks status/content-type/parsed JSON property order, not raw JSON whitespace or every header. It checks rankedAt within 120 seconds then replaces it: fine-grained timing and an up-to-120-second stale value would be masked. CLI JSON is parsed and reserialized, preserving property order but masking pretty-print/whitespace differences; my plugin-free baseline and empty-pool JSON comparisons instead preserve raw formatting except the timestamp and match.
- CLI supplied corpus depends on the newest seed under implementer `/tmp/opencode/a12/http`; my rerun redirects only its output directory to review evidence. Supplemental CLI probes use my independently generated HTTP seed. Thus supplied seed discovery is not hermetic.
- No arbitrary plugin loading parity is claimed. Above four concrete plugin classes are the documented excluded differences; valid provider transport execution and gateway plugin behavior were not paired.
- No exhaustive malformed-cell cross-product, PostgreSQL dry-run, concurrent DB publication race, long idle/body timeout, larger-than-8-MiB boundary, PTY/color output, exhaustive JS/Rust score-rounding boundary, non-ASCII width/locale or all path-encoding variants was tested. Active-load/recent-use and smart-classifier routing are not dry-run inputs in frozen; no claim that dry-run predicts those live effects.
- Fixed rand=0 and all four virtual strategies are verified for the tested pools, not every numeric/overflow/NaN/weight/quota combination. The added heterogeneous matrix improves discrimination, but does not make the small corpus exhaustive.

The green gates do not resolve the three operator/control compatibility findings. Preserve the strict live-gateway boundary while correcting this new operation, then add discriminating regression coverage for the paired reproductions above.
