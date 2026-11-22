# CLI built-in model catalog and from-catalog put

## Fix round 1 — I1 plugin discovery, base e7457d1e, fix c6e5de28

Read the complete review. Evidence is in `/tmp/opencode/catalog-fix1/`.

**I1.** `refuse_plugins` used to treat any child directory as an unsupported provider
plugin. `omni_control::plugins::provider_plugins` now mirrors frozen `listPlugins` +
`readPluginProviders` up to the `import(...)` call, using only the filesystem and never
reading or running plugin code. The checks, in order:
- the child resolves to a directory and its name matches the plugin id pattern;
- `omni-plugin.json` reads, keeping any BOM so it fails as in TS;
- the manifest passes `JSON.parse` and the `safeParseManifest` rules: strict keys; id,
  name, version and sdk bounds in code points; a nonnegative safe-integer api;
  entry-path rules; strict nav; the capability enum; non-empty origins matched exactly
  through the `url` crate; record defaults; and the server/ui, ui-needs-sdk and
  origins-need-capability refinements;
- the manifest declares the `provider` capability;
- the plugin is loadable: the manifest id matches the directory, api is 3, and the
  resolved server entry is a file (UI and sdk problems are not fatal);
- a server entry exists.

Rust refuses only when all checks pass, the exact point where TS would import the module.
The message is now `…; <ids> in <dir> declares one`. Every earlier stop keeps the
built-ins, and catalog/put print nothing, as in TS. The stale "imports every plugin
directory" comments are corrected in `models.rs`, the harness and the generator.

**RED/GREEN.** I first verified that all four binaries still matched the `e7457d1e`
manifest (`red-binary.log`). The expanded harness then failed **230** of 510 comparisons
on those binaries (`red-I1.log`), including the review's empty `plugins/acme` repro,
before stopping on the old refusal text. `green1.log` passes **510** comparisons plus
**12** Rust-only refusal checks.

**New real-TS goldens.** 61 no-provider plugin layouts, each run through
`catalog --provider kimi` (with and without `--json`), `put kimi:k3 --json` and
`put nope:x`: 244 comparisons, plus 2 for an unreadable (mode 0) manifest. The layouts:
- no plugins directory, or `plugins` is a file;
- an empty subdirectory, invalid-id directories, a broken symlink;
- no manifest, the manifest is a directory, empty, broken JSON, a BOM, JSON non-objects;
- capability-free, storage-only and net:outbound-only manifests;
- UI-only manifests, both loadable and unloadable;
- 39 provider-capable manifests that fail the schema (origins, keys, `__proto__`,
  bounds, api type/range, capabilities, sdk, defaults, nav, entry paths, id);
- provider manifests with an id mismatch, old api, missing server file, a directory or
  `.` as server, or a ui-only entry.

Every server.js writes an `imported` sentinel if it is loaded, and the unchanged
file-list assertion would catch that on both sides. The whole-DB, raw-byte and status
checks are as before.

**Actual provider refusal stays separate.** Three setups: a plugin that declares a
provider, one that imports but declares none, and a symlinked plugin directory with a
`./server.js` entry and a non-fatal unloadable UI. For each, the harness first proves TS
imports the module (sentinel present, and the `acme` row appears only when the plugin
contributes one). It then checks Rust exit 1, the exact message, an unchanged DB and no
sentinel, across 4 commands: 12 checks. The second setup is a deliberate
over-refusal: TS contributes nothing there, but deciding that requires running plugin
code.

**PTY NO_COLOR.** `pty.py` maps an opt-in `PTY_NO_COLOR` to `NO_COLOR` inside the
terminal. The new goldens are `x`, `0` and `1` (plain, matching TS) and `""` (coloured,
matching TS). I confirmed each from the raw PTY bytes.

**Absent price/limit dashes.** The generator now asserts that every built-in row has
finite values for all five prices, both limits and any OAuth limits. Those dashes are
therefore unreachable from built-in data; only plugin providers could produce them, and
those are refused. Remaining coverage is the equal-window OAuth dash plus the shared
`price`/`tokens` formatters, which the model-read corpus already covers. Synthesising
absent fields would mean editing frozen data, so it was not done.

**Prior e7457d1e matrix (completed after review cutoff).** `cli-model-catalog/verification.log`
reached `VERIFY-COMPLETE`, exit 0. All six debug/release × standalone/subcommand/symlink
legs passed: catalog 265, put 302, rm 47, reads 262, keys 135, key mutations, settings
347. The 319-entry manifest was unchanged after the matrix and rechecked afterwards.
`check.py` reloaded **1590** catalog pairs. CLI/control/store tests, snapshot5, strict
clippy, fmt, Biome, frozen TS commands103 and a clean frozen diff all passed.

**Final c6e5de28 matrix — complete.** One run of `/tmp/opencode/catalog-fix1/verify.sh`
on committed HEAD `c6e5de28` with clean tracked source (`commit.txt`, `status-at-launch.txt`;
only pre-existing dirty user `bun.lock` and progress). I read the full 344-line
`verification.log`; it ends `VERIFY-COMPLETE`, exit 0. Each of the six legs
(debug/release × standalone/subcommand/symlink) passed:
- catalog **510** plus **12** Rust-only refusal checks;
- put **302**, rm **47**, model reads **262**, keys list **135**, settings **347**;
- key mutations **184** (156 + 4 + 3 + 5 + 16).

Generated data `--check` passed. The 325-entry manifest (`manifest.sha256`) covers
owned sources, data, oracles, frozen CLI/control/store/providers/ir/plugin-api
authorities, lockfiles and all four binaries. It was unchanged after the matrix, and a
separate `sha256sum -c` afterwards also passed 325/325 (`postmatrix-hashes.log`).
`check.py` reloaded **3060** catalog pairs (510 × 6): equal raw stdout, stderr and
status; unchanged whole DB (both files) for failures and reads; non-model tables
preserved on successful puts (`check.log`). Also passing: CLI2, control11, store
suites, snapshot5, strict clippy, fmt, Biome (10 files), frozen TS commands103 and a
clean frozen `apps`/`packages` diff. Ignored tests are the four existing
helpers/measurements.

| Item | Commit | RED | GREEN | Evidence |
|---|---|---|---|---|
| I1 overbroad plugin refusal | c6e5de28 | `red-I1.log` 230/510 on e7457d1e binaries (`red-binary.log`) | `green1.log` 510+12; final 6×(510+12) | `verification.log`, `check.log` |
| Minor 1 PTY NO_COLOR | c6e5de28 | old case duplicated a coloured run (review) | goldens 60–63, raw bytes plain/plain/coloured/plain | `green1.log` root artifacts |
| Minor 2 stale comments | c6e5de28 | — | `models.rs`, harness, generator corrected | diff |
| Minor 3 absent dashes | c6e5de28 | — | generator asserts every row's finite prices and limits | `--check` in transcript |

**Concerns.** "Imports but declares none" is still refused, a deliberate over-refusal
because deciding it needs plugin code. The manifest schema is reimplemented from frozen
zod rules and checked by 39 invalid-provider goldens plus a unit test, but it is not
exhaustive over every zod edge. Other origin hosts (IDNA, IPv6) are not
golden-covered. Unreadable-manifest coverage relies on mode 0, so a root user would read
it. Linux-only PTY coverage. No gateway hot-path change.

Base `b7cdffc2`. Implementation commit `e7457d1e`. Evidence `/tmp/opencode/cli-model-catalog/`.
Implementer opus-pr#high, no subagents. Plugins skipped per operator.

## Implemented scope

- `models catalog [--provider P]`: human table and `--json`, in registry and catalog order.
  Matches the frozen output for prices (`toFixed(2)`), en-US grouped limits, the
  `CONTEXT OAUTH` column (a dash when the OAuth and API windows match, otherwise
  `choiceLimits(entry,"oauth")`), labels with em dashes, empty results (`qoder`, `custom`,
  unknown, `""`, `constructor`/`__proto__` give a header-only table or `{"models":[]}`),
  repeated `--provider` (last wins), ignored positionals, provider tone colours on a PTY.
  Catalog never opens the store, so config errors are irrelevant to it, as in TS.
- `models put <id> --from-catalog <provider>:<model> ...`: splits at the first `:`
  (`p <= 0` is a usage error); usage errors for an unknown provider (own-key only) and a
  missing model, in spec order; repeated targets kept; tier and weight 1; pricing copied
  from the row; capabilities from the descriptor; no limits copied. `--strategy` defaults
  to `score` only when the flag is absent, so a blank or invalid value reaches the existing
  schema error. `--alias` is a boolean. Conflict with `-f` and the missing-source error are
  unchanged. Everything else goes through the existing `omni_control::models::put` path:
  schema, custom endpoint, catalog auth reach and grandfathering, pins, and the
  single-statement atomic write.
- Generated data: `crates/omni-control/data/provider-catalog.json` is the Biome-formatted
  `JSON.stringify(PROVIDER_DESCRIPTORS)`, written by `conformance/cli/provider-catalog.ts`.
  `--check` detects drift byte-for-byte. The generator asserts a lossless JSON round trip
  and `descriptor.id === key`. The Rust unit test
  `catalog::tests::generated_data_matches_frozen_ts_registry` runs real Bun at test time
  and compares parsed values and `JSON.stringify` bytes with the frozen registry.
- `omni_control::catalog` replaces the hand-written `model_auths` table that the previous
  put increment added. Catalog auth reach (`entryModelAuths`, plus every way in for an
  unknown provider) now reads the generated rows. Provider tones in `models list/show`
  also read the generated presentation data instead of a hand-written match.
- Gateway routing is untouched. `omni-router`'s `Providers::builtin()` keeps empty
  catalogs, and no codec support is claimed. The gateway hot path does not change, so no
  gateway benchmark was run.

## Plugins: behaviour without plugins, and the divergence (superseded by fix round 1)

Frozen TS calls `pluginProviders(root)` for both commands. It reads only directories
under `<root>/plugins`. A missing directory, files only, or no provider-capable
directories leave the registry as exactly the built-ins, with no output and no failure
note (`catalog` and `put` never print plugin failures; only dry-run does). Every golden
seeds `<root>/plugins/README` (a file) to cover the "directory present, no plugins" case.

Rust refuses instead of silently omitting plugin providers. If `<root>/plugins` holds any
directory (resolved through symlinks), both commands exit 1 with
`plugin providers are not supported by this Rust CLI; found <sorted names> in <dir>` and
leave the DB untouched. This is a deliberate divergence from TS, which would import the
plugins. It happens after root/DB-warning resolution and before spec parsing. Four
Rust-only assertions in the harness cover it. It is broader than TS, which merges only
loadable provider-capable plugins, so UI-only plugin directories are also refused. That
is the conservative choice. A plugin-capable port remains outstanding.

## Shared fixes found by new RED cases

- **Context ordering.** TS `createContext` prints the ambient `OMNI_DB_PATH` suppression
  warning before any command validation. Rust previously printed it only when opening the
  store. `context::resolve` now runs first for every models command, and
  `Context::open` defers config errors to the store open, as before. This affects warning
  order for models list/show/rm/put usage errors. The regressions pass unchanged.
- **Short-cluster diagnostics** (`args.rs`, every command). Node names an unknown character
  in a multi-character cluster without a dash (`-y1` gives `Unknown option '1'`), but a
  lone short option with one (`-1` gives `'-1'`). Rust always added the dash. Fixed, and
  the `-f` put cluster path is covered too (`-xfmodel.json`, `-yxf`).
  RED: `red-cluster.log`.
- **`--yes=`/`--help=` diagnostics** for every command now name the short alias
  (`Option '-y, --yes' does not take an argument`), as Node does. The special case was
  previously limited to `models rm`.

## RED / GREEN

- `red-initial.log` (root in `red-root.txt`): before any implementation, **251/251**
  comparisons RED (`unknown command` for catalog, put refusing `--from-catalog`).
- `red-cluster.log`: the added `-y1` edge fails after the first GREEN; fixed in args.rs.
- `green3.log`: focused **265** comparisons GREEN plus 4 plugin-refusal checks
  (debug standalone).

## Golden corpus (`conformance/cli/model-catalog.ts`, 265 per leg)

Independent TS and Rust roots, each seeded with migrations, an admin hash sentinel, an
API key, a request log and a `plugins/README` file. Each case checks raw stdout/stderr
bytes and status (only each side's own root path is normalised), plus whole-DB before
and after snapshots of both `db` and `omnigateway.db` (the second for the cases that
resolve the ambient DB). The working directory file list must not change. Failures and
catalog reads must preserve every table. A successful put must preserve every
non-`virtual_models` table. TS and Rust snapshots must be equal.

Coverage:
- Catalog: all nine providers in human, JSON and PTY forms; the whole catalog in human,
  JSON and PTY; `--no-color` on a PTY; flag forms (missing/ambiguous/inline/empty values,
  repeats, unknown flags, `-p`, `--json=1`, `--yes=1`, `--help=1`, `--no-color=1`, `-yh`,
  `-y1`, `-1`, `-yé`, `-é`); `OMNI_ROOT`; leading `--json`; a missing encryption key or a
  bad port (still succeeds); the ambient-DB warning.
- Put: every one of the 76 catalog rows as a JSON put; multi-provider targets; repeated
  targets; all strategies plus blank/invalid/repeated/missing/ambiguous values; alias
  forms; 28 malformed or edge specs (empty, `:`, case, whitespace, `\u0001`,
  prototype names, `custom`/`qoder` with no rows, extra colons, non-ASCII); spec error
  ordering; `-f` conflict both ways; missing/empty/surrogate ids; extra positionals;
  unknown flags; help; PTY; usage-before-config and config-before-schema ordering; the
  ambient-DB warning before usage errors and successes.
- Stored state: replacement; replacement with alias and weighted strategy; malformed
  stored targets (`broken`, `null`, `{}`, `[null]`, `1e400`); kilo free and `kilo-auto`
  rows with OAuth (refused) and API keys (accepted); antigravity with an API key
  (refused); openai with either auth; a grandfathered kilo pair on the same model id
  (accepted); the same pair on a different model id (refused); custom credential
  `providerData` that is null, broken or valid.

## Verification

Initial matrix: see the fix-round-1 summary above (completed, 6 legs, 1590 pairs).

## Limitations

- Plugin providers: refused, not ported (above).
- `models dry-run` is still deferred.
- Superseded in fix round 1. The original `NO_COLOR=x` PTY case did not test
  suppression: `pty.py` removed `NO_COLOR`, and non-PTY runs are uncoloured anyway, so
  they prove nothing about it. `PTY_NO_COLOR` now passes `NO_COLOR` into the terminal.
  Goldens `x`, `0` and `1` print plain and `""` prints coloured, matching TS, and this
  was confirmed from the raw PTY bytes.
- PTY and timezone coverage is Linux-only. No full gateway benchmark (CLI-only change).
