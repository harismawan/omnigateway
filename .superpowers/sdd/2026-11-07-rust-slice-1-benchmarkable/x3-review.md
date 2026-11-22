# X3 independent review

Verdict: **REQUEST CHANGES**. Five Important findings below; no Critical finding established. All requested runnable gates and six CLI corpora now finished.

## Findings first
### Important: health quota identifiers still pass through strict typed reads

`crates/omni-control/src/credentials.rs:206-210` re-reads `credential_id` and `window_type` as `String` after making a coercing JSON projection; burn output also reconstructs both with typed `text` at lines 332-333. Frozen preserves raw cells in both quota and burn results (store `credentials.ts:363-372`; control `credentials.ts:239-261`, `quota/burn.ts:49-56`). On a hand-altered no-affinity `quota_windows`, with an otherwise healthy row:

```sql
INSERT INTO quota_windows VALUES('510df117-69fe-48d1-af6d-74a4856ea35f', 'daily',1700000000000,1,10,1800000000000,1700000000000,86400000);
UPDATE quota_windows SET credential_id=X'7178';
-- independently:
UPDATE quota_windows SET window_type=1;
```

Authenticated operator request `GET /api/credentials/health`: frozen **200**, Rust **500** `{"error":{"code":"INTERNAL","message":"internal error"}}` in both cases. Frozen quota/burn identifiers are respectively `{"0":113,"1":120}` / `"daily"`, or the original credential id / `1`. Full exact bodies: `quick.log:2,5`; reproducible harness `quick.py`, evidence `operator-b3xu00ik/results.json`. This is an operator HTTP route, not auth/routing; neither accepted class applies.

Complete exact no-affinity CREATE/INSERT-copy SQL for the altered-table cases is retained in `recreate-no-affinity.sql`; it preserves rows but removes affinities/defaults just as the corpus generator does. Begin from the copied frozen `seed.db` (READ-ONLY original); use the credentials stanza for PATCH/POST and quota stanza for INTEGER window_type. BLOB quota cases additionally reproduce on the shipped schema, requiring no CREATE/DROP operation.

Corpus classification is broader than its description: `routing-strict` accepts **any** `/v1/models` difference, or any `/api/client/*` difference when the mutated table is `api_keys`; the preceding class accepts any frozen error / Rust success on `/v1/models`. Each accepted row therefore needs independent inspection. The committed 2,995-pair matrix does not mutate `quota_windows` or `credential_health` cells, even though `/api/credentials/health` reads both; this explains the missing failures.

### Important: BLOB quota arithmetic does not match JS typed-array coercion

Separate health-extra probes found 2 additional 200/200 body differences: `UPDATE quota_windows SET observed_at=X'7178'` makes frozen `burn[0].exhaustsAt` the string `"113,120NaN"`, Rust emits null; `UPDATE quota_windows SET observed_at=X''` makes frozen burn suppressed (`windowStartsAt:null,survives:null,stale:true`), Rust emits `windowStartsAt:1799913600000,survives:false,stale:false`. Other seeded quota cells are exactly the INSERT above, with a healthy `credential_health` row. Request remains `GET /api/credentials/health`. Frozen `quota/burn.ts:43-56,85-135` uses JS relational/arithmetic + semantics on Uint8Array (empty BLOB ToNumber is 0; addition concatenates its string). Rust `credentials.rs:192-197` treats any projected object as NaN and lines 293-317 only concatenate TEXT. This does not require arbitrary object-valued-field ToPrimitive emulation: these are SQLite BLOBs/Uint8Arrays already handled by `cli_cell::scalar_string`/`scalar_number`. Exact full responses and SQL in `operator-rgw70hev/differences.json`; 182 health-extra pairs = 160 equal / 22 different (20 strict id/type reads, 2 observed_at arithmetic).

### Important: credential PATCH writes REAL tier/weight where frozen writes INTEGER

Exact no-affinity fixture mutation `UPDATE credentials SET label=X'7178'`; request `PATCH /api/credentials/510df117-69fe-48d1-af6d-74a4856ea35f` with `{"weight":2}`. Both responses **200** `{"ok":true}`, but frozen stores `typeof(weight)='integer',hex(weight)='32'`; Rust stores `typeof(weight)='real',hex(weight)='322E30'`. `credentials.rs:470` builds `CredentialPatch.weight:Option<f64>`, store credentials.rs:167 binds it as REAL. Frozen control credentials.ts:331 -> store credentials.ts:268 binds Bun JS number as INTEGER for integral numbers. This is a mutation effect outside either accepted class; CLI's altered-schema exceptions explicitly do not extend to HTTP. **182** extended probe differences are exactly this typed-state mismatch, verified by replacing only that cell in captures. Full SQL/requests/states: `operator-_feqp0x3/differences.json`. Fix integral JS-number binding for operator mutations without loosening routing readers.

Additional minimal probe `operator-inrx_12j` confirms **both** `{"tier":2}` and `{"weight":2}` produce the same integer-vs-real stored-cell divergence (2/2 differences).

### Important: credential POST synthesizes tokenVersion incorrectly after schema alteration

On the same no-affinity credentials table (defaults removed), `UPDATE credentials SET label=1`; `POST /api/credentials` with `{"provider":"openai","apiKey":"sk-synthetic-second","label":"second"}`. Both **200** and both store new `token_version=NULL`, but frozen response `credential.tokenVersion=0`; Rust response null. Frozen store credentials.ts:246-255 explicitly returns `tokenVersion:0` independent of stored defaults; Rust credentials.rs:610 re-reads the inserted row, then overrides label only. This is **32/32** creation probes, confirmed by masking only generated id, encrypted ciphertext and creation/update clocks (`creation-audit.py` / `creation-audit.json`); all remaining response/state fields match. Exact full captures: `operator-kxj52mbq/results.json` (first POST pair at index 442). Preserve frozen create-return metadata instead of depending on DB defaults. The HTTP scope does not inherit CLI altered-schema exemptions.

### Important: routing-strict class hides a client display-reader failure

Own committed corpus run `operator-8l_ijevs` reproduces advertised **2,995 / 2,885 equal / 95 routing-strict / 15 frozen-JSON / 0 unexpected**. However the 95 rows are **not exactly auth/routing cases**. One is `UPDATE api_keys SET model_allowlist=CAST(X'22ff22' AS TEXT)` -> authenticated `GET /api/client/summary`: frozen **200** summary with `modelAllowlist:"�"`, Rust **500** `{"error":{"code":"INTERNAL","message":"internal error"}}`. Login and client quota/history/usage/logs all succeed for this cell. Rust `api.rs:386-390` uses `row.get::<_,Option<String>>` in the **post-auth display projection**, rejecting invalid UTF-8; unchanged session auth uses replacement decoding. This is not a typed auth/routing refusal, so `routing-strict` wrongly masks it. Frozen keys.ts:78 uses Bun TEXT replacement then JSON.parse, returning the replacement string. Corpus predicate line 173 classifies any client endpoint difference on api_keys as auth/routing regardless of cause. Exact request/SQL/body in `accepted-row-audit.json` (entry matching invalidutf + summary), full frozen summary preserved there. Narrow classification and either match the display reader or obtain a separate explicit exception; do not loosen auth readers.

## Evidence / constraints

**Range attribution:** the strict quota id/type reads, BLOB numeric fallback/concatenation logic, PATCH f64 binding, POST re-read, and client-summary `Option<String>` read already exist at `487feadd` (verified with `git show`). These are **pre-existing parity gaps left uncovered/unfixed by X3's claimed all-operator-cell scope**, not five claims of newly introduced regressions. X3 changes health cell projection and broadens operator rows while its newly committed corpus omits or misclassifies the remaining cases. If controller narrows acceptance to *no regressions within exactly committed cases*, it must explicitly defer these gaps and correct the classification claim; current requested option-A scope has no such exemptions for HTTP.

Checkout initially clean at `8d0c9c131a6d0e4c379adfca6d5700aab415b081`. `unchanged.diff` contains the requested store/core/admin-routes comparison. No product edits or subagents. Evidence scripts and artifacts stay here. Initial recursive `touch` shell glob failed (globstar disabled); corrected with `find crates -name '*.rs' -exec touch {} +` before build.

Both findings reproduce **without recreating the table**: shipped migration schema accepts BLOB `credential_id` and BLOB `observed_at`. `shipped-health.log` and `operator-g4myy21k/results.json`: **3/3 differences**, exact raw bodies retained. Thus these are not limited to hand-altered schema semantics. Suggested correction: retain raw id/type for output, and use explicit SQLite/Uint8Array scalar coercion only for numeric operations; add quota_windows stored-cell coverage to committed corpus.

## Boundary proof

Requested `git diff 487feadd..8d0c9c13 -- crates/omni-store crates/omni-gateway-core conformance/e2e/admin-routes.ts` is empty (`unchanged.diff`, 0 bytes). Snapshot reads remain `omni-store/src/lib.rs:140-150`: `keys::list_entries`, `credentials::list_routing`, `models::list`, quota/settings typed readers. `keys::list_entries` and `find_api_key_entry` flow through `read_key_entry` -> `read_key(false)`. Snapshot misses call `GatewaySnapshotHolder::lookup_miss_after_read` -> store `find_api_key_entry` (`snapshot.rs:469`). Server `authenticate` (`server.rs:693-735`) uses held snapshot + miss resolver exclusively; `/v1/models` successful responses use snapshot routing models/credentials and `models::list_body`, never control models. Core/store have no dependency back into control. Thus no **authentication/dispatch/snapshot** path reaches the new operator readers. Literal “no request path” would be false: operator requests and the explicitly authorized client quota metadata step necessarily reach them.

Operator routes (`admin_routes.rs`): keys list/edit -> `api::key_rows` -> `keys::operator_rows`; credentials list/patch/health -> `credentials::rows`; models list -> `models::list` -> coercing `cli_list`; model PUT -> `models::put` -> credential `rows`; catalog -> `api::accounts` -> credential `rows`; GET settings -> `smart_router_models` -> `accounts` and model `list`. PUT settings uses existing `settings_value::read`/merge/write, not snapshot readers. Client quota and quota history use `validate_client_metadata` (`client_quota.rs:213,481`), with coercing JSON per row, **after** unchanged client authentication. Key DELETE and model/credential DELETE only update/delete and need no new coercing pre-read, matching frozen. Full symbol references in `reachability.txt` and `calls.txt`.

Client login explicitly uses `admin_auth.rs:486` -> `omni_store::keys::find_by_hash`. Subsequent session checks call existing `admin_password::client_key_usable` (control crate, but **not** the new projection): selected raw expiry/revocation + strict JSON/config usability, unchanged by this range. This pre-existing control dependency is not evidence of a new boundary leak.

## Projection / write-back audit

`Cell::read` -> `database::bun_cell` replaces invalid UTF-8 with U+FFFD and keeps numeric TEXT as strings. `Cell::json` preserves null/numbers/strings and converts BLOB bytes into ordered numeric-index objects; JSON writer handles nonfinite numbers as null and -0 as 0. `cli_cell::string` uses JS scalar ToString (BLOB decimal bytes joined with commas), then JS parser for JSON columns. Operator key/model flags and credential enabled use numeric `===1`, refresh-token flag uses non-null. Frozen references: keys.ts:73-90; credentials.ts:152-168; config.ts:65-91. Key summary replaces fields in-place, preserving insertion order. Credentials field iteration and model field order match frozen. Committed corpus masks JSON object-property order, so equal counts alone do not prove byte-for-byte order. Independently checked own extended GET **raw bytes**, with no JSON order mask: keys 158/158; credentials 209/209; health 209/209; catalog 209/209; settings 262/262; client quota 209/209; models 53/53 (`raw-order-counts.json`).

Credential PATCH (`credentials.rs:406-477`, frozen control credentials.ts:308-332/store credentials.ts:258-278) writes only requested fields plus updated time, not projected unrelated cells. Model PUT replaces four model cells with validated body, like frozen config.ts:79-87; stored INTEGER targets cause matching read/validation failures rather than successful writes. Key edits likewise write only their selected field. Typed-state mutation probes establish the tier/weight binding mismatch above; BLOB label stays BLOB when PATCH only changes weight, as frozen does.

## /v1/models 500 predicate

**Not literally the set of all frozen 500 messages.** Frozen proxy.ts:1019-1048 also calls `snapshot.get`, `allowlist.includes`, and model display/limit construction inside its catch. The accepted corpus itself has frozen `s.modelAllowlist?.includes is not a function...` (INTEGER/REAL/BLOB-number allowlists), and BLOB allowlist gives frozen `JSON Parse error: Unable to parse JSON string` vs Rust generic internal error because strict Rust refuses its class before parsing. Those remain documented routing-strict outcomes, not newly preserved diagnostics. Likewise snapshot JSON errors account for the separate accepted frozen-error/Rust-success class. The predicate is defensible as **Rust-emittable frozen-equal auth diagnostics**, not an enumeration of frozen's entire exception universe.

The returned `Result` can fail only during authentication (body generation is infallible `String`). `snapshot::judge` emits Internal for unreadable `KeyEntry.message` or exact `api key configuration is unusable`; header conflicts/unknown/expired keys are auth errors, miss store failures become unknown-key refusal. `KeyRowError.message` originates solely in `read_key_entry`: `allowlist_parse_error` -> JS parser message, else `StoreError::to_string`. Parser failures have `JSON Parse error: ` prefix; typed reader errors have fixed Rust/table prefixes and cannot start with it. No internal upstream request/error is forwarded here. Thus the prefix cannot be spoofed by a stored string into an arbitrary Rust error under the inspected call graph. Frozen API-key diagnostic at apiKey.ts:69 is exact; frozen JSON.parse throws carry parser prefix. This does not claim a universal set of all possible frozen runtime exceptions (e.g. DB infrastructure failures); generic fallback remains appropriate for those.

## Build identity

Own separate `cargo build --offline -p omni-cli`: exit 0, copied `omni-8d0c9c13`, SHA256 `c34130f80f10589670c389c45f4b6a657e7fb427e0ec9b5ba6eab1f8d7e2d1a4`. Own gateway SHA256 `e6c93b893e00ed1dc6ae35e61a6aa74004e6a62c00d2dde5ce7bb8918b9ec531`. Frozen binary SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. Source builds are at requested HEAD; hash is not the implementer's copied binary (different build feature/artifact context).

## Gates

Quoted command/exit lines from files:

* `workspace.exit`: `cargo test --offline --workspace ; exit=0` — **1,314 passed**, first attempt, no rerun. Includes `dispatch_state_machine_size ... ok` from dispatch_size.rs.
* `dispatch_size.exit`: `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture ; exit=0` — concrete state machine **3,400 bytes** (ceiling 5,500).
* `clippy.exit`: `cargo clippy --offline --workspace --all-targets -- -D warnings ; exit=0`.
* `fmt.exit`: `cargo fmt --all -- --check ; exit=0`.
* `x3.exit`: `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3-review/gateway-8d0c9c13 python3 conformance/e2e/x3-operator.py ; exit=0` — **2,995 / 2,885 / 95 + 15 / 0 unexpected**, but one accepted label is incorrect as above.
* `run.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/run-home OMNI_ENCRYPTION_KEY=review-synthetic-encryption-key-32-chars unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/x3-review/gateway-8d0c9c13' ; exit=0` — all rows equal.
* `cli-stored-cells.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/cli-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/omni-8d0c9c13 python3 conformance/cli/stored-cells.py ; exit=0` — **1,045 equal / 0 different**.

No admin-routes invocation (reserved for controller).

## Own probes

Health-extra: **182 pairs / 160 equal / 22 differences**, detailed above, every column in seeded credential_health and quota_windows across 13 classes, raw bodies identical in all 160 equal cases. Quick minimal repro adds **2 pairs / 2 differences** (duplicates of health-extra finding).

Mutations: `operator-kxj52mbq`, **442 non-creation pairs / 442 equal / 0 differences** including key edit subroutes and malformed settings PUT/read. Further 32 POST pairs: after narrow generated-id/ciphertext/clock masks, **32 differences** (tokenVersion above), no additional differences.

Extended: `operator-_feqp0x3`, **1,543 pairs / 1,361 equal / 182 different**, all differences solely weight INTEGER/REAL write-back. Every scalar metadata column across 13 classes; multirow JSON columns across 14 classes. Separate multirow scalar list suite `operator-egf24vms`: **91/91 equal**, one BLOB row among healthy rows for key, credential, model lists plus catalog/settings/client quota.

Full counts by cell class for **every suite**: `probe-counts.md` (machine-readable `probe-summary.json`). Own probes **2,409 pairs / 2,166 equal / 243 different**, including minimal duplicate repros. All 243 differences map to four own-probe findings: 20 strict quota identifier/type reads + 2 BLOB arithmetic + 182 weight write-back + 32 POST tokenVersion + 7 duplicate minimal/shipped-schema/tier repros. The fifth finding comes from auditing the committed corpus's accepted rows. No accepted routing-strict/frozen-JSON rows are used to excuse own probe failures. Extra settings/key suite **35/35 equal** includes 7 successful key limits writes; incomplete settings bodies correctly produce matching 400s. Separate **full valid settings** supplement (`operator-jj4a_ufw`) **35/35 equal**, 14 successful settings PUTs + corresponding GETs over all JSON classes and nonfinite/negative-zero cells, plus 7 successful key limits writes. Mixed provider_data rows **42/42 equal** (`operator-7cbi5jk0`): healthy + malformed metadata credentials, **both with actual quota windows and samples**, all 14 JSON classes, quota/history/credential-health routes. Thus quota metadata success is not just an empty-window artifact.

## CLI corpora — all six complete

First sequential batch hit the harness's explicit **1200-second timeout** during wide, after first three suites passed; no final wide result produced. `cli-batch-timeout.exit` records the notified **143 (SIGTERM)**. No CLI corpus failure was asserted from that interruption. Restarted wide, extra, quota-json sequentially with a **3600-second** tool allowance, fresh fixtures, same independently built copied CLI: all three finished successfully. Original interrupted log retained; rerun logs use `-rerun.log`. This is a harness timeout, not a workspace test flake.

* stored-cells: **1,045 pairs, 0 failing**.
* neighbors: **3,806 pairs, 0 failing**, explicit existing exclusions `random-create:2`, `unimplemented-credentials:4` retained.
* neighbors-targeted: **8 pairs, 0 failing**.
* wide: **4,236 pairs, 0 failing**, evidence `/tmp/opencode/cli-fix5/wide-pm8dvnoy`.
* extra: **180 pairs, 0 failing**, evidence `/tmp/opencode/cli-fix5/extra-djh4kpr9`.
* quota-json: **196 pairs, 0 failing**, classes `equal:151`, accepted `human-quota:45`; evidence `/tmp/opencode/cli-fix6/r6-quota-hvlw0sye`.
* Total six CLI corpora: **9,471 pairs, 0 failing** (existing documented exclusions/classes retained).
* `cli-neighbors.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/cli-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/omni-8d0c9c13 python3 conformance/cli/neighbors.py ; exit=0`.
* `cli-neighbors-targeted.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/cli-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/omni-8d0c9c13 python3 conformance/cli/neighbors-targeted.py ; exit=0`.
* `cli-wide.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/cli-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/omni-8d0c9c13 python3 conformance/cli/wide.py ; exit=0`.
* `cli-extra.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/cli-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/omni-8d0c9c13 python3 conformance/cli/extra.py ; exit=0`.
* `cli-quota-json.exit`: `env -i PATH=... HOME=/tmp/opencode/x3-review/cli-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3-review/omni-8d0c9c13 python3 conformance/cli/quota-json.py ; exit=0`.

## Verification limits / documented differences

Every accepted row checked in `audit-accepted.py` / `accepted-row-audit.json`: 65 client auth-denied rows (13 cases × 5 routes), 16 `/v1/models` key auth/typed-reader differences, 13 `/v1/models` strict-skipped virtual model rows (200 vs 200 with model missing), **1 client display-reader mismatch incorrectly classified**. No `/api/keys`, `/api/models`, credential, catalog, settings operator route can enter this class with the current predicate, but a genuine non-auth **client** difference does. Status distribution: 65 frozen 200/Rust 401; 12 frozen 200/Rust 500 on models; 4 500/500 on models; 13 models 200/200; 1 summary 200/500. Separate 15 frozen-error/Rust-success rows: virtual model targets 9, credential provider_data 5, allowlist 1; these remain accepted per controller ruling. Despite its `frozen-json` name, this class also includes valid-JSON wrong shapes: `.includes` not a function, null endpoint/targets access, and object/number not iterable; inspected all 15 bodies, not just status counts. This is within the explicit 15-row ruling, not evidence the parser prefix covers all frozen errors.

Not an approval. Controller's 95 routing-strict and 15 frozen JSON snapshot differences remain accepted as directed, not extended to any operator route. Admin-routes **20,602 / 27 / 0 not rerun** (explicit instruction); use controller's isolated run for that claim. No PostgreSQL/live provider validation. Not an exhaustive Cartesian product of every possible SQLite byte sequence, mixed-row position, route body, and database schema. Credential POST creation comparisons mask only UUID/ciphertext/clocks as documented; other probes retain typed cells and exact statuses, but generic corpus JSON-object order masking remains in force. Individual new projection field orders were statically checked; all 160 equal health-extra responses are also byte-equal. No open-ended object-valued ToPrimitive implementation attempted or authorized.

Frozen reference source paths audited are unchanged from `1780bb39` (`frozen-source.diff`, 0 bytes), so cited frozen line locations are valid in this checkout. Store models source is named `packages/store/src/sqlite/config.ts`, not models.ts.

## Restoration proof

No checkout content edits or commits were made; only source mtimes touched for build. `checkout-head.txt`: `8d0c9c131a6d0e4c379adfca6d5700aab415b081`. `checkout-status.txt` and `checkout.diff`: both 0 bytes. `checkout.exit`: `git diff --exit-code HEAD ; exit=0`. Native git status includes untracked files: clean. All reviewer scripts/captures live outside checkout in this evidence directory; original `/tmp/opencode/x3` and `/tmp/opencode/x3-probe` evidence never edited. Committed corpus creates its own new evidence directory under x3 by design.
