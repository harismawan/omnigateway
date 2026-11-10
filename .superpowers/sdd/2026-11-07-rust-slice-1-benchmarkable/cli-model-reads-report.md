# CLI models list/show increment

## Fix round1 — review I1/M1/M2

Base `7c7067ba5c41222f64c6a1215561dfa4b3e5858d`; complete independent review read.
Evidence: `/tmp/opencode/models-fixround1/`. Prior manifest verified **before**
edits or new manifest generation: all60 entries OK (`prior-hashes.log`).

- I1: token limits now follow data-only JSON locale-method dispatch. Numbers keep
  existing en-US formatting; arrays recursively locale-format elements, retaining
  comma positions for empty arrays/null elements. JSON cannot encode sparse holes;
  parsed arrays are dense, with null/undefined elements contributing empty text.
  Ordinary objects inherit Object.toLocaleString; own noncallable locale methods
  fail before toString, and noncallable own toString produces TS `Type error`.
  Direct calls and nested array calls retain distinct JSC error messages. Explicit
  work stack preserves deep traversal and cleanup; 20k-depth success and both
  error paths pass on a256KiB stack. Both contextWindow/maxOutputTokens covered.
- M1: model table lines use ECMAScript trailing whitespace, including FEFF and
  excluding U+0085/U+001C. Provider and capability tails covered against real TS.
- M2: targets.some/map and required/optional price.toFixed failures describe the
  actual stored noncallable method. Objects/arrays/strings/null/numbers tested;
  lone-surrogate diagnostic text uses output encoding while stored JSON remains
  exact UTF-16. No shared operator/gateway parsing changes.

`red.log` retains actual prior-binary array-limit mismatch. Expanded corpus adds
direct/nested/empty/null arrays, object method shadowing, both-field failure order,
deep successful/error cleanup, overflow/signed-zero nested numbers, whitespace and
method descriptions. Every result now retains **before** and after whole-DB rows
for historical read-only auditing. Original155 cases remain active.

Final verification COMPLETE: all3 entrypoints in both debug/release PASS models262,
keys-list135, mutations184, settings347 each. Totals1572 model pairs (24PTYs),
810 key listings,1104 key mutations,2082 settings comparisons. CLI2/control7/
store64 tests pass (four existing store helpers/measurements ignored); strict
all-target scoped clippy, workspace fmt, Biome and frozen-source diff pass.
Frozen CLI models-show4 tests also pass. Complete250-line `verification.log` read.
Reloaded all1572 retained pairs, verifying both output equality and before/after
whole-DB preservation; all60 new source/binary hashes checked after generation.
No pending jobs or blocker. Initial clippy test-module placement failure is retained
in `clippy.log`, corrected before final matrix. Final implementation commit is the
commit adding this fix section; exact provenance in `provenance.txt` in evidence.

Binary SHA256 (debug omni/gateway, release omni/gateway):
`e53fbc44497d7aa16075ac16f20112d014c8ad4d4e49159eb140e922ebd2cd6c`,
`5f85a278c6dfbf7e50817c760400331e7a13f3d079b9c51ef16d257d2c341546`,
`ccbe9497728a66fbfc151594ed6ef5d942cfb6beb679d9a209e8923354148dd2`,
`4835978cb7714e0d6e9e370a56a8cda989fa977c3de630b9ea1549ed7ee7583a`.
Controller scoped re-review follows this fix; no full migration readiness claim.

Base: `2f95f51d8f7cd8fef5e0fa2c076fd1810d0d5563`.

## Scope

- Added `models list` and `models show <id>` through the existing CLI dispatch,
  control and store layers. Command help, usage errors, JSON and human rendering
  follow frozen TS. Root help advertises only implemented commands.
- Added a separate raw operator model projection. Existing gateway target parsing,
  strategy normalization and per-row degradation remain unchanged. Model show
  reads/parses the complete ordered model list before looking up its id, as TS does.
- Operator JSON preserves unknown fields, object order, duplicate-key replacement,
  deep values, UTF-16 units and overflow numbers. Pins are public target metadata;
  neither credentials nor password rows are projected into command output.
- Human output includes first-seen distinct providers and descriptor colors,
  conditional pin column, exact binary `toFixed(2)` rounding, en-US token grouping,
  optional cache-price dashes versus zero and JS capability truthiness/key order.
  Stored malformed values retain TS errors rather than gateway normalization.

## Verification and retained evidence

`conformance/cli/model-reads.ts` runs the actual frozen TS CLI and Rust subprocesses
against separately initialized SQLite roots. It compares raw stdout/stderr bytes,
exit status and every row of every database table; before/after snapshots assert
each invocation is read-only. Migration timestamps are fixed when seeding, not
masked from results. Raw paired artifacts remain under printed
`/tmp/opencode/models-golden-*` roots. PTYs use the existing helper's fixed
24×120 terminal and xterm-256color environment.

Corpus: empty/nonempty and ordered lists; unknown strategies and non-1 aliases;
missing/empty ids; help/options; root flag/environment; public/null/absent pins;
all built-in provider tones and plugin fallback; repeated providers and distinct
lone-surrogate provider ids; pricing ties, negatives, subunit and ≥1e21 values;
zero/absent/null cache prices; limits including huge, fractional and negative
values; capability objects, arrays, strings, numeric-key ordering and truthiness;
unknown/deep/nullable/overflow/UTF-16 target data; malformed JSON and target shapes;
required-price errors; pin-check short-circuiting; schema-permitted null model id.

Evidence directory: `/tmp/opencode/cli-model-reads/`.
- `red.log`: previous release rejects `models list` (exit2), actual TS succeeds.
- `edges-red.log`, `extra-edges.log`: additional genuine oracle failures before fixes.
- `verify.sh`, `verification.log`: final debug/release × all-three-entrypoint matrix,
  preserved keys list135/mutations184/settings347, crate tests, strict clippy,
  formatting, Biome and frozen-source diff checks.
- `check-artifacts.py`, `manifest.sha256`: retained-pair verification and SHA256
  source/oracle/descriptor/helper/binary provenance.
- Frozen TS focused tests: CLI models-show4; control model pricing/pin/validation34;
  store config7 pass/1 skip. Logs: `ts-tests.log`, `ts-control-tests.log`,
  `ts-store-tests.log`.
- `secret-probe.ts`/`secret-probe.log`: actual TS/Rust list/show human/JSON
  with stored credential secret sentinels and a public pin, four comparisons.
  `numeric-probe.log`: ten additional subnormal/signed-zero/rounding/extreme-value
  human-output comparisons.
- `snapshot-tests.log`: four focused gateway-core snapshot tests pass;
  store suite also retains malformed-row degradation and endpoint-null regressions.

Final verification COMPLETE: debug AND release × standalone/unified-subcommand/
argv0-symlink each PASS models155, keys-list135, key-mutations184, settings347.
Totals: 930 model comparisons (including24 PTYs), 810 key listings, 1104 key
mutations and2082 settings comparisons. CLI1/control7/store64 tests pass;
four store measurement/helper tests remain ignored. Strict scoped all-target
clippy, workspace fmt, Biome and frozen-source diff checks pass.
Read the complete249-line final transcript; reloaded and verified all930 retained
model-result pairs and all60 source/binary SHA256 entries. No pending verification
jobs or implementation blocker. Controller independent review remains next.

The first matrix was stopped by the tool's120s timeout; its partial transcript is
`verification-timeout.log`. Final matrix ran with no timeout after rebuilding all
four binaries from final implementation sources. Earlier compilation/edge-test
failures are retained where named above; final matrix has no failures.

Implementation commit is the commit adding this report; exact commit and binary
provenance is retained in `/tmp/opencode/cli-model-reads/provenance.txt`.

## Boundaries

Verification platform is Linux x64, Bun1.4.4; PTY checks use xterm-256color.
No cross-platform terminal or alternative JS-engine error-message claim.
No gateway hot-path changes or full gateway benchmark were needed for these reads.
Model mutations/catalog/dry-run, remaining CLI/admin/providers/cluster/release work
are future increments. Controller owns independent review. No full-migration
readiness claim. Pre-existing progress, lockfile and untracked specification work
were preserved.
