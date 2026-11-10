# CLI model mutations — partial implementation

Base: `8fc650f02e84529f262a8d8c9c7e1572e6953f0b`.

## Scope and outstanding work

Implemented `models rm <id>` through CLI/control/store, including lossless
get-before-confirm, missing/empty IDs, nonterminal refusal, `-y`/`--yes`, terminal
accept/decline, JSON/human output and help. Deletes only the named model row.
Malformed JSON anywhere in the stored model list prevents deletion, matching TS;
valid but schema-invalid targets do not prevent deletion. The store delete is
idempotent; the CLI's second deletion correctly fails its initial lookup.

**The requested put-file/rm increment is incomplete.** `models put -f` is not
implemented or advertised. Catalog/from-catalog/dry-run remain unimplemented.
There is no successful stub. Controller must continue file-put implementation
before treating the requested increment as complete; review this commit as rm only.

Specific remaining implementation dependencies discovered in frozen authority:

- `packages/control/src/schemas.ts:124-189`: required strategy/isAlias/targets
  (no defaults), strict target keys but stripping model/pricing/capability extras,
  ordered Zod diagnostics, safe integer constraints, UTF-16 pin bounds and JS trim.
- `packages/control/src/models.ts:183-214`: schema precedes path/body equality,
  then credential endpoint membership, then whole-model-list parsing and auth
  reachability. Existing-pair grandfathering excludes resolved pins; clearing a
  dangling pin must retain the provider/model exemption.
- The current Rust credential reader is the gateway projection: serde JSON
  providerData, normalized auth types, secret decryption and typed columns. It
  cannot be reused blindly for TS's raw operator metadata semantics. A dedicated
  lossless metadata read is needed, without secret projection.
- File-put needs built-in catalog auth metadata even though catalog *generation*
  is deferred: qoder/antigravity OAuth-only, custom API-key-only, Kilo per-model
  overrides, other/unknown-provider defaults. These checks are not optional.
- Still required: file decoding/errors, aliases/flag conflicts, schema goldens,
  atomic replacement and failure preservation, TS/Rust cross-read and all matrix
  cases for put. No put conformance or write atomicity claim is made here.

These are unfinished engineering dependencies, not an external environment
failure or a reason to narrow the approved contract silently.

## Evidence

Evidence directory `/tmp/opencode/cli-model-mutations/`; raw paired artifacts are
the `/tmp/opencode/model-removals-*` roots printed by the matrix. New oracle
`conformance/cli/model-removals.ts` uses real frozen TS and Rust processes with
independent initialized SQLite roots, byte buffers/status and before/after every
table. Nonempty unrelated credentials, keys, settings and request history are
seeded. Each successful deletion must change exactly the requested model row;
every failure must preserve the whole database. PTYs use the existing fixed
terminal helper. Corpus includes deep20k, lone-surrogate and overflow stored JSON,
malformed unrelated rows, repeated deletion, Unicode IDs, and JS trim answers.

`/tmp/opencode/models-removals-red.log` retains the prior release rejecting rm.
The first new-binary comparison caught `--yes=true`'s short-alias diagnostic;
the correction is scoped to the new command. Prior manifest check was mistakenly
run after source edits: six edited-source mismatches were reported and retained
in `/tmp/opencode/models-mutations-prior-hashes.log`; all other entries matched.
`base-hashes.log` independently checks tracked base contents via `git show`
against that prior manifest before generating the new manifest.

Store test verifies other-connection data_version invalidation and idempotence.
Gateway snapshot regression now verifies deletion becomes visible after a poll.
No gateway hotpath changes or broad performance benchmark.

Final removal matrix: `final-removals.log` PASS47 in each of standalone, unified
subcommand and argv0 symlink, debug and release (282 paired cases, 60 PTYs).
All282 retained pairs independently reloaded and compared, including unrelated
table preservation. Final confirmation uses byte-line reading and UTF8 replacement
instead of rejecting invalid UTF8; matrix rerun after rebuilding all four binaries.
Source/binary manifest includes63 paths and was checked after recording expected
final source/binary changes in `final-hash-transition.log`.

Focused final tests: CLI2/control7/store65 pass, four existing helpers/measurements
ignored; strict scoped all-target clippy, workspace fmt and oracle Biome pass.
Snapshot5 pass with removal refresh assertion; frozen TS model command tests8 pass.
An initial nonexistent TS test-path invocation is retained in `ts-tests.log`;
corrected successful run is `ts-model-tests.log`.

Full regression job completed successfully: all six legs models262/keys135/
key-mutations184/settings347. Transcript267 lines read. The job overlapped the
rm-only input-decoding correction/rebuild, so it is regression evidence for the
unchanged commands, not a uniform final-binary rm measurement; final-removals.log
is the settled-source rm matrix. No file-put source is covered by these runs.
