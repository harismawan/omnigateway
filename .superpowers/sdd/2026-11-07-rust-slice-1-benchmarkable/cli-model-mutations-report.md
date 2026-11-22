# CLI file-based model mutations

## Fix round1 — verified, base61b8575d

Complete review read. I1: grandfather pair identity now uses lossless iterative
UTF16 coercion for strings, nested arrays, numbers, booleans, null and objects;
own noncallable toString still errors. No human UTF8 formatter participates.
M1: unknown target fields choose JS numeric-property order. M2: valued -f works
after boolean flags in short clusters, including separate arguments and actual
TS cluster-specific ambiguous-argument diagnostics.

Evidence `/tmp/opencode/model-fix1/`: prior65 hashes verified before edits;
red-I1/M1/M2 logs capture each review finding before fixes. Expanded put302 focused
GREEN includes distinct surrogates/replacement rejection, unchanged surrogate
grandfather success, malformed stored array/primitive/object coercion, mixed auth
siblings, disabled resolved pins, wrong-auth repinning, cross-provider/endpoint
dangling pins, later failing target and ordered null-metadata failure. Successful
puts now retain nonempty key/history rows in the main wholeDB oracle.

Job `sh_1c59c1c39001pgBaXOhVTlOvWf` completed successfully; all280 lines of
`verification.log` inspected. Binaries remained unchanged throughout that matrix.
Launch manifest extends all control/store/provider/CLI/IR source files plus
bun.lock/Cargo.lock/package.json (including currently dirty user bun.lock as read
authority only). Existing user files untouched. Snapshot5 passes.

Clippy correction applied during the matrix: args.rs now uses `if let Some(at)`
instead of `is_some` plus `expect`; equivalent condition/binding, no behavior
change. `pre-clippy-hashes.log` verifies launch hashes before that edit and
`clippy-source-transition.log` verifies args.rs is the sole changed manifest path;
no binaries rebuilt during matrix. Strict clippy/fmt/Biome pass after correction.
After completion all4 binaries rebuilt; `final-put.log` passes302 in each of six
legs. Both launch and final1812 put pairs reloaded, checking raw bytes/status and
wholeDB transitions. All1572 retained model-read pairs also reloaded. Full matrix
passes put302/rm47/modelreads262/keys135/mutations184/settings347 each leg; focused
CLI2/control8/store65, snapshot5, frozen TS CLI8/control34 pass. Four existing
store helpers/measurements ignored. Strict clippy/fmt/Biome pass. Final285 hashes
verified after recording only args.rs and four binaries in the hash transition.

Finding map: I1 `models.rs` + `operator_json::coerce_units`, RED `red-I1.log`,
GREEN surrogate/nested-array/primitive/object cases in model-puts.ts; M1
`model_schema.rs`, RED `red-M1.log`, GREEN numeric9/2 traversal; M2 `args.rs`,
RED `red-M2.log`, GREEN attached/separate/missing/ambiguous clustered -f cases.
`red-map.json` links the exact paired raw failure artifacts. Independent review
repro files read in place without modification. No production gateway changes.
No pending jobs or blocker; controller scoped re-review next. Catalog generation,
from-catalog, dry-run and plugins retain the documented deferrals; no full
migration-readiness claim. Commit is the commit recording this fix section.

Base `8fc650f02e84529f262a8d8c9c7e1572e6953f0b`; rm committed as `d3e095e2`.

## Implemented scope

- `models put <id> -f FILE`: UTF8 replacement decoding/BOM handling, operator JSON
  parse, write-only model schema, path/body equality, custom endpoint credential
  membership, built-in catalog auth restrictions, grandfathered provider/model
  pairs and resolved-pin checks, single-statement atomic replacement.
- Schema retains UTF16 string units through trim/validation/target persistence;
  required strategy/alias/targets, provider format, safe integer bounds, prices,
  optional cache/limits/pins, capability booleans, unknown-field stripping at
  model/pricing/capability level and strict targets. Gateway projection unchanged.
- Credential metadata reader does not decrypt/project secrets; retains providerData
  through operator JSON rather than gateway serde normalization. Null/malformed
  metadata and existing model rows retain observed TS errors.
- `models rm`: get-before-confirm, missing/empty IDs, nonterminal refusal, yes
  flags, PTY acceptance/decline, human/JSON output, unrelated-row preservation.
  Store deletion is idempotent; repeated CLI removal fails initial lookup.
- Help identifies file-only put scope. File/catalog conflict and missing-source
  validation match TS. Catalog generation/from-catalog/dry-run remain deferred;
  from-catalog explicitly fails, never succeeds as a stub. Plugins remain skipped.

## Evidence and measured sources

Owned evidence `/tmp/opencode/cli-model-mutations/`. Independent TS/Rust DB roots
and raw byte/status/before-after every-table artifacts are retained under printed
`model-puts-*` and `model-removals-*` paths. Migration timestamps fixed at seeding.

- `settled-put-matrix.log`: all six entrypoints/profiles PASS272, **1632** pairs.
  Every pair independently reloaded and compared; failures preserve every table,
  successful writes preserve all non-model tables (`put-artifacts-checked.log`).
- Put coverage: valid replacements, all field types/missing/null, integer/price
  bounds, built-ins/custom/unknown providers, endpoint/pin auth checks, trimming,
  UTF16/lone surrogates, duplicate keys, JS overflow, deep20k ignored/invalid
  fields, malformed files/stored rows/credentials, BOM/invalid UTF8, ignored file
  strategy/alias flags, short/long aliases, conflicts, missing flags and IDs.
- `put-crossread.json`: actual TS reads Rust DB and Rust reads TS DB, equal bytes.
- `put-nonempty-preservation.json`: failed put retains seeded keys/history.
  `pin-short-circuit.json`: resolved pin stops before later null providerData.
  `put-utf16-endpoint.json`: lone-surrogate custom endpoint membership and model
  persistence match TS byte-for-byte. `catalog-auth-authority.json` records every
  built-in auth override; all identifiers checked against the port.
- Store test checks replacement/deletion data_version invalidation/idempotence.
  Snapshot5 tests pass with actual store put/remove and background refresh.
  Control small-stack test checks deep invalid/unknown cleanup.
- `final-removals.log`: all six legs PASS47 (**282** pairs,60 PTYs), independently
  checked; nonempty unrelated keys/credentials/settings/history seeded.
- `final-unit.log`: CLI2/control8/store65 pass, four existing ignored helpers.
  Scoped all-target strict clippy, workspace fmt, Biome and frozen source diff pass.
  Frozen TS model command8 and model pricing/pin/control34 tests pass.
- `settled-manifest.sha256`:65 source/oracle/helper/binary paths checked. Prior rm
  manifest verified before put edits; transition logs record changed paths before
  replacement manifests were generated.

## Intermediate evidence and provenance caveats

`put-red.log` captures prior binary rejecting put; subsequent logs retain numeric
diagnostic, pin endpoint resolution and malformed-row failures before correction.
The first full put job failed when expanded audit cases reached older binaries;
`put-matrix.log` is intermediate evidence, not a passing final matrix. The next
full regression job (`final-put-matrix.log`, job sh_1c57ad7e4001keIGZB2XulvneF)
overlaps the last put-only pin lookup short-circuit fix. The settled put-only six
leg matrix was rerun afterward. That fix touches no other command; full regression
results are valid for their unchanged paths, but are not claimed as a uniform
single-binary put run. No production edits after settled put matrix.

Original rm manifest check occurred after six source edits; retained mismatches
were independently checked against `git show` base contents (`base-hashes.log`).
Initial nonexistent TS test path retained; corrected command tests pass.

Full regression job completed successfully; all280 transcript lines inspected.
Each of six legs passed put272/rm47/modelreads262/keys135/keymutations184/settings347.
Totals:1632 put,282 removal,1572 model reads,810 key listings,1104 key mutations,
2082 settings comparisons. `check-final-evidence.py` verified all six run counts
and reloaded1632 settled put pairs. Final65 manifest hashes rechecked successfully.
No pending jobs or implementation blocker. No broad gateway benchmark (CLI-only).
Controller scoped review follows completion; no full CLI/migration approval claim.
