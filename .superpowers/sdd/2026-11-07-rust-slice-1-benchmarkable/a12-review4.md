# APPROVE

A12 at **`36345641114bfdd1cb80f4a5b8268a8b2d55ce37`**, narrow re-review across all four rounds. All previously blocking reproductions are resolved. No unexpected A12 differences in the independently executed final-head tests below. Approval relies on the explicitly documented plugin exclusions, remaining malformed-strategy echo class, and outside-A12 observations/verification limits listed below—not on an assertion of exhaustive parity.

Evidence paths are relative to `/tmp/opencode/a12-review/r4/`. Implementer evidence `/tmp/opencode/a12/f4-*` was not modified. No product/test edits, build, commit, merge, or real configuration access.

## Findings resolved

1. **Literal nonfinite JSON numbers:** stored targets now remain `JsValue` for arithmetic and output restoration. `crates/omni-control/src/dry_run.rs:130` uses `parse_js`; `:269–272` applies JS ToNumber directly as f64. No `serde_json::from_str` remains anywhere in this file. Its remaining serde deserialization builds the synthesized request and structurally typed targets; numeric fields are assigned afterward, not reparsed from stored JSON. Structural projection is still used for non-arithmetic typed fields/provider metadata, not advertised as a raw router carrier. The original `1e400` tier/price HTTP/CLI crash reproductions match frozen.
2. **Excluded raw credential ID:** output restoration at `dry_run.rs:205–213` now restores exclusion IDs, not just candidate IDs. The original disabled BLOB ID and combined BLOB ID + BLOB label cases match HTTP/JSON; human table errors also match.
3. **Human error precedence:** `dry_run.rs:34–61` now validates candidate table before excluded table, column-major width phase with nullish fallback, then row-major drawing phase. This matches frozen `apps/cli/src/output.ts:81–95` and `apps/cli/src/commands/models.ts:379–395`. Reproduced the original BLOB-label/null-model precedence and additional three-invalid-cell cases spanning candidate/excluded tables; stdout/stderr/exit codes match, including which error is reported first.

No new manifest entries were added: `git diff 3e4ff33f..36345641 -- conformance/e2e/models-dry-run-accepted.json` is empty, **16 entries remain**. No new changes to router logic/types, strict live store readers, gateway snapshot or dispatch in this round. Relevant frozen TS source files are unchanged from `1780bb39`.

## Independently verified

| Final-head check | Result |
|---|---|
| Committed HTTP corpus | **813 records**, 801 executed pairs + 12 constraint-rejected records; **2 accepted, 0 unexpected**, exit 0 |
| Committed CLI corpus | **348 records**, 330 executed pairs + 18 constraint-rejected records; **2 accepted, 0 unexpected**, exit 0 |
| Supplemental HTTP matrices | **453 pairs**, 452 equal + 1 manifest-accepted, **0 unexpected** |
| Supplemental non-plugin CLI | **114 pairs**, 109 equal + 1 manifest-accepted + 4 pre-existing settings differences outside A12, **0 unexpected A12 differences** |
| Original live poison-row discrimination | Both gateways' actual requests 503; both dry-runs 200, identical exclusions |
| Plugin probes | **10 pairs**, all plugin-excluded differences, unchanged from previous rounds |
| CLI acceptance mutation self-test | **7 cases passed**, exit 0 |
| HTTP acceptance mutation test | **6 cases passed**, exit 0 |
| `cargo fmt --all -- --check` | exit 0 |
| `cargo clippy --offline --workspace --all-targets -- -D warnings` | exit 0 |
| Unmodified namespaced `conformance/e2e/run.ts` | **49 table rows all equal**, exit 0 |

Supplemental HTTP count comprises original probes/probes2/probes3 (70 actual pairs; 10 rejected-update evidence records excluded), heterogeneous rank (318), R2 `more` (31), R3 `overflow` (2), R3 `new` (7), new numeric cells (23), and explicit overflow-equivalent cells (2). The one difference is the approved BLOB `score` strategy echo. `probes2.log` reports eight “failures” because that collector counts rejected NOT NULL mutations; its actual 28 differential pairs all match. No NULL-cell coverage is inferred from rejected updates.

Supplemental CLI count comprises `cli-overflow` (4), `cli-new` (20), `cli-extra` (6), `cli-render` (4), `cli-numbers` (6), `cli-more` (6), `cli-gaps` (12), `cli-table` (10), `cli-numeric` (46). `classifications.json` identifies every remaining non-equal supplemental pair: one HTTP strategy echo, one JSON CLI strategy echo, and the four known settings differences. Collectors may exit 0 while recording differences; counts come from their rows, not those exits.

### New cells around the fixes

`numeric.ts` / `numeric/run-JQYQzH/rows.json`: each of target **tier, weight, input price, output price, cacheRead** tested with stored JSON numeric literals **-1e400, 1e-400, -0, 1e309** (20 cases). `1e309` represents the overflowing numeric value of `1e308*10`; JSON cannot itself contain a multiplication expression. Also tested finite input/output and cacheRead/output cancellation combinations capable of producing nonfinite/NaN request costs, plus disabled BLOB credential ID with BLOB label. All **23 HTTP pairs equal**; human and JSON CLI for the same inputs: **46 pairs equal**. `arithmetic.ts` additionally confirms JS `1e308*10` is Infinity and checks ±overflow price forms (2 equal HTTP pairs). Tests compare candidate sets/order/scores/exclusions and raw echoes, not merely HTTP status.

`cli-table.py`: five combined fixtures, human and JSON each (**10 equal pairs**): excluded BLOB ID+label; candidate BLOB label + excluded BLOB ID + null model; candidate BLOB and numeric labels + null model; excluded BLOB ID + null model; candidate null model plus a malformed exclusion ID. These discriminate table ordering across rows/columns/tables. Raw candidate columns are label/model; exclusion columns ID/model/reason; generated string index/provider/tier/score are not mistaken for raw malformed cells.

Prior score-format checks were rerun through `cli-new`, `cli-numbers`, `cli-extra`: 0.0005 → `0.001`, 1.0005 → `1.000`, 123.4565 → `123.457`, zero → `0.000`, ±1e21 exponent notation, NaN/±Infinity, subnormal weights. Matches frozen except the separately isolated invalid-settings normalization cases below.

Acceptance: actual CLI helper rejects unlisted status/stderr/score/top-level order/nested order/extra-key mutations; positive approved echo accepted (7). Extracted unchanged HTTP checker rejects status/score/header/extra-key/order changes, accepts listed leaf (6). No unlisted-path or status difference was masked in the final results.

## Final artifacts / environment / gates not independently rerun

Independently hashed supplied final binaries:

- `/tmp/opencode/a12/f4-end-gateway`: `82586efdd2e314bb3518f144dff4d4cac335cbbf79d2c32af42d1d5876c81651`
- `/tmp/opencode/a12/f4-end-omni`: `ceb5f9218f298300b2b9cbd461b779d74f67964a837b73d341c92c22e36035de` (supplied CLI-alone artifact).

No cargo build was needed. Commands used private `r4/home`, scrubbed PATH, `--no-env-file` on Bun, namespaced gateways. Disk started at 20 GiB free; no build-space pressure. Worktree remains clean at final HEAD. Only scratch probes/report/evidence were created. Frozen oracle remains `/tmp/opencode/a8/ts`, independently hashed in round 1 as `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.

**Not independently rerun this round:** workspace tests, dispatch-size, six broader CLI corpora, X3, or final-corpus red-on-3e4ff33f discrimination. Implementer claims for those are not represented as reviewer-run evidence. Round 1 independently passed 1,351 workspace tests and clippy at the older HEAD; final-head clippy, fmt and run.ts were independently rerun here. Clippy reused the warm artifacts (0.34 seconds), with the prescribed offline/private-HOME/job/debug settings. The reported controller-caused X3 scratch deletion and standalone retry are implementer/controller evidence, not an independently reproduced failure or reviewer-verified retry. No need to rerun a build solely to validate this narrow control-only patch.

## Complete documented differences / outside-A12 observations

### `dry-run-malformed-render`: rows actually exercised as differences

The manifest still contains 16 controller-approved retained entries, but most now compare **equal** because raw output is restored. Final HTTP actually accepts only:

1. `UPDATE virtual_models SET strategy=x'73636f7265' WHERE id='score'`: statuses `[200,200]`, only `/body/strategy`. Frozen object `{"0":115,"1":99,"2":111,"3":114,"4":101}` versus Rust string `"115,99,111,114,101"`.
2. `UPDATE virtual_models SET strategy=x'6162' WHERE id='score'`: `[200,200]`, only `/body/strategy`. Frozen `{"0":97,"1":98}` versus Rust `"97,98"`.

Final CLI actually accepts **two executions of the same identity** (stored fixture and cross-product): `cli:UPDATE virtual_models SET strategy=x'6162' WHERE id='score'`, exits `[0,0]`, only `/strategy`, same object/string difference. Human strategy output matches. Both non-string strategies remain deterministic true and preserve frozen default ordering. No candidate/set/score/exclusion differences are authorized.

The other retained manifest entries—BLOB label; string `'2'`, null, `'-0'`, `[2]` tiers in their HTTP/JSON/human variants—are not currently exercised as differences. There are **no new accepted exclusions/IDs, errors, status classes, ranking changes, or hidden generic malformed-value allowance**.

### Plugin rows (user-excluded, all reverified)

`cli-probes/rows.json` (6), `cli-plugin-valid/rows.json` (2), `cli-plugin-loadable/rows.json` (2), human and JSON per fixture:

- **Loadable API-3 provider:** frozen exit 0, normal output; test plugin setup registers no descriptors. Rust stdout empty, exit 1, stderr exactly `plugin providers are not supported by this Rust CLI; bad in /tmp/opencode/a12-review/r4/cli-plugin-loadable/home/plugins declares one\n`.
- **Invalid JSON manifest `{`:** frozen human stderr exactly `plugin bad: manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'\n`; normal stdout, exit 0. Frozen JSON stderr empty, payload includes `pluginFailures:[{"id":"bad","reason":"manifest could not be read, so whether it supplies a provider is unknown: omni-plugin.json is not valid JSON: JSON Parse error: Expected '}'"}]`. Rust emits no warning, normal stdout/exit 0, JSON `pluginFailures:[]`.
- **Missing manifest:** same human/JSON/exit pattern; frozen reason `manifest could not be read, so whether it supplies a provider is unknown: no omni-plugin.json`; Rust omits it.
- **Schema-invalid apiVersion manifest:** same pattern; frozen reason `manifest could not be read, so whether it supplies a provider is unknown: api: Invalid input: expected number, received undefined`; Rust omits it.
- **API 1 on host API 3:** frozen reason `declares a provider but will not load: plugin api 1 is not supported by this host (api 3)` and human `plugin bad: <reason>\n`; Rust omits warning/failure, both exit 0.

The probe named `none` actually has a plugin directory with missing manifest. `cli-plugin-valid` uses host-incompatible API 1; genuinely loadable API 3 is separate. No arbitrary plugin registration/transport or gateway-plugin parity claim.

### Settings ±1e400 normalization — outside A12

Four `cli-new` pairs (human/JSON × settings tier-weight literal ±1e400, other weights zero): frozen defaults the nonfinite weight field and scores **10**; Rust defaults the whole settings object and scores **18.5**. Independently reproduced against **fb11d613** in round 3, before these fixes; shared settings reader unchanged. Still reproduced here, explicitly classified in `settings-classification.json`, not counted as equal or manifest-accepted. Not a score-rendering/A12 regression and excluded from this narrow approval as directed.

### Live extreme-price usage persistence — outside A12

Round-3 scratch real-request probe with finite `{input:1e308,output:-1e308}` prices reached NaN cost despite strict live readers. Both frozen and final-round-3 Rust selected `nan-cost`, byte-identical recorded upstream requests. The shared `omni-router/src/score.rs` guard fixed a latent parity bug: frozen tests `ownCost <= 0`, so NaN with a positive peer must reach ratio rather than UNKNOWN. No further router/store/gateway changes in round 4; this analysis still applies.

That deliberately extreme successful-upstream run separately hit Rust request-log `NOT NULL constraint failed: request_logs.cost_usd` and shutdown exit 1. It was **not** claimed as a clean gate, not fully investigated, and is retained as an outside-A12 persistence issue. Initial unknown-script variant also exposed transport-header/scenario differences; neither altered test was counted as a parity gate. The unmodified 49-row run passed independently in rounds 3 and 4. No claim that all live nonfinite pricing/accounting is supported.

## Remaining unverified items / scope assumptions

- No exhaustive arbitrary stored-JSON shapes, identity collisions, BLOB/string coercion collisions, missing structural fields, provider-data cross-product, quota/nonfinite settings cross-product, lone-surrogate identity sweep or all SQLite cell combinations. Validated cells are those enumerated by corpora/probes; constrained NULL updates are not treated as exercised stored values.
- No PostgreSQL dry-run, concurrent DB mutation between ranking/output restoration, injected fractional-now boundary, PTY/color/locale sweep, isolated private Rust toFixed exhaustive binary sweep, or new request-size/timeouts/path-encoding sweep. Prior tests covered up to 8 MiB, strict needs-schema/auth/viewer behavior, unknown/concrete IDs and empty pools; not every transport header.
- `rankedAt` is validated within 120 seconds then masked; fine-grained timing/staleness within that window is not checked. Parsed JSON corpus comparison masks whitespace differences, although supplemental CLI comparisons retain raw formatting except timestamp. JSON property insertion order remains checked, including acceptance mutation tests.
- Final live score change was evaluated in round 3 with a focused real-request ranking probe, not an exhaustive catalog/smart-router overflow matrix. Catalog/provider transport/plugin execution outside fixtures remains unverified.
- Frozen dry-run intentionally reads fresh control rows, only explicitly stored virtual-model IDs, rand 0, no load/recent/classifier/API-key allowlist. It is not a promise to predict live loaded/smart-request resolution; these intentional inputs match frozen, not newly accepted migration differences. Strict live reader policies and router types remain unchanged by the control fixes.

Approval is scoped to A12 under these user-approved exclusions and documented outside-A12 observations. No remaining blocker from rounds 1–3 reproduces in final A12 tests.
