# Narrow re-review, round 6 — eabedf83

**Verdict: REQUEST CHANGES — new Important R6, BLOB quota identity join.** Original I3's 21 projection cases are fixed, but the JSON-only lossless projection exposes structural equality in credential matching. User explicitly accepted I1, I2 and M1 as narrowly documented malformed/hand-altered-store differences; they are not silently fixed or generalized here. Evidence: `/tmp/opencode/cli-fix6-review/`. No product edits, commits, or subagents.

## Important R6 — status JSON attaches quota to separately read BLOB identities

Hand-altered affinity-free credentials/quota tables, usual credential row q/openai/quota/oauth and quota row q/fiveHour/0/1/10/NULL/0/NULL. Apply:

```sql
UPDATE credentials SET id=X'71';
UPDATE quota_windows SET credential_id=X'71';
```

Command on both: `--root <scratch>/root status --json`. Both exit **0**, stderr empty. Frozen credential `id` is `{"0":113}` and **quota is []**. Rust same credential id but **quota contains the full row**: `{"credentialId":{"0":113},"windowType":"fiveHour","startsAt":0,"used":1,"limit":10,"resetsAt":null,"observedAt":0,"windowMs":null}`. Exact full streams retained in `quota-e8gjz67r/identity.json`; same mismatch for X'' and X'0102'. Other injected INTEGER/REAL/NULL/TEXT identities agree (4 equal / 3 different of 7).

Frozen `packages/control/src/credentials.ts:282–296` groups quotas in a Map keyed by raw credentialId, then looks up raw credential id (SameValueZero; objects by identity). Separate Bun SQLite BLOB reads produce distinct Uint8Array objects, not equal by identity. CLI `apps/cli/src/commands/status.ts:80` calls this function. Rust `crates/omni-cli/src/status.rs:118` compares JsValue structural equality. New `status_quota_json` now creates the same indexed-object representation as credential cli_rows, so equal contents join incorrectly. Retain JS Map scalar/object-identity semantics at this filter; do not loosen typed readers or special-case only byte 113. This is **status JSON**, neither accepted human quota/burn nor models-put credential resolution, nor accepted setup/models-show target objects. It is not covered by any of the five documented differences.

**Before/after proof:** separate three-executable run (`quota-po8999_6/identity-regression.json`) confirms own 54d73636 binary matches frozen **7/7**, whereas own eabedf83 binary matches **4/7** and differs on the three BLOB identities. Thus R6 is a measured regression introduced by this range, not just an inherited issue. Driver capture exit0 is not claimed as parity; `identity-regression-assert.json` records exact assertions. Repeated seven-case run is additional reproduction, not seven new case identities.

## I3 CLOSED (21/21 focused cases) and human boundary

Independent touched-source `cargo build --offline -p omni-cli` (alone, own worktree target, requested jobs/debug/incremental environment) produced SHA256 **4d0fa59e3012269d1bfb887a6169b5346692538621120caae2826f93fe9e4375** at **eabedf83072aae7df816da5c2908ec998f86ba33**; copied binary before workspace feature-unifying builds. Initial disk 18 GiB, above 5 GiB cutoff.

Product diff has only two files: `status.rs:105–110` chooses lossless quota projection iff JSON flag; `credentials.rs:345–383` factors existing query/field order into `status_quota_with`. False branch still invokes `sql_value(raw)`, while true invokes `cli_cell::Cell::read(raw).json()`. `sql_value` exact source is byte-identical to 54d73636 (`sql-value-identical.json`); health/typed consumers are untouched. `status_quota_json` has only one in-tree caller, CLI status's JSON branch; HTTP/routing/snapshot/Postgres gain no call path. Typed boundary and frozen apps/packages/bun.lock diffs empty, `.exit` files both 0. Earlier read_key/operator_rows byte-identical restoration remains untouched by this range.

Own old/new human run against my round-5 copied binary (SHA256 verified `3d6a2656…`) and my new binary: **91/91 identical stdout/stderr/exit and typed DB state**, all seven columns × thirteen values. `focused.exit=0`, evidence `quota-4an749hz/human.json`. No normalizations. This independently verifies human stability for the entire new corpus, not arbitrary time-boundary invocations or the unbounded SQLite domain.

My exact 21 earlier JSON BLOB cases were rerun separately: empty, two-byte X'0102', and non-UTF8 X'ff' in each of window_type/starts_at/used/limit_value/resets_at/observed_at/window_ms. **21/21 match frozen bytes/exit and typed state**, `i3-21.exit=0`; evidence `quota-rg25zxf9/i3.json`. Frozen raw-cell projection remains `packages/store/src/sqlite/credentials.ts:361–372`; new JSON projection preserves indexed objects instead of UTF8 strings. No I3 waiver needed.

## Corpus acceptance-class audit and bite

`quota-json.py` asserts human equality exactly iff `(column,value)` is **not** in a literal identity set: all 13 explicit values for window_type/starts_at/used (39), plus six explicit limit_value values (6). Thus exactly **45** accepted human identities, not “any human failure”; remaining 46 human rows must equal. JSON mode has no exemption. Every DB snapshot must equal pre-invocation state, and both sides' stderr are decoded for panic checks.

Scratch-copy bite restricted to **window_ms=NULL**, a previously equal/nonaccepted human row, and appended hex `00` to only Rust captured stdout before comparison. The real assertion rejected it at the exact identity check (`bite.exit=1`, expected; `bite.log`). This is deliberate harness mutation, not a product regression. No corpus/product file or earlier evidence changed. Caveat: accepted identities pin where mismatches are allowed, **not the exact differing bytes** within an already accepted identity; the separate 91-case old/new comparison detects changed bytes in those rows in this review.

Six corpus scratch copies change evidence prefixes only; targeted reads scratch neighbors.py. Exact diff in `prefix-only.diff`; originals keep hardcoded implementer evidence roots, which are read-only. Every Bun invocation uses `--no-env-file`; CLI children have explicit scratch HOME/root, no real config.

## Final five documented differences (user-authorized scope)

1. **Human `status` quota/burn over malformed quota_windows cells:** coercion, percentages, ages/window labels/burn arithmetic may differ. Not status JSON, credential provider/label formatting, normal quota data, or HTTP/routing behavior. Example used INTEGER1 / limit TEXT'10': frozen percentage vs Rust unknown; JSON must still match.
2. **`models put` pinned/custom credential resolution with non-string stored id/provider/label/authType:** malformed credential identity/auth comparisons and resulting validation/errors may differ. Not blanket credential tolerance; excludes ordinary string credential fields, provider_data parse, other model commands, setup and gateway typed readers.
3. **I1 setup over malformed stored target JSON objects:** object-valued provider/limit fields may have conversion/error behavior different from frozen property-key/Math.min consumers, including swallowed ToString errors and Number-only limit narrowing. Limited to stored malformed target objects, not validated ordinary setup/config inputs or all setup failures. Prior nonterminal `{"toString":5}` reproductions identify the covered failure; interactive generated limits remain unverified. These malformed JSON payloads can also be injected in stock TEXT columns without changing schema; “hand-altered tables only” must not be mistaken for a schema-affinity precondition.
4. **I2 human `models show` with object-valued target model/credentialId fields:** eager Rust string conversion can change error precedence relative to frozen earlier cost-property errors or eventual table `text.replace` errors. Not JSON output, model list/rm/put, or arbitrary normal model-show errors.
5. **M1 inherited long-radix ToNumber rounding on malformed stored scalar inputs:** digit-by-digit f64 accumulation can differ from Bun's once-rounded large hexadecimal arithmetic (97/1,000 prior probes); no demonstrated current-epoch expiry-state mismatch. Not a general numeric-coercion/expiry waiver: prior 51 broad scalar and 1,500 safe-integer radix boundary inputs matched. No gateway/shared coercion change authorized.

Items 3–5 are accepted only for the hand-altered/malformed stored-cell scenarios ruled on by the user; no authorization to relax validated input or normal-storage behavior. Their documented scope does not include I3's JSON BLOB projection, which must be fixed.

## Inherited behavior and verification limits

Retain frozen exact bytes/error precedence outside the exceptions; direct table non-strings throw, flags use ===1, guardrail only NULL means absent, numeric TEXT date display is em dash while expiry relational checks coerce, BLOB is Uint8Array (comma-byte ToString, indexed JSON), nonfinite JSON serializes null but survives until interpolation/comparison, invalid key limits fail closed. R1–R5 prior closures and comparator bite remain applicable; this range does not change them.

Six existing neighbors exclusions remain **two random-create and four unimplemented credential mutations**, not newly accepted differences or equivalence passes. Stored-cells checks streams/exit only; targeted additionally unchanged-state flag; other three old corpora and new quota use typed snapshots. No independent rerun of controller's 53-driver matrix, exhaustive interactive config generation, arbitrary nested JSON/all cell domains, full malformed pinned/custom combinations, or intermediate historical builds. Prior interrupted round-5 wide stderr gap remains historical and is not erased; this re-review's complete-run scan will be recorded separately.

All requested runs have now completed; final measurements and provenance caveat follow below. No approval asserted.

## R6 complete streams, representative X'71' reproduction

All three exit0, all stderr empty; literal equal fixture paths retained.

ts:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix6-review/quota-po8999_6/home/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": {
        "0": 113
      },
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": []
    }
  ],
  "storeError": null
}
```

old:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix6-review/quota-po8999_6/home/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": {
        "0": 113
      },
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": []
    }
  ],
  "storeError": null
}
```

rust:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix6-review/quota-po8999_6/home/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": {
        "0": 113
      },
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": [
        {
          "credentialId": {
            "0": 113
          },
          "windowType": "fiveHour",
          "startsAt": 0,
          "used": 1,
          "limit": 10,
          "resetsAt": null,
          "observedAt": 0,
          "windowMs": null
        }
      ]
    }
  ],
  "storeError": null
}
```

Independent red corpus rerun with my prior 54d73636 binary: **182 pairs = 116 equal / 45 accepted human / 21 JSON failures**, red.exit1. It reproduces the claimed red state, not a new current-binary failure. Exact focused 21 cases green; full new corpus green result pending.

R6 explicit parity gate `identity-parity.py` asserts old/frozen equality first, then fails on exactly `[X'', X'71', X'0102']` for new/frozen: `identity-parity.exit=1`. Capture script exit0 is not passed off as a green parity check. This gate consumes immutable captured records; actual fresh paired invocations are in the two identity scripts/logs.

## Own Cargo gates completed

```text
cargo build --offline -p omni-cli exit=0
cargo test --offline --workspace exit=0
cargo clippy --offline --workspace --all-targets -- -D warnings exit=0
cargo fmt --all -- --check exit=0
git diff --exit-code [typed boundary paths] 21348e06..HEAD exit=0
git diff --exit-code 1780bb39 -- apps packages bun.lock exit=0
```

Workspace result-line sums: **1,265 passed / 0 failed / 19 ignored**. No retries or flaky failures; requested environment and sequential Cargo commands, own target, source touch before build. Final six-corpus sequence still in progress; no corpus completion claimed from Cargo success.


## FINAL results for copied eabedf83 binary

**REQUEST CHANGES at eabedf83: Important R6 BLOB quota identity join (3 case identities).** Original I3 closed, prior R1–R5 closed; previous I1/I2/M1 accepted only within the five documented differences above. No new Critical or Minor finding in this narrow round.

| Own corpus | Pairs | Unexpected failures | Accepted/excluded | Exit |
|---|---:|---:|---|---:|
| quota-json (round-6 snapshot) | 182 | 0 | 45 accepted human differences | 0 |
| stored-cells | 1,045 | 0 | none | 0 |
| neighbors | 3,806 | 0 | 6 inherited exclusions | 0 |
| neighbors-targeted | 8 | 0 | none | 0 |
| wide | 4,236 | 0 | none | 0 |
| extra | 180 | 0 | none | 0 |
| **Total** | **9,457** | **0** | **45 accepted + 6 excluded** | |

**9,406 exact nonexcluded passes**. Quota corpus: 137 equal / 45 accepted human / 0 JSON failures; all 91 JSON pairs match. Original 21 BLOB rows independently also pass 21/21. Old/new human 91/91 identical. Separate identity probes are not in these six corpus counts: seven unique identities yield 4 equal / 3 failing on eabedf83, reproduced in two fresh runs; old binary equals frozen 7/7 in the three-executable rerun. `identity-parity.exit=1` asserts the regression. Acceptance-set scratch mutation correctly exits1.

Verbatim `.exit` evidence:

```text
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=/tmp/opencode/cli-fix6-review/omni python3 /tmp/opencode/cli-fix6-review/drivers/quota-json.py exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=/tmp/opencode/cli-fix6-review/omni python3 /tmp/opencode/cli-fix6-review/drivers/stored-cells.py exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=/tmp/opencode/cli-fix6-review/omni python3 /tmp/opencode/cli-fix6-review/drivers/neighbors.py exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=/tmp/opencode/cli-fix6-review/omni python3 /tmp/opencode/cli-fix6-review/drivers/neighbors-targeted.py exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=/tmp/opencode/cli-fix6-review/omni python3 /tmp/opencode/cli-fix6-review/drivers/wide.py exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=/tmp/opencode/cli-fix6-review/omni python3 /tmp/opencode/cli-fix6-review/drivers/extra.py exit=0
env -i [isolated] python3 /tmp/opencode/cli-fix6-review/focused.py exit=0
env -i [isolated] python3 /tmp/opencode/cli-fix6-review/i3-21.py exit=0
env -i [isolated] python3 /tmp/opencode/cli-fix6-review/bite.py exit=1
env -i [isolated] python3 review/red.py [own prior binary 54d73636] exit=1
python3 review/identity-parity.py exit=1 (3 observed new parity failures)
```

### Final panic scan

**19,537 decoded records; 0 panic markers or exit101/134/−6.** Breakdown: six green corpora 18,914 child records, separate red quota 364, human before/after 182, separate original 21 cases 42, identity first run14, identity old/new/frozen rerun21. Total 19,537. Decode both stderr hex and inspect panic exit codes; per-file counts in `panic-scan.json`. Scratch bite aborts at intended assertion before final JSON but both CLI results already passed inline no_panic. No interrupted long command in this round; no lost completed corpus captures.

### Scope/provenance warning: worktree advanced externally

At final check HEAD had advanced externally to **f1704d6608bbf52695115926a90eaf1f8dd2c045**, via `28567236` new identity corpus, `4c670bbe` Map-key fix, `f1704d66` green record. **I did not make these edits and have not reviewed those commits here.** This review's verdict is expressly for requested **eabedf83**, not the newer HEAD. Copied binary remains SHA256 **4d0fa59e3012269d1bfb887a6169b5346692538621120caae2826f93fe9e4375**; all probes use that copy. Corpus drivers were copied at eabedf83 before advancement; they retain original 182 quota pairs, not successor's expanded corpus. Earlier boundary/frozen checks and sql_value/function extraction were made during this review. Cargo gates ran in the shared worktree and all exited0, but exact timing of external source advancement relative to compilation is not independently established: **do not use those Cargo results as stronger immutable-commit provenance than the copied CLI binary**. No claim that new HEAD passes/fails this review, and no automatic approval of the follow-up repair. Final disk 17 GiB, above cutoff. No evidence deleted, product edits, commits, or subagents by reviewer; only preexisting tracked dirty report remains.

The five documented differences, inherited behaviors and unverified items above are the complete scope basis, not a blanket malformed-cell waiver. R6 is outside every exception and therefore blocks approval of eabedf83 across all rounds despite six green original corpora.


# R6-only follow-up — f1704d66 (final)

**Verdict: REQUEST CHANGES pending disposition of the human identity mismatch below. R6's JSON regression is CLOSED.** No inference that the five user-accepted differences have expanded. This section supersedes the eabedf83 R6 finding for the JSON path, not the earlier historical evidence. No product edits/commits/subagents.

## Reviewer build and results

Touched all crates/**/*.rs, own rust-cli target, `cargo build --offline -p omni-cli` alone, CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0. Copied reviewer binary SHA256 **f3d6d14981e94bfe93af09aee03585eb6dc941e8dee3e9fadf3cba30fe4671fa**; build exit0, HEAD f1704d66. Disk initially 17 GiB (>5 GiB cutoff). All CLI children isolated HOME/root, Bun --no-env-file, evidence `/tmp/opencode/cli-fix6-review/r6/`; original implementer evidence read-only.

| Own verification | Count/result |
|---|---|
| Original seven identity cases, JSON + human | **14/14 equal** |
| Additional 12 edge identities, JSON + human | **23/24 equal**, one human mismatch below |
| All identity JSON rows | **19/19 equal** |
| Previous I3 BLOB projections | **21/21 equal** |
| quota-json corpus | **196: 151 equal / 45 accepted human / 0 unexpected** |
| extra corpus | **180/180 equal**, typed DB state equal |
| Old 54d73636 vs new human, original 91 fixtures | **91/91 identical bytes/exit/typed DB state** |
| Panic scan | **1,056 decoded child records, 0 markers/101/134/−6** |

Counts are separate sets, not deduplicated. Panic record count = 392 quota + 360 extra + 76 identities + 42 I3 + 182 human stability + 4 direct human-mismatch reproduction children. The identity assertion exits1 intentionally because its one human mismatch is NOT masked. Corpus scratch copies only redirect evidence roots. Implementer six-corpus/gate `.exit` files independently read: 23 exit0, one intended red exit1; test log sums **1,265 passed / 0 failed / 19 ignored**. I did not rerun full workspace/clippy/fmt in this R6-only follow-up; previous round's own gates and these implementer files are distinguished from my fresh build/two corpora. Own typed boundary diff exit0. No new HTTP/typed-reader code in this range.

## Exact Map semantics

Frozen `packages/control/src/credentials.ts:282–296` uses the **same Map for both human and JSON status**, not a human-only structural comparison. `status.rs` now implements reachable SameValueZero correctly for JSON: Null/Null; numeric `==` (therefore +0/−0 and INTEGER1/REAL1 equal); both NaN; UTF16 string equality; other kinds never match. Only SQLite classes reach this path, so Bool/Undefined handling is irrelevant. Distinct BLOB reads are distinct JS objects even if their bytes agree and must never join, including empty BLOBs.

Fresh end-to-end cases: ±0 in both directions equal; INTEGER1/REAL1 in both directions equal; TEXT'1'/Number1 in both directions unequal (quota empty); NULL/NULL matches and attaches quota; ±Infinity same-sign match; BLOB/BLOB never matches in JSON; mixed BLOB/TEXT and BLOB/NULL never match in JSON. NaN cannot persist as SQLite REAL here: both Python binding and direct **Bun SQLite** binding verified typeof=NULL. Bun Map probe (`map.ts`, map.exit0) separately confirms ±0, NaN, Number1, TEXT/Number inequality, BLOB identity inequality, NULL match. Rust f64 == agrees for signed zero; explicit NaN branch is defensive and correct but unreachable from normal SQLite stored cells. This closes original R6 without broadening typed readers.

## Important H1 — human mixed TEXT/BLOB quota identity divergence (inherited; ruling needed)

The human branch retains structural comparison **after** `sql_value` converts quota BLOB to UTF8 TEXT. Thus BLOB/BLOB identities do not match on that path (credential id remains an indexed object, quota id becomes string); the seven new corpus identities all pass human comparison. This does **not** make the general human join Map-equivalent.

Minimal fixture: ordinary credential id TEXT 'q', provider openai, label quota, auth oauth; affinity-free quota table row ('q','fiveHour',0,1,10,NULL,0,NULL). Exact SQL:

```sql
UPDATE quota_windows SET credential_id=X'71';
```

Command both sides `--root <scratch>/root status` (no JSON). Both exit0, stderr empty, typed DB unchanged. Frozen quota cell **unknown**; Rust **5h 10% (20773d ago)**. `status --json` for this mixed identity agrees (quota empty), confirming JSON R6 is fixed. Full original identity streams in `quota-6i_8w5f2/identity.json`. Independent direct reproduction `quota-dlxkbt1b/human-mixed.json` runs frozen, reviewer f1704d66, reviewer 54d73636 and reviewer eabedf83: **all three Rust binaries print the same incorrect attached-quota human cell**, so this is inherited, not a new f1704d66 regression.

Frozen Map does not associate a TEXT credential id with an independently read Uint8Array key. Rust human projection turns X'71' into "q", and `crates/omni-cli/src/status.rs:132–133` (else structural-equality branch) then associates it. Source consumer is frozen credentials.ts:282–296, upstream status.ts:80; shared `sql_value` credentials.rs:24–30 intentionally remains unchanged. No typed/health loosening proposed.

**Class audit:** the 45 pinned accepted human identities are seven-column fixture mutations (window_type/starts_at/used and selected limit_value values). They contain **no credential_id case**. The seven added identity cases are explicitly `human_difference=False`. This mixed TEXT/BLOB case is not among those seven, not in the pinned accepted set, and would fail its current equality requirement if added without a new classification. It may be considered within the user's broader human quota waiver, but **I do not rule on that or expand the waiver**. Report H1 for explicit disposition; do not silently mask it or describe all human Map behavior as verified. REQUEST CHANGES here means unresolved scope/known mismatch, not an instruction to repair an already accepted behavior against the user's wishes.

## Final five documented differences (unchanged; no sixth inferred)

1. Human status quota/burn over malformed quota_windows cells: accepted coercion/percentage/age/window-label/burn arithmetic, **not JSON** or normal quota/credential table behavior. H1's association/identity mismatch is newly reported for classification, not automatically included.
2. models put pinned/custom credential resolution for non-string stored id/provider/label/authType: not provider_data parse, string-field ordinary behavior, setup, other model commands, or gateway typed readers.
3. I1 setup malformed stored target JSON objects: provider/limit object conversion/ToString errors and Number-only narrowing; not ordinary validated setup/config inputs or all setup errors. These malformed payloads can exist in stock TEXT columns, despite the hand-altered-data scope wording.
4. I2 human models show object-valued target model/credentialId error precedence: not JSON, other model commands, or normal show errors.
5. M1 inherited long-radix ToNumber rounding on malformed stored scalar inputs: large-radix arithmetic precision only; no demonstrated current-epoch expiry mismatch, no general numeric-coercion waiver or shared gateway change.

Inherited frozen behaviors remain: exact stream/exit contract outside exceptions, direct table non-strings throw, flags ===1, guardrail only Null means absent, finite-number-only date rendering versus expiry ToNumber, Uint8Array byte-string/indexed JSON, nonfinite JSON null only at serialization, invalid limits fail closed. Prior R1–R5 and I3 closures stand. Six preexisting neighbors exclusions (two random creates/four unsupported credential mutations) remain disclosures, not fresh parity passes.

Unverified in this narrow follow-up: arbitrary/all SQLite and nested JSON domains, exhaustive interactive generated limits, full malformed pinned/custom combinations, controller matrix, independent full five-old-corpus/workspace/clippy/fmt rerun at f1704d66. Implementer gates read, not passed off as mine. No claim of immutable domain-wide equivalence or permission to change the five accepted differences.

## Exit evidence (verbatim)

```text
cargo build --offline -p omni-cli exit=0
env -i [isolated] python3 review/r6/identity.py exit=1
env -i [isolated] python3 review/r6/i3-21.py exit=0
env -i [isolated] python3 review/r6/quota-json.py exit=0
env -i [isolated] python3 review/r6/extra.py exit=0
env -i [isolated] python3 review/r6/human91.py exit=0
env -i [isolated] python3 review/r6/human-mixed.py exit=0 (assert inherited difference exists)
env -i [isolated] bun --no-env-file review/r6/map.ts exit=0
git diff --exit-code [typed boundary] 21348e06..HEAD exit=0
```

Note human-mixed.exit0 means it asserted the known inherited mismatch exists; identity.exit1 is the unmasked parity failure. The corpus gates are genuinely green; no inference that they contain the mixed-type case.
