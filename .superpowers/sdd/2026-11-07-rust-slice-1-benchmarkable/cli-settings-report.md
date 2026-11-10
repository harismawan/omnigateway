# CLI settings get/set increment

## Fix round 1 — Important destructive fallback

Implementation commit: `00acb21b` (base `cd3e7bd1`).
Fix binary SHA256 (debug omni/gateway, release omni/gateway):
`226c666523bc23f1ee01d47af5f9d7f3df236c2e219e8bc2321e60f5fa200d8e`,
`197f9afb12c8db823aa876cbc15cf20352641faff4f79601b2b8b2b85130abff`,
`11de5b9fc8aa57ee387b7503bb7dfbe42ba0ec6d2e928d6fda4fc82c8cbceb68`,
`3a5d07af0886b76ff6b4a62f7f49981948f1134642357ef9af3a8b489d806326`.

Full independent review read. The prior extreme/deep/nonfinite limitation below
was not an acceptable waiver: new CLI writes could reset unrelated configuration.
This round replaces operator settings ownership with the existing stack-safe
`JsValue` parser/clone/drop/serializer. Gateway parsing and admission are unchanged.

Item → evidence:
- Overflow known numeric value: retained ±Infinity until schema checking; get
  serializes it to null in JSON and prints Infinity in human output. Rejected
  edits preserve every settings-table row, including the original raw text.
- Deep unknown values: retained through read, valid merge, serialization and drop;
  capture=true survives. Duplicate keys keep the last value in the first slot.
- Schema normalization: only shallow known-field projections reach the existing
  safe defaults/degrade logic. Original unnormalized numeric fields and unknown
  fields remain JS values. Deep invalid known values retain their type for errors.
- Store write reads again after control validation, matching TS's actual second
  read and merge rather than inventing a transaction or reusing stale unknowns.
- Small-stack test: 20,000-deep valid write, duplicate replacement and overflow
  error cleanup on a 256KiB thread stack; no depth-limit disabling.

Real TS corpus expanded259→331 with ±overflow known/unknown/weight/nullable fields,
130/1000-deep known/unknown/weight values, duplicates and deep error cleanup.
Every fixture exercises human get, JSON get, set and repair; independent roots,
raw bytes/status and all rows of the **settings table**, not a whole-DB comparison.
RED `/tmp/opencode/settings-fixround1/red.log`; focused GREEN `green.log`.
Exact review `set rtkEnabled true` overflow and deep130 reproductions also PASS
against independently seeded TS/Rust stores (`exact.ts`, `exact.log`, raw results).
Final verification COMPLETE: debug AND release × standalone/unified subcommand/
argv0 symlink each PASS settings331, preserved mutations184 and list135.
Totals: 1986 settings comparisons, 1104 key mutations, 810 key listings.
CLI1/control6/store settings2/write1/key2/usage2 PASS; strict scoped all-target
clippy, workspace fmt and Biome PASS. Complete 194-line transcript read;
all33 manifest source/binary hashes and all1986 retained settings/output pairs
independently reloaded and verified (`artifact-verification.txt`).
Final source/binary provenance and exact commands retained in the same directory;
manifest source is `00acb21b`. No verification jobs remain. Controller scoped
re-review is next.
Frozen CLI settings16 and store config7+1skip PASS in this fix round.
Gateway-core snapshot/refresher5 PASS; existing data_version notification behavior
is preserved. Debug retained331 pairs per entrypoint were also reloaded and
compared from disk, including raw output buffers and settings-table rows.

Remaining migration scope remains full CLI/admin/providers/cluster work. This
fix does not waive the settings contract for deep or overflow values. The shared
operator parser retains its previously documented lone-surrogate replacement;
no new claim about that separate string edge is made by these overflow/depth tests.

Base: `09bb601acc449b31d1aae9a294b67f0ffc8290c3`.
Implementation commit: `cd3e7bd1` (`feat(cli): add settings get and set`).
Exact source patch and its SHA256: `/tmp/opencode/cli-settings/implementation.patch`
and `implementation.sha256`. Existing uncommitted progress entries were preserved;
the report and ledger are controller workspace handoff documents.

## Implementation

- Added settings get/set dispatch for the standalone and unified CLI paths.
- Current-value type chooses parsing; nullable defaults remain nullable after a
  string edit. Uses shared JS trim/Number, own properties, first two path segments,
  JS JSON ordering and UTF-16 field widths.
- Control validates before writing; store merges one settings row with an upsert.
  Separate password/internal rows are untouched and excluded from output.
- Existing gateway read normalization remains unchanged. A second connection's
  `data_version` changes after save, allowing the existing snapshot refresh path.
  Existing gateway-core snapshot/refresher tests also pass (5 tests;
  `/tmp/opencode/cli-settings/snapshot.log`).

## Evidence

`conformance/cli/settings.ts` runs actual frozen TS and Rust subprocesses against
independently seeded roots, comparing stdout/stderr bytes, exit status and every
settings-table row including raw stored JSON. Invalid commands assert unchanged
rows. Both implementations subsequently read the other's DB. Each case retains
raw buffers and rows under its printed `/tmp/opencode/settings-golden-*` root.

Coverage: defaults, all setting fields and weights, human/JSON ordering, boolean
and string trims, nullable clear/reassign, enum errors, radix/exponent numbers,
safe-integer and range edges, negative values through `--`, unknown/prototype
names, extra path segments, missing/empty positionals, help/options, repeated
edits, malformed stored types and repair behavior. No masks. Settings output is
uncolored, so no new PTY framework is needed.

RED: `/tmp/opencode/cli-settings/red.log` records defaults get returning Rust
unknown-command exit2 versus TS success. Focused GREEN and build/unit/store/
clippy logs are in the same directory. `verify.sh` specifies the full debug and
release, all-three-entrypoint matrix, preserved keys mutation184/list135, focused
tests, strict clippy, fmt and Biome. Final matrix completed successfully, raw
190-line transcript read and source/binary manifest confirmed:
- Debug AND release, standalone/unified-subcommand/argv0-symlink: settings259,
  keys mutations184, keys list135 PASS each (1554 settings, 1104 mutations,
  810 list comparisons total).
- Rust CLI1/control5/store settings2/write1/key-mutations2/usage2 PASS.
- Strict scoped all-target clippy, workspace fmt, Biome PASS.
- No unfinished verification jobs. `manifest.txt` names the implementation
  commit and hashes all four binaries plus Rust sources and the oracle.

Additional RED/GREEN: `coercion-red.log` / `coercion-green.log` cover an own
noncallable `toString` inside an unknown stored object: human get must fail with
`No default value`, while JSON get succeeds. Reused the existing operator JSON
coercion instead of changing gateway normalization. The first matrix encountered
this newly added regression on its older binary; retained as
`pre-coercion-matrix.log`, then rebuilt the whole final matrix.

Frozen TS settings-focused tests: `bun test apps/cli/test/commands.test.ts
--test-name-pattern setting`: 16 pass, 107 assertions. Frozen source hashes and
empty frozen-source diff are retained alongside the transcripts.
Frozen control settings/retention/guardrail/smart schema subset: 6 pass,
47 assertions. Frozen store config contract: 7 pass, 1 skip, 92 assertions.
Preserved date-boundary corpus: release standalone UTC, 40 pass.

Binary SHA256 (`binary-hashes.txt`; source `cd3e7bd19268b97eea8380294f47385cca8c442d`):
- debug omni: `51e3238b7cd44614be0187fdb4acb0ad6071a7865045819be120dfe04901e1f1`
- debug gateway: `e4f69c1b33cb054075b5908685916682d37cd1011fe6efa46fcb70bd66ad7b99`
- release omni: `c70a837bf8bb99458155f754f87829116883dbc54d6663671cefe276bf57bf11`
- release gateway: `7665494171485aae5ce92f119763597a26e0b9e7a8ff18ca9d15b410d2afae65`

## Limits and remaining migration

Controller owns independent review. Full CLI/admin/providers/cluster migration
remains incomplete. No gateway hot path change or gateway benchmark.
The original serde-backed operator limitation described at initial handoff is
superseded by fix round1 above. Concurrent edits retain the TS
read/merge/write behavior rather than adding a transaction protocol.
