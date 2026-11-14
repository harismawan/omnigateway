## Database write commands

### db restore swap

- Partial checkpoint: stage 0 complete `0f1c6e61`; stage 0b R1 `bbd92cd0`, R2 `0e383e52` complete. I3 residual and orphan scan pending. Stages 1–4 not started; accepted restore still unavailable, no Rust swap enabled.
- Stage 0: six tiny Bun argv code-unit probes show U+FFFD replacement (including truncated sequences, surrogate encoding and overlong bytes). args_os + to_string_lossy matches; invalid root/positional/string-option differential3 pass, full database post-state compared. Red exit101 panic `db9-argv-red.log`; green `db9-argv-green.log`; pinned exits1=3.
- R1: frozen existsSync then read reproduced for mode000 parent, self-link, directory, mode000 file, each status human/JSON and restore. Red `db9-r1-red.log`; green `db9-r1-green.log` PASS12. Unresolvable paths report stopped/reach candidate validation; existing unreadable file still refuses; directory reports read EISDIR. Full database post-state compared. Pinned exits0=4/1=8, EACCES=3.
- R2: mode000 snapshot directory backup cleanup first failed on unlink vs rm (`db9-r2-red.log`), then PASS27 backup comparisons (`db9-r2-green.log`). General cleanup formatter now uses rm, existing EISDIR form retained. Pinned backup exits0=21/1=9, EACCES=1, encryption-key=3, unable-open=1.
- I3 attempt NOT committed: explicit body sentinel assertion failed against opt-in helper (`db9-i3-red.log`). Enabling default body capture plus full failed-backup comparison exposed a post-state mismatch for directory (and successful mode0300 backup) in `db9-i3-db-backup.log`; cause not isolated. Attempt reverted, clean checkpoint; no byte-mask expansion. Orphan scan not attempted; no failing-first evidence claimed.
- Contract below carries forward the db8 observations; no new swap execution or failure injection in this session.

| Swap stage (frozen order) | how tested | state left |
|---|---|---|
| snapshotPath/stat, guard, judge again | prior preview differential; post-prompt not tested | Frozen logic: no undo/staging/swap on refusal. |
| forced undo mkdir/collision/free space/snapshotTo/stat; no retention | prior TS-only successes; faults untested | Observed old-live undo and stale sentinel retained; logic removes partial undo on write failure. |
| hashes before copy | prior TS-only password cases | Logic: undo retained, no staging on getter failure. |
| main-file copy to incoming/cleanup | prior TS-only candidate-WAL case; faults untested | Observed WAL-only row lost; cleanup error wins by logic. |
| close | untested | Logic: wraps swap error, tries reopen; old live/incoming retained before rename. |
| unlink live-wal then live-shm | untested | Logic: completed removals persist; old live/incoming retained, recovery reopen attempted. |
| rename | prior TS-only success; failure untested | Observed candidate installed, undo retained, incoming absent. |
| initial/recovery reopen | prior TS-only shifted-ledger failures | Observed candidate left live, undo retained, no rollback. |
| hashes after reopen | prior TS-only password cases; faults untested | Logic: new live/undo retained on getter error. |
| rebuilds/plugin schema | prior TS-only success; faults untested | Logic swallows failures; restore succeeds. |

- Inherited swap hazards remain TS-only observations from db8, NOT observed in both CLIs: candidate WAL rows lost; reopen failure leaves candidate installed without rollback. No swap parity claim. No SIGKILL experiment performed.
- Known differences: accepted y/--yes restore unavailable; migrate unavailable; orphan partial-list semantics unresolved. Full failed-backup state mismatch above needs diagnosis. No claim that all argv byte patterns were exhaustively tested.
- Final commit offline tests29 (CLI3/control26), clippy all-targets -D warnings and fmt pass with required cargo settings: `db9-tests.log`, `db9-clippy.log`, `db9-fmt.log` under `/tmp/opencode/e1-e5/`. Foreground matrix34/34 exit0; summary `db9-verified-summary.txt`, manifest `db9-verified-manifest.json`. db restore/backup/clear/vacuum/reads and pid-edge suite each exit1 under OMNI_PORT=invalid (`db9-disturbance-*.log`).
- Binary `/tmp/opencode/e1-e5/db9-omni-final`, commit `0e383e52e77d52aaa544c119071938d93df4a772`, sha256 `8422114adae483b5d3120f2b5c1883c2ec7c2b9a8d5bbaa88e5d2e35ff07c5f6`. Password-abort retains prior binary explicitly identified in matrix manifest. Worktree clean; temporary test roots removed.
- Precise next step: finish stage0b I3 (isolate full-state backup mismatch without extra masks) and orphan scan in separate commits; then read complete frozen swap implementation and implement stage1 + round trips/real schema/live WAL fixtures, stages2–4; only then `db migrate`.

### db fix round 1

- C1 `969b7aea`; I2 `13b87af5`; I3 `198f2a56`; directory diagnostic `868e5e09`; low-space diagnostic `8ead4979`. No restore-swap or migrate changes.
- C1 first failing case: absolute stored body path deleted the outside sentinel only in Rust; `/tmp/opencode/e1-e5/dbfix1-c1-red.log`. New cases cover absolute, parent traversal and symlink traversal; `/tmp/opencode/e1-e5/dbfix1-c1-green.log`: PASS13, frozen exits 0=9 / 1=4 / encryption-key=1 (pinned).
- Join normalization expectations captured by running Bun `path.join` on ten input pairs: `/tmp/opencode/e1-e5/dbfix1-c1-node-join.log`; matching Rust unit test passes (`dbfix1-c1-unit.log`). Includes absolute, dotdot, dot, repeated/trailing separators and empty arguments.
- Inherited hazards observed in both CLIs: `../outside-dir/outside` and `link/outside` through a symlinked directory delete the sentinel outside the body root. Absolute row paths now preserve it in both. Fixtures stay within their temporary installation root and self-clean.
- Other join sites checked (`dbfix1-join-audit.log`): control database restore IDs (validated ASCII filename grammar), generated snapshot names, literal snapshot directory; plugins schema-valid entry segments and readdir names; CLI context `absolute` intentionally matches TS `resolve` (context.ts:59,63,193); setup joins literal settings filenames; status joins literal service/state filenames; CLI database/model joins literal directory names. Remaining matches are tests or non-path joins. No second absolute-rel replacement instance found in these sites.
- Non-UTF-8 root probe (`dbfix1b-utf8.log`): frozen exits1 “unable to open database file”; Rust args() panics/exits101 before node_join. Thus this root never reaches the lossy join in Rust; earlier argv parity difference remains, not silently treated as supported.
- I2 red logs `dbfix1b-i2-db-backup-red.log` (mode0300 backup exits1 after write) and `dbfix1b-i2-db-restore-red.log` (mode000 EACCES). Green fixtures cover these plus self-link/300-letter reason, db snapshots for each, and retention preserving the old sentinel under mode0300. Permissions restored in finally. Shared database_fs stat returns None, readdir returns empty on every failure; mutation errors still propagate (unlink tolerates missing).
- I3 red `dbfix1b-i3-red.log`: unmasked DELETE-mode post-state comparison fails. Shared fileState captures live/-wal/-shm presence and bytes, recursive snapshot names/bytes/symlinks, and body listing/bytes for clear-bodies; all four suites use it for refusal checks, including adapter cases. DELETE-mode and nonempty-live-WAL absent-candidate restore refusals both change frozen state; compare Rust to frozen post-state masking exactly live header bytes96–99. Truncated candidate still compares exact post-state. Green `dbfix1b-i3-db-*.log`.
- Minor directory red `dbfix1b-directory-red.log`; green `dbfix1b-directory-green.log`: shaped directory remains and newly written snapshot remains; exact rm EISDIR text matches. Low-space frozen exported createSnapshot with injected free=109/live-size=100 produced CONFLICT prefix (`dbfix1b-low-space-frozen.log`); corrected expectation fails first (`dbfix1b-low-space-red.log`), then threshold unit passes (`dbfix1b-low-space-green.log`).
- Final-commit verification: offline cargo tests29 passed (CLI3/control26), clippy all-targets -D warnings and fmt passed; `dbfix1b-tests.log`, `dbfix1b-clippy.log`, `dbfix1b-fmt.log` under `/tmp/opencode/e1-e5/`.
- Full foreground matrix32/32 exit0; summary `/tmp/opencode/e1-e5/dbfix1b-verified-summary.txt`, manifest `dbfix1b-verified-manifest.json`. Four db suites each exit1 under OMNI_PORT=invalid (`dbfix1b-disturbance-db-*.log`). Backup26/restore35/clear13/vacuum4 comparisons; restore also6 formatter goldens/4 Rust-only yes refusals. Pinned exits: backup0=20/1=8, restore0=7/1=30/2=1, clear0=9/1=4, vacuum0=2/1=2.
- Binary `/tmp/opencode/e1-e5/dbfix1b-omni-final`, commit `8ead4979ff99e733991d017a0667a4814c37918c`, sha256 `9f647338f1259da204d9e78b5a4c90cc8b10223b37ba406d716255ab9028084a`; abort sha256 `547eb2519ec8346c05e7e78f8f7ab6f3fb9b61bcf3874cc2dd3edb56eae3cc38`. Scratch abort target removed; worktree clean.
- Remaining: restore accepted-confirmation swap unavailable, db migrate unavailable; non-UTF-8 argv divergence above. No universal refusal no-write claim: comparisons cover the specific fixtures listed.

**db8 partial checkpoint: I1 fixed; frozen swap characterized, Rust swap NOT enabled.**

| Command | Status / suite |
|---|---|
| backup / vacuum / clear-bodies | prior checkpoint retained: 24 / 4 / 10 cases |
| restore | 30 differential cases, 6 formatter goldens, 4 Rust-only yes refusals; 7 additional TS-only swap characterizations |
| migrate | unavailable |

- Group 1 retained (`9365d16e`): missing ID and both running-gateway forms, 3 cases; registry/help already available.
- Group 2 `cb412bfc`: 8 cases (absent valid ID, slash, backslash, dotdot, outside symlink, directory, empty, unparsed). Shared control validation uses the exclusive preview guard. Red run failed on absent-ID diagnostic; later cases were written first but stopped behind that failure (`db6-group2-red.log`).
- Group 3 `006a6986`: 6 cases (garbage, foreign few/many tables, older/newer migration IDs, truncated snapshot). TS ignores migration version and accepts both variants; JSON dry-run was implemented to test that acceptance. Inspection matches required schema-001 tables and PRAGMA quick_check; first diagnostic row only, unreadable on exceptions.
- Group-3 red run reached older-schema acceptance and failed exit 2 (missing dry-run parser support); next comparison caught JSON field ordering. Refusal cases already passed using group-2 inspection; not independently red. Logs `db6-group3-red.log`, `db6-group3-green.log`.
- Group 4 `8e815738`: 2 differential cases (human/JSON dry-run with live request_bodies changed after snapshot), plus 6 checked-in goldens generated by `conformance/cli/db-preview-goldens.ts` calling frozen exported previewTable. Suite rechecks goldens; Rust unit test checks bytes. Identical sets, snapshot-only, live-only, null live, empty, and UTF-16 width/sort (including non-ASCII/astral names). First red exposed TS sidecars on a WAL-mode copied candidate; fixture now sets snapshot journal_mode=DELETE. Human unavailable failure was not independently recorded after that fixture correction.
- Group 5 `cdc1ce50`: 8 differential cases (pipe refusal, PTY n/empty/other, each human/JSON) and 4 Rust-only accepted-confirmation cases (PTY y/--yes, human/JSON). Preview precedes question on stderr; separate PTY stdout pipe asserts empty stdout. All assert live/-wal/-shm, snapshots and snapshot directory listing unchanged. First red: Rust stderr did not start with TABLE (`db7-group5-red.log`).
- Suite: 30 comparisons; pinned exit 2=1 / exit 1=25 / exit 0=4 / environment EACCES=3. Truncated WAL-mode candidate exception retained: TS creates candidate -wal (empty) and -shm; byte-identical TS/Rust post-state asserted. Nonempty live WAL not injected.
- Negative disturbance now FAILS: `OMNI_PORT=invalid` on group-2 suite adds 8 environment OMNI_PORT failures to histogram (`db6-disturbance.log`); three early gates remain unaffected.
- One deliberate temporary restore difference: after terminal y or --yes, TS restores; Rust prints `db restore is not yet available in the Rust CLI`, exits 1; existing fixtures assert their captured state. Opening a database can itself write, so universal refusal invariance is not established. `db migrate` remains unavailable.
- Commits: `58a38870` TS characterization + red Rust comparison; `3b2af584` unreadable pidfile fix; `cab17f0a` candidate-WAL loss characterization. No product TypeScript changes. All fixture roots removed.
- I1: mode-000 live-pid file now refuses restore --yes and status human/JSON exactly as TS; three cases assert stdout/stderr/exit and untouched database/snapshots/pid contents. Red `db8-pid-red.log`; green `db8-pid-green.log`. Other review issues remain outside this increment.
- `db-restore-swap.ts` defaults to TS-only; `--compare` deliberately fails on Rust unavailable (`db8-swap-red.log`). Seven frozen cases pass (`db8-swap-ts.log`): yes human, yes JSON/admin changed, terminal human/viewer changed, terminal JSON/both changed, older/newer shifted ledgers, candidate WAL-only row. Five public-command undo round trips restore all original tables. Whole-database helper checks live/undo, candidate bytes, result counts/booleans, undo name/time/size, and retention bypass (zero settings plus old manual sentinel).
- Inherited hazard OBSERVED: WAL candidate settings count is 4 in preview/result, but installed live has 3; WAL-only row is LOST because swap copies main file only. Candidate remains readable with 4 while its writer holds WAL. No Rust parity claim yet.
- Inherited half-swap OBSERVED: both earlier older/newer fixtures shift migration IDs ±1000, not actual schema. Inspection accepts; reopen reruns migration 001 against existing tables and fails. Candidate is already live; undo survives; incoming/live sidecars absent at process exit; no rollback. Genuine older-schema migration/newer-schema restore still need fixtures. Successful cases likewise have no live sidecars/incoming at process exit (measured before inspection opens).
- Binary built at `3b2af584` (final `cab17f0ae93f5a590c687d50dc4c2220326e2149` changes tests only): `/tmp/opencode/e1-e5/db8-omni-final` SHA256 `ec7643e7ba9d63f4f0d8635545abe0f5bf81d31032000fd6c6259f1dd1a798f2`. Abort binary reused from db7/4ef17d62, SHA256 `91d99a3a9da3ffca59dca26e06eca3e6596fa73178e82e6b33a0b8606082ff3d`; only password-abort uses it.
- Final-commit verification: offline tests 28 passed; clippy all-targets -D warnings and fmt passed, CARGO_INCREMENTAL=0 and dev/test debug=0 (`db8-test.log`, `db8-clippy.log`, `db8-fmt.log`). Latest matrix adapted to db8, foreground 32/32 exit=0 (`db8-verified-summary.txt`), no failed entries. Additional TS-only swap suite 7 cases/5 round trips passed separately; it is not part of the pinned differential matrix.
- Stages: 1 incomplete (tests/characterization only); 2–3 not started; 4 SIGKILL experiment NOT performed. Accepted path stays unavailable, so no new half-swapping Rust command. Known intentional difference remains accepted y/--yes. Next: finish stage 1 behind exclusive control guard, real older/newer schemas + nonempty live WAL, make --compare pass and replace four Rust-only refusals; then failure seams/fixtures and kill experiment; then `db migrate`.

| Swap stage (frozen order) | how tested | state left |
|---|---|---|
| snapshotPath/stat, exclusive guard, judge again | preview validation differential only; post-prompt mutation untested | Frozen logic: no undo/staging/swap on refusal. |
| forced undo mkdir/collision/free space/snapshotTo/stat, no retention | TS-only yes/terminal/WAL cases (success); failure injections unverified | Observed undo equals old live, stale sentinel retained despite zero retention. Logic removes partial undo on snapshotTo failure. |
| read hashes before copy | TS-only changed-password success; failure untested | Logic: undo retained, no staging. |
| copy candidate to incoming; cleanup on error | TS-only candidate-wal-only-row success; unwritable file/directory failures untested | Observed main-only copy loses WAL row; logic removes partial incoming; directory cleanup error wins. |
| close | No failure fixture/unit yet | Logic: wraps SwapFailedError, attempts reopen; old live/incoming retained before rename; close may checkpoint. |
| unlink live-wal then live-shm | No failure fixture/unit yet | Logic: completed removals persist, old live/incoming retained, best-effort reopen. |
| rename incoming over live | TS-only success; failure untested | Observed incoming absent, candidate installed, undo retained; failure logic retains incoming/old live. |
| initial reopen, recovery reopen | TS-only older-ledger/newer-ledger (both fail) | Observed candidate remains live, undo retained, incoming/sidecars absent; no rollback. Recovery-success branch untested; reopened flag not exposed by CLI. |
| read hashes after reopen | TS-only password booleans; failure untested | Observed separate booleans; logic reports ordinary error with new live/undo retained on getter failure. |
| rollup rebuild/plugin schema reapply | Success exercised TS-only; faults untested | Logic swallows failures with warning; restore succeeds. No seam/unit parity claim. |

### Previous db4 checkpoint (historical)

**Partial checkpoint (db4). A1–A4, A6, A7 and B complete; A5 requested CLI collision/WAL refusal added. Restore not started. Next: restore part-one golden refusals, shared gateway-status check, candidate validation, preview and confirmation; no swap.**

Review I1: `1bb8836a` removes the ambient recursion marker and asserts/removes exactly one automatic import from the generated child. The reviewer's `OMNI_CONFIG_GATE_CHILD=1` command previously passed 302 without its negative child (`db-i1-before.log`); afterward it passes 302 plus seven diagnostic checks and the expected cluster-category child failure (`db-i1-after.log`, `db-i1-after-child.log`); normal invocation also passes (`db-i1-normal.log`, `db-i1-normal-child.log`). The two round-3 wording qualifications below are corrected.

| Command | Commits | Suite / cases | Status |
|---|---|---|---|
| db backup | ea7cb71b; 71473672; aa9e2588; 254c3076; 679e399b; 54e11aaa; 59366f8a; 43b96666; b9c8193a | db-backup.ts / 24 | CLI collision and nonempty-WAL key refusal covered |
| exclusive guard | 2e51c06c; b9c8193a; 450d2dec | database.rs / 1 new unit test | snapshot/vacuum guarded; reusable conflict/skip helpers |
| db vacuum | 8ffb5d03; lint follow-up 71473672 | db-vacuum.ts / 4 | implemented, coverage incomplete |
| db clear-bodies | ce51dd32; help follow-up f3929a36 | db-clear-bodies.ts / 10 | implemented |
| db restore | none | none | unavailable |
| db migrate | none | none | unavailable |

Both suites were written and run red before their implementation: `db-backup-red.log` and `db-vacuum-red.log` under `/tmp/opencode/e1-e5/`. Each failed on the first refusal comparison (the Rust unavailable diagnostic versus the frozen configuration diagnostic). Both now cover bad encryption-key refusals followed by human/JSON success. Backup checks snapshot integrity, settings rows, stale snapshot pruning, newest preRestore retention, and preservation of unmanaged files. A control unit test covers same-instant collision and cleanup after VACUUM INTO is refused inside a transaction. Vacuum exercises reclaimed pages. Both suite histograms pin exit 1=2, exit 0=2, environment OMNI_ENCRYPTION_KEY=2. Both fail with OMNI_PORT=invalid (`db-backup-disturbance.log`, `db-vacuum-disturbance.log`); that environment is passed to both executable invocations, though the first unexpected TS exit aborts the success case before its Rust invocation.

### Restore failure states (source inspection only; not implemented or injected)

Additional disturbance confirmation: invoked both real CLIs directly for each new command under the same `OMNI_PORT=invalid` environment; both exit 1 with byte-identical config errors, including vacuum's human note (`db-backup-disturbance-both.log`, `db-vacuum-disturbance-both.log`).

| Failure point | Frozen TS state | Rust state | Test |
|---|---|---|---|
| Candidate validation | swap not entered; live store already opened by CLI | shared guarded validation; no swap | db6 ID/candidate differential cases; truncated candidate sidecars match TS |
| Undo snapshot write | no swap; partial undo removed on VACUUM error | unavailable | not written |
| Staging copy | undo survives; partial .incoming removed; live not closed | unavailable | not written |
| Close / sidecar unlink / rename / reopen | preRestore undo survives; no automatic rollback; best-effort reopen; live may be old or new, .incoming may remain depending on failure point | unavailable | not written |
| Post-reopen metadata read | replacement already live | unavailable | not written |

### Known differences and open work

- A1 fixed in aa9e2588: moved existing JS-compatible parser into control and re-exported from CLI. Overflow-date fixture failed first (two manual files instead of one), then passed; `db2-a1-red.log` / `db2-a1-green.log`.
- A4 fixed in 54e11aaa: listing had a lexical pre-sort; reverse-order golden failed (`db2-a4-list-red.log`), then passed after removing it. Listing and pruning both preserve enumeration order and stable-sort timestamps only. Both creation orders compare enumeration, listing and survivors; recreated fixtures enumerate identically on this filesystem. Inherited TS behavior: manual/preRestore ties require the same millisecond; manual-first keeps both, preRestore-first keeps only preRestore with keepLatest=1. User withdrew order-independence requirement.
- A2 fixed in 254c3076: setup filesystem formatter moved to control; backup mkdir/stat/unlink/readdir use it, cleanup errors propagate. File-occupied snapshot directory failed first on EEXIST text (`db2-a2-red.log`), then passed. Mode-0500 refusal now golden; both cases assert live/-wal/-shm bytes and no stray snapshot. `db2-a2-green.log`: six comparisons.
- A5 in 59366f8a: injected free-bytes callback; tests cover threshold minus one/exact/plus one and unknown, with nonempty WAL invariance. Corrupt table-page golden covers VACUUM failure and output cleanup. Collision and transaction refusal unit assertions check live bytes. db4 adds CLI collision and pre-open WAL refusal below; prune-unlink/busy errors remain open. No full-disk CLI injection; space refusal unit-only. Existing free-space Rust diagnostic lacks TS's error-code prefix; CLI parity for this remains unverified.
- A6 complete: process-global RAII latch, TS CONFLICT diagnostic, skip helper, release on success/error/panic; unit tests serialized because snapshot operations now share the latch. Clear-bodies deliberately unguarded, matching source. Restore/sweep/import callers remain future work.
- A3 fixed in 679e399b: deferred settings callback after VACUUM INTO; unit test verifies completed snapshot exists even when settings callback fails. Five golden values pin count coercion: "3" => 3 files, "garbage" => 1, -2 => 1, 2.5 => 3, 1e300 => all 5; huge maxAgeDays permits old fixtures. Numeric-string case failed first (`db2-a3-red.log`). A4 adds age variants "3", "garbage", -2, 2.5, 1e300 with 1/2/2.75/4-day fixtures (4/1/1/3/5 survivors including new snapshot). Concurrent edits remain untested.
- No running-gateway fixture yet for backup/vacuum. Neither implementation adds a running-gateway gate.
- A7 complete in 43b96666: extracted password suite table enumeration into database-state.ts and reused it for every table in normal successful snapshots plus an open-connection/nonempty-WAL fixture. Snapshot/live and TS/Rust states match; password-bytes suite passes. Nonempty-WAL differential refusal invariance remains A5 work.
- A5 db4 collision pre-creates 30,000 millisecond-named sentinel files spanning 30 seconds for each CLI; exact CONFLICT output/exit and live/sidecar/all snapshot bytes compared. Expiring window fails the fixture. Initially red: Rust omitted CONFLICT prefix (`db4-backup.log`); b9c8193a fixes it. WAL refusal uses bad-key pre-open rejection and proves all three live files unchanged. An attempted unwritable-destination fixture showed frozen TS checkpoints/removes sidecars during cleanup, so maintenance-stage WAL byte-invariance is not claimed. Fixtures self-clean. No clock injection added.
- Added direct dependencies on already-workspace-used chrono (timestamp formatting) and rustix (safe free-space query); no new package versions, no unsafe, no product TypeScript or bun.lock changes.
- Restore path traversal, outside symlink, corrupt/truncated/different-schema candidates and swap failure injections remain untested. Restore's preview, prompt, undo, swap and shared status extraction remain to implement.
- Preserve inherited TS gate semantics when implementing restore/migrate: signal-zero is only a check, not a lock; a gateway owned by another user counts as stopped.
- `db migrate --to` Postgres copy remains explicitly out of scope. Its validation/gate/confirmation and post-yes unavailable diagnostic are also still to implement. No Postgres server started.
- B: refusals (pipe/no yes, PTY n, PTY empty, bad key) assert live DB/-wal/-shm and every body file byte-identical; these fixtures have absent sidecars. Success covers empty, rows/files, orphan-only, unwritable artifact parent, trimmed mixed-case PTY yes, future row preservation; human/JSON and whole-table results compared. No gateway gate added. Frozen unlink errors are swallowed: unremovable file remains, row removed, orphan count still 1. No known ordinary-input clear-bodies output difference; concurrent writer races, nonstandard rel_path normalization and deep artifact trees remain untested.
- Clear-bodies selects `at < now`, preserves future rows and re-checks orphan claims immediately before unlink. Snapshot/orphan enumeration and hostile-path edge parity need separate review if exposed beyond normal store-generated paths.

### Verification

Current gate counts: backup 24, vacuum 4, clear-bodies 10; five database control unit tests. Backup histogram: exit 1=7, unable-to-open=1, key diagnostic=3, exit 0=17. Existing clear-bodies disturbance/red evidence retained in db3 logs. Restore failure-state table remains entirely untested; candidate validation belongs to next part-one increment, other four rows to the swap increment. Restore and migrate remain unavailable.

Binary commit `450d2dec925bf71e0107daf911a7544b22781ef0`; `/tmp/opencode/e1-e5/db4-omni-final`, SHA256 `0856f783edff94ba4ce55f9fb2d9295bac47cd383712b53fdb2426714a0c772b`. Abort binary `db4-omni-final-abort`, SHA256 `a1af1bbc404b0ecf0a013c885a34c8fda0931324a46999ff387c59e1c4d85d0a`.
Final commit: offline tests 27 passed; clippy all-targets -D warnings and fmt passed (`db4-test.log`, `db4-clippy.log`, `db4-fmt.log`), incremental/debug=0. Foreground matrix once, 31/31 exit=0; summary read: `/tmp/opencode/e1-e5/db4-verified-summary.txt`; copied latest script as `db4-matrix.sh` (backup already registered). No nonzero matrix logs. Initial clippy caught ignored must-use panic result; append-only 450d2dec fixes it. Worktree clean; context checkpoint after items 1–2.

## Fix round 3: complete for review

Final HEAD **a097828dd6b7b7ba61f812edc573db2b929d5a7c**, branch
`feat/rust-cli-e1-e5`, clean. All final checks and the sequential matrix completed
in the foreground; every final log and both negative-test child logs read.
This section supersedes the historical round-2 completion claims below.

### Six requested items

| Item | Status / commits | Verification |
|---|---|---|
| a — every frozen configuration diagnostic | **DONE**, 335bd4db, ce3c7bf5, 68e58d2c | Seven source prefixes compared with the frozen loader by every histogram-gated suite; count of every `throw` also checked. Each diagnostic triggered through the frozen loader, matched plain and JSON-escaped, with seven distinct categories. Adding a scratch TypeError diagnostic fails (8 != 7). |
| b — same-exit substitution is permanent and automatic | **DONE**, 335bd4db, ce3c7bf5, 68e58d2c, **a097828d**, corrected **1bb8836a** | Normal `model-puts.ts` invokes config-gate automatically. Its scratch child changes only the `raw === "null"` case to cluster=true/database=invalid for both CLIs. Child still compares all302 cases and exits histogram93/200/9, but fails with the unexpected cluster category. Parent requires that precise failure. The inherited recursion-marker bypass was removed in 1bb8836a; the generated child instead has its automatic import removed with an exact occurrence assertion. Also run directly in the final matrix. |
| c — process driver rejects store/config errors | **DONE**, e288ed7b, 9350d14c | `storeError === null` required, including systemctl trace case. Normal12+argv/env passes; OMNI_TRACE_SAMPLE=bogus exits1 with no PASS. |
| d — abort driver proves actual hidden-input path | **DONE**, e288ed7b, 9350d14c | Identical-config status preflight plus kernel PTY packet evidence of flow control switching off/on; together with the single terminal-changing path in password.rs this establishes hidden-input execution, not independently every raw-mode flag. Abort build: exit1, restored=true, packet20 (DOSTOP). Bogus trace fails preflight; scratch removal of preflight still fails on missing packet. |
| e — mismatch preserves each prior database | **DONE**, 617620ba | Each independent CLI DB compared with the fixture copied before the command, every table. Reader17+mismatch passes. Deliberately differing scratch baseline fails the new assertion. |
| f — fd write error omits path | **DONE**, 7a491c1e | `setup-minors.ts` invokes full-disk.py to symlink the already-open temporary destination to /dev/full; exact TS/Rust transcript includes `ENOSPC: no space left on device, write` without path. Seven setup minors pass. Re-pointed reviewer repro independently passes. |

New continuation commits: ce3c7bf5 (source coverage in every gated suite and JSON
diagnostics); 9350d14c (raw-mode proof and final process guard); 68e58d2c (distinct
cluster categories and deliberate keys-list pins); a097828d (automatic substitution
guard in the ordinary model-puts suite). Append-only; product change in this round
remains solely the fd-write formatting change in 7a491c1e.

### Before-fix evidence and limitations of historical evidence

All paths below are under `/tmp/opencode/e1-e5/`.

- a/b: `r3-gate-red.log` is an intermediate source-extraction regex failure, **not**
  proof of the original missed cluster diagnostic. `r3-gate-green.log` passes.
  Independently replayed the old 8da3ac5b gate: disturbed model-puts falsely
  passed302; the new negative test failed because child exit was0
  (`r3-final-pre-b-oldgate.log`). Final child exits1 on the gate alone:
  `r3-final-model-puts-child.log` and `r3-final-config-gate-child.log`.
  `r3-final-pre-a-new-diagnostic.log` proves source drift is rejected.
- Initial final matrix at9350d14c failed keys-list: two intentional cluster
  errors were newly recognized but absent from its old pins. Confirmed the
  deliberate inputs at keys-list.ts251–252 and reproduced at617620ba; fixed in
  68e58d2c. See `r3-final-pre-keys-list-first-matrix-9350d14c.log`,
  `r3-final-pre-keys-list-617620ba.log`, and `r3-final-pre-keys-list-fixed.log`.
  A scratch swap of database-required for redis-required originally passed with
  the shared OMNI_CLUSTER_MODE category; distinct categories now reject it
  (`r3-final-pre-keys-list-swapped.log`).
- c/d: prior `r3-process-red.log` / `r3-abort-red.log` show false passes, but do
  not themselves record the injected environment. That provenance is **not
  independently observed from those logs alone**. Replayed pre-e288ed7b scripts
  with bogus trace: both exited0; current scripts exit1. Retained in
  `r3-final-pre-{c,d}-old-disturbed.log`, `r3-final-neg-process-alive.log`, and
  `r3-final-neg-password-abort.log`. The added packet assertion independently
  rejects early exit even without preflight (`r3-final-neg-password-abort-no-preflight.log`).
- e: no before-fix production failure independently observed; coverage
  strengthening. `r3-mismatch-green.log` passes. The deliberate baseline
  difference is rejected in `r3-final-pre-e-disturbed.log`.
- f: `r3-write-red.log` fails the exact no-path assertion; `r3-write-green.log`
  passes7. Independently replayed the reviewer repro with old and new binaries:
  `r3-final-pre-f-repro-old.log` fails with extra temporary path;
  `r3-final-neg-write-repro.log` matches both transcripts.

### Configuration diagnostics covered

Complete frozen loader messages (interpolated values shown symbolically):

1. `OMNI_ENCRYPTION_KEY must be set to at least 16 characters. Generate one with: openssl rand -base64 32`
2. `OMNI_PORT must be an integer between 1 and 65535, got "<value>"`
3. `OMNI_CLUSTER_MODE=true needs OMNI_DATABASE_URL to be a postgres:// URL`
4. `OMNI_CLUSTER_MODE=true needs OMNI_REDIS_URL`
5. `OMNI_DATABASE_URL and OMNI_REDIS_URL are cluster-mode settings; set OMNI_CLUSTER_MODE=true or unset them`
6. `OMNI_METRICS_MAX_SERIES must be a positive integer, got "<value>"`
7. `OMNI_TRACE_SAMPLE must be between 0 and 1, got "<value>"`

Source comparison checks message prefixes before interpolation, not complete diagnostic wording (suffix-only changes are not detected). Categories name all OMNI
variables in each prefix; the three cluster messages therefore remain distinct.
keys-list explicitly expects one database-required and one cluster-settings-off
diagnostic; model-puts expects neither. Nonfatal log-level/day-offset fallbacks
are not thrown configuration errors.

### Final checks on a097828d

Environment for all cargo commands: `CARGO_INCREMENTAL=0`,
`CARGO_PROFILE_DEV_DEBUG=0`, `CARGO_PROFILE_TEST_DEBUG=0`.

- `cargo test --offline -p omni-cli -p omni-control`: **22 passed, 0 failed**
  (CLI3 + control19; zero doc tests).
- `cargo clippy --offline -p omni-cli -p omni-control --all-targets -- -D warnings`: PASS.
- `CARGO_NET_OFFLINE=true cargo fmt --all -- --check`: PASS (fmt has no --offline flag).
- `cargo build --offline -p omni-cli --bin omni`: PASS, copied outside worktree.
- `cargo rustc --offline -p omni-cli --bin omni -- -C panic=abort`: PASS, copied
  separately for password-abort.py. Both are debug profiles without debug info.

Final matrix: **28/28 entries exit0**: 22 ordinary TS suites, config-gate directly
(also automatic inside model-puts), provider-catalog --check, and four Python
drivers. full-disk.py is exercised by setup-minors, not a standalone suite.
Other seam/helper files are not suites. Commands and environment are retained
in `r3-final-matrix.sh`; status in `r3-final-summary.txt`; logs named
`r3-final-<name>.log`. No histogram-recording override used.

| Suite | Final result |
|---|---|
| setup-minors | PASS7, including full-disk helper |
| setup-pins | PASS7 |
| setup-limits | PASS70 +12 parser |
| db-reads | PASS16 +3 rounding |
| password-bytes | PASS17 +1 mismatch |
| password | PASS30 +2 cancellation |
| password-cross | PASS10 real gateway checks |
| status | PASS64 +2 live +6 systemd |
| help | PASS470 +31 unavailable |
| plugin-refusals | PASS20 +TS error-channel check |
| setup | PASS600 +4 pre-prompt |
| keys-list | PASS135, all expected environment categories pinned |
| key-mutations | PASS156 +4 repair +3 usage +5 PTY +16 creation |
| settings | PASS347 +crossread |
| model-reads | PASS262 |
| model-removals | PASS47 |
| model-puts | PASS302 +automatic seven-diagnostic/substitution guard |
| model-catalog | PASS510 +12 refusals |
| date-boundaries | PASS40 |
| lone-surrogates | PASS44 |
| captured-summary | PASS1 frozen-control gate |
| setup-prompt-authority | PASS8 |
| config-gate (direct extra run) | PASS7 diagnostics +expected failing child |
| provider-catalog --check | PASS artifact matches frozen descriptors |
| process-alive.py | PASS12 +argv/env |
| status-rows.py | PASS4 |
| db-boundaries.py | PASS4 |
| password-abort.py | PASS1: code1, restored=true, packet20 |

### Binary provenance

All binary paths below are under `/tmp/opencode/e1-e5/`. Suite environment:
`OMNI_CLI_BIN=.../omni-r3-final` (abort driver uses `.../omni-r3-final-abort`),
`OMNI_GATEWAY_BIN=.../gateway-settled`, `OMNI_TS_GATEWAY_BIN=.../ts-gateway`.
Manifest and per-suite copies: `r3-final-manifest.json`,
`r3-final-<suite>.manifest.json`. Frozen CLI runs with Bun1.4.4 from unchanged
source. Gateway source provenance inherited from the earlier report; hashes
independently rechecked, gateways not rebuilt this round.

| Binary | Source commit | SHA256 |
|---|---|---|
| omni-r3-final | a097828dd6b7b7ba61f812edc573db2b929d5a7c | bddc4f1f5e004ff9c69099543facc6910d06accc8e6e7a5ca7e008c47c72e952 |
| omni-r3-final-abort | a097828dd6b7b7ba61f812edc573db2b929d5a7c | a7cdcaac3e0a609f42254fb5a5bfe623343dbfc28b0325499ce45cc8e20cd37f |
| gateway-settled | 01d1cf13639e0412229be43c04c4145ef32d79d7 | fa4e1c93191820d79fa934d28fd0eb853ca8ee7e21091fe0628854e9ea7bd2a1 |
| ts-gateway | a718ec0d4aa221162b04bab70194128e2c8c4858 | b34c2465dfadbad02c4bea8aedb93d25dc36c6adf1906580adaad43136f4aa7d |

Earlier diagnostic replay binaries: omni-r3-pre-abort at617620ba plus test-only
edits has the same a7cdcaac hash; omni-r3-write at7a491c1e product state has the
same bddc4f1f hash. Old omni-r2-final at8da3ac5b is
`b8c435d0174aea1b293b6f785b47f57d61437e012e51256c786a63bdc905a042`;
original-defect omni-abort-red at21a4e0b3 is
`9919b0458d87b81cbc3b6a5d84571e31fee0ca6f14980f82ef3d7ae98a9aa069`.

### Known limits / stop point

- Read-only-filesystem (EROFS) errors checked by inspection only.
- Two BLOB raw-cell cases remain tracked on the main branch:
  provider_data=X'7B7D' and quota used=X'313233'. No parity claim here.
- Process liveness treats permission errors as not running, exactly as TS.
- PTY packet proof is Linux-specific and requires default IXON start/stop
  characters, asserted by the driver. This verifies ordinary fallible-write
  restoration under panic=abort, not restoration after arbitrary abort/kill.
- No optimized release build or exhaustive uncommon-errno injection claimed.
- Golden scratch fixtures referenced by this round's logs are removed after
  recording results; binaries, logs, manifests, and copied negative-child logs
  are retained. Historical removed fixture paths in logs are not live artifacts.
- Backup/restore/vacuum/clear-bodies implementation remains the later task.
  No product TypeScript, bun.lock, unsafe code, push, merge, rebase, or amend.

# E1–E5 CLI track — partial handoff

## Fix round 2: complete for review

Fixed HEAD **8da3ac5b4eefe8592ea86021aba31c4ca8a8d41f**. Clean worktree.
Final matrix completed synchronously exit0; every log read. No pending jobs.
Stopping for re-review; no destructive database command landed. Historical
partial-round headings below are superseded by this section.

| Finding | Commits | RED → GREEN evidence |
|---|---|---|
| e1a R1 lossless metadata |d2284f51|Independent reviewer surrogate row, r2-metadata-red fails; status-rows final4 passes|
| e1a R2 unrelated logs |d0e30206|Independent reviewer text-at row, r2-quota-red fails; additive status_quota reads only quota; final4 passes|
| e5 R1-I1 DB vacuity |e6bd4461,370e32d8,12132c39,8da3ac5b|Invalid-port falsely PASS16 reproduced; strengthened DB suite fails it; final initialized16, halfway3, missing/locked4 pass|
| e5 M1 operation errors |028eddb2,5d15cd68,8da3ac5b|Local read-directory/read-denied RED; final6 prototype/mkdir/read-directory/read-denied/write-denied/rename-directory comparisons pass; latter two coverage-only GREEN on existing product fix|
| e5 rounding |ba9e0416|1280-byte independent halfway RED; final3 halfway comparisons pass, common stats/snapshot formatter|
| e1a password minors |a2383db7|Mismatch exact message/hash absence/DB comparison and password whole-DB comparison pass; coverage strengthening, no product RED claimed|

Existing control/store readers unchanged except additive quota API authorized
by ruling. Lossless JsValue retained through metadata selection and JSON output.

### Final twelve-suite audit and pinned TS exit histograms

Histograms below are `(exit0,exit1,exit2)` of actual frozen TS subprocesses,
including ancillary probes; nested PTY child exit counts, not wrapper exits.
Thus settings348 includes one extra direct TS crossread; model-catalog513
includes ancillary frozen TS probes. Explicit goldenSpawn wrapper intercepts
the actual call site (unlike the earlier ineffective monkeypatch), tees streams,
and checks pinned histograms after all cases. It additionally pins configuration/
environment-error category counts. No unexpected added category/count can pass.
The expected exceptional categories are explicit in exit-histograms.json:
keys-list database-open1,port2,trace1,key1,metrics1; model-catalog key3/port2;
db-reads key8. All other gated suites expect zero such errors.

|Suite|Why invalid port originally passed; final guarantee|
|---|---|
|password-cross|Overrides port18449; asserts CLI exit0, HTTP200/401, auth/session behavior; histogram not needed for explicit expected cases|
|help|Config-independent; histogram **464,0,6**, exact bytes; unavailable31 each exit1|
|plugin-refusals|Refusal before config;20 exact refusal cases, side-effect/request checks and explicit TS exit2|
|keys-list|Strips OMNI vars; histogram **91,37,7** plus pinned expected env errors; injected-after-filter disturbance fails|
|key-mutations|Strips OMNI vars; histogram **115,34,45**; injected-after-filter disturbance fails|
|settings|Inherited invalid port actually failed commands; previously vacuous; histogram **210,68,70**, rejects unrelated port failure|
|model-reads|Same confirmed manual TS failure; histogram **163,95,4**, rejects unrelated port failure incl PTY|
|model-puts|Same confirmed --from-catalog TS failure; histogram **93,200,9**, rejects unrelated port failure|
|model-removals|Same confirmed TS rm failure; histogram **20,23,4**, rejects unrelated port failure incl PTY|
|model-catalog|Strips OMNI vars; histogram **360,19,134** plus pinned key/port error counts; injected-after-filter disturbance fails|
|lone-surrogates|Strips OMNI vars; successful-command count plus API expected200 and lossless durable-state assertions; disturbed run fails; not an open histogram target in final ruling|
|captured-summary|Direct frozen control test, no CLI config; asserts returned true and persisted false under competing write|

Other requested histograms: date-boundaries **6,0,34**; db-reads **11,8,0**.
Disturbance copies at `/tmp/opencode/e1-e5/r2-final-disturb/` use source-edited
explicit wrapper to inject invalid port after each suite's env filter. All three
keys-list/key-mutations/model-catalog exit1; logs/results retained. This replaces
the earlier inconclusive monkeypatch experiments. Frozen sources never edited.
Recording runs use explicit OMNI_RECORD_HISTOGRAM=1 only for collection; final
matrix runs without it and verifies committed pins exactly.

### Final gates and counts

Offline tests omni-cli3 +omni-control19 = **22 passed,0failed**. Strict offline
all-target clippy for both touched crates and workspace fmt PASS. CLI is built
with panic=abort (debug profile, not optimized release). All22 TS suites plus
4 Python regression drivers in one completed matrix PASS; catalog --check PASS.
Final log prefix `/tmp/opencode/e1-e5/r2-final-`:

setup-minors6; setup-pins7; setup-limits70+12parser; db-reads16+3rounding;
password-bytes17+1; password30+2; password-cross10gateway;
status64+2live+6systemd; help470+31unavailable; plugin-refusals20;
setup600+4; keys-list135; key-mutations156+4repair+3usage+5PTY+16creation;
settings347; model-reads262; model-removals47; model-puts302;
model-catalog510+12refusal; date-boundaries40; lone-surrogates44;
captured-summary1gate; setup-prompt-authority8; process-alive12+argv/env;
password-abort1 (exit1/restored=true); status-rows4; db-boundaries4.

Every final driver has r2-final-<suite>.manifest.json with fixed HEAD and hashes:
CLI omni-r2-final **b8c435d0174aea1b293b6f785b47f57d61437e012e51256c786a63bdc905a042**;
Rust gateway fa4e1c93191820d79fa934d28fd0eb853ca8ee7e21091fe0628854e9ea7bd2a1
(earlier01d1cf13); TS gateway b34c2465dfadbad02c4bea8aedb93d25dc36c6adf1906580adaad43136f4aa7d
(frozen a718ec0d). Frozen CLI runs Bun1.4.4 source. Histogram collection and
scratch disturbance runs used productionba9e0416 omni-r2-round SHA
a1667b69d0a9f2ae6e473ebe039f409bcffdcdaed19b67aab8fdb73542455eef,
at HEADa2383db7 plus test edits subsequently committed8da3ac5b. Existing earlier
per-run mappings below remain applicable. No final binary changed during matrix.

### Known limits / inherited behavior

- EROFS and disappearing-path ENOENT inspected through common formatter, not
  fault-injected. Six reproducible setup cases passed; only temporary-file PID
  masked for write/rename errors, operation and both paths compared.
- BLOB provider_data=X'7B7D' (TS parse error) and quota used=X'313233'
  (TS object with indexed bytes) remain main-branch raw-reader followups, expressly
  outside this round. No claim those cases match.
- Liveness returns false on EPERM exactly as TS; not a maintenance lock.
  A gateway owned by another user counts as stopped. No process-group signaling.
- Authorized interactive multi-prompt completion remains; terminal restoration
  verified for ordinary failures, not allocation abort/forced termination.
- Snapshot/stats may initialize/migrate missing DBs as TS does; not physically
  read-only. Destructive DB group remains postponed until re-review.

## Fix round 2 latest partial: a2383db7 — audit not yet closed

All background jobs finished and results read. Current worktree clean. NOT
complete-for-review: audit guarantees for stripped-env suites remain unresolved;
final all-suite matrix on current commit not yet run. No destructive DB work.

Additional commits:
-12132c39: success-count guarantees for settings/model reads/removals/puts,
 keys-list/model-catalog/lone-surrogates; unrelated port errors explicitly fail
 the four inherited-env suites. Invalid-port reruns now fail for those four;
 ordinary runs PASS347/262/47/302. Additional ordinary keys135/catalog510/
 lone44 PASS. These counts prevent total early-failure vacuity but are not yet
 per-case expected-status guarantees; audit needs further hardening.
-5d15cd68: separate File::open/read_to_end and create/write_all so formatter
 reports actual failed operation. Read-denied independent RED→GREEN; setup-minors4
 PASS. Existing unified formatter maps EISDIR/EACCES/ENOENT/ENOTDIR/EROFS for
 every operation; rename retains from→to. Actual EROFS remains inspection-only.
-ba9e0416: byte formatting uses Number conversion then integer tenths with
 ties-up rounding for power-of-two KB/MB divisors. Local1280-byte RED→GREEN;
 db-reads16 +halfway3 PASS. Shared bytes helper also renders stats.
-a2383db7: password.ts compares all other tables in addition to verified-hash
 settings; mismatch test pins exact message. Password30+2/reader18 PASS.

Current focused gates: offline CLI+control tests22PASS, all-target strict clippy,
workspace fmt PASS (`r2-current-*`). Final matrix still required.

### Twelve passing invalid-port audit results — source checked

|Suite|Why exit0 / guarantee status|
|---|---|
|password-cross|Overrides port18449; asserts CLI exit0 and HTTP200/401 plus cookie/session behavior. Nonvacuous.|
|help|Help bypasses config; byte-equal frozen oracle and explicit unavailable exit1. Needs explicit expected success count for help rather than equality alone.|
|plugin-refusals|Refuses before config; exact refusal outputs/state/no-request checks, TS exit2. Nonvacuous refusal suite.|
|keys-list|Strips OMNI_*; added non-help success count, but disturbance below still exits0; guarantee needs investigation.|
|key-mutations|Strips OMNI_*; creation checks rows/secret and listing exit0, PTY wrapper exit0; broad156 matrix equality-only. Disturbance still exits0; audit OPEN.|
|settings|Inherits invalid port; manual TS settings get exits1 config error. Was vacuous; now rejects unrelated port error and requires successful non-help operations.|
|model-reads|Inherits invalid port; manual TS models list exits1. Was vacuous; now rejects port error (including PTY hex) and requires successful non-help operations.|
|model-puts|Inherits invalid port; manual TS models put pool --from-catalog openai:gpt-6-astra exits1. Was vacuous; now rejects port error and requires successful non-help operations.|
|model-removals|Inherits invalid port; manual TS models rm pool --yes exits1. Was vacuous; now rejects port error and requires successful non-help operations.|
|model-catalog|Strips OMNI_*; added non-help success count and existing plugin expected exits; disturbance still exits0, so audit OPEN.|
|lone-surrogates|Strips OMNI_*; added successful-command count, existing API200/auth assertions. Injected disturbance exits1 on failed parity/API assertions.|
|captured-summary|No CLI/config load: directly invokes frozen control/store; asserts returned smartRouting=true and durable false. Nonvacuous control-only oracle.|

Manual frozen-CLI evidence r2-manual-port.json/r2-manual-put.log. First put
attempt used invalid --targets and hit parser exit2; corrected --from-catalog
repro verifies config exit1. Do not cite first attempt as config evidence.

Scratch disturbance copies only under /tmp/opencode/e1-e5/r2-disturbance/:
absolute frozen imports retained, Bun.spawn wrapper substitutes --db /proc/1/mem;
second variant injects invalid port after suite env stripping. keys-list,
key-mutations, model-catalog still exit0; lone-surrogates exits1. Need verify
wrapper interception actually reaches children before interpreting: Bun may
optimize static Bun.spawn access. No assertion disturbance succeeded for first
three. All executions ended, no timeout reported. Scripts/logs retained.

Provenance r2-continuation-manifest.json: audit fixes and manual valid reruns use
omni-r2-quota productiond0e30206 SHA3444ccf7b5d40a7c818aa7154f83e48ba2bd9811bd548eeebd158dd0b0bdc695;
read-denied RED same. FS GREEN and rounding RED use omni-r2-fs precommit5d15cd68
SHA c066d73a72667cf694b89f57548e0cf2fec8f19976f06e77dc2d92ee4f12f14f;
rounding GREEN/password runs use omni-r2-round precommitba9e0416 SHA
a1667b69d0a9f2ae6e473ebe039f409bcffdcdaed19b67aab8fdb73542455eef.
CLI source fixtures/driver revisions described by commits above; TS CLI frozen.

Precise next: finish audit using scratch SOURCE replacements at actual spawn
argument/environment sites, not monkeypatch ambiguity; require per-case expected
codes or fixture-specific assertions across keys/catalog/key mutations/help and
four inherited-env suites. Extend filesystem reviewer cases write-denied/rename
directory with PID-only temporary-path normalization. Final committed-tree tests,
clippy/fmt and all suites with manifests; wait/read results; only then mark
Fix round2 complete-for-review and STOP. BLOB cases remain excluded as ruled.

## Fix round 2 — partial at370e32d8, items1–2 landed, item3 audit running

Read both r1 reviews completely and progress.md rulings727–728. Actual starting
HEAD was2174b79b (later than reviewed bf86d897); no history rewritten.

| Finding | Commit | RED/GREEN |
| --- | --- | --- |
|1 metadata lossless carrier|d2284f51|status-rows.py extended with reviewer lone-surrogate row; r2-metadata-red.log fails on old binary; GREEN3|
|2 unrelated log dependency|d0e30206|reviewer text-at row added; r2-quota-red.log fails; GREEN4 + status72|
|3 DB-suite vacuity assertions|e6bd4461|OMNI_PORT=invalid falsely PASS16 recorded r2-db-vacuous-red.log; intended runs GREEN16 with explicit codes/fields and independently reset before/after DB|
|3 missing/locked DB coverage|370e32d8|db-boundaries.py GREEN4 (coverage addition; no production RED claimed)|
|3 all-suite invalid-port audit|pending|background job sh_1d5581396001GtF2zalCcU12u3; results file written at completion|
|4 operation-aware filesystem|pending|round1 fixes retained; read-denied still labels operation read instead of open; complete with reviewer cases|
|5 JS fixed rounding|pending|1280-byte half-way repro remains|
|small mismatch/password full DB|pending|mismatch hash absence/whole DB already present; explicit mismatch message and password.ts whole DB still needed|

Item1 retains JsValue from control parsing through field selection and JSON
output. Unused provider metadata never enters serde. Human rendering uses only
the already-selected projection. Item2 adds ONLY a new status_quota API in
omni-control/credentials.rs; existing readers unchanged. This reads quota_windows
alone, exposes raw JsValue, and avoids health/burn/settings/request-log reads.
Both BLOB cases deliberately remain shared-reader/main followups per ruling.

DB read commands create/migrate missing DBs, inherited TS behavior; missing
case asserts schema/migrations rather than claiming no writes. Locked cases
assert exact exit1/database-is-locked and unchanged independent baseline.
Missing-case comparison normalizes only generated migrations.applied_at to0
after success; all other logical cells compare. Existing initialized16 cases
use fresh fixture copies per CLI, pre-invocation baseline, expected code/error,
snapshot count/size/date type, stats engine/location/schema/tables/body size.

Verification so far: offline CLI+control tests **22passed/0failed**; strict
all-target CLI+control clippy and workspace fmt PASS. Focused status4+72,
db16+4 PASS. Final full gates NOT run yet; round2 NOT complete-for-review.
No destructive DB work. No store-reader/frozen TS/bun.lock edits.

Driver provenance `/tmp/opencode/e1-e5/r2-provenance.json`:
- metadata RED: exact2174b79b omni-review-final SHA256 b68610e0f7239bd14a4ae79478f14b83508d891ecfbf12e9f30e78675a1b7ee1.
- metadata GREEN/quota RED: omni-r2-metadata, precommit changes committedd2284f51, SHA256 fc0d32dfd4c82a933178639dc21d23753ee27fc450b3285821d13718f7d78e09.
- quota GREEN/status72/db-vacuity RED/db16GREEN/db-boundaries4/audit: omni-r2-quota, precommit changes committedd0e30206, SHA2563444ccf7b5d40a7c818aa7154f83e48ba2bd9811bd548eeebd158dd0b0bdc695.
Python/DB drivers each save HEAD/hash; audit r2-invalid-manifest.json records
its initial HEAD and hash. TS CLI is unchanged frozen source.

Precise next step: await automatic audit completion (no polling), read
r2-invalid-results.json and ALL r2-invalid-<suite>.log, list each suite result
here, fix any vacuous pass with expected result/baseline assertions. Distinguish
intentional config-independent help/refusal tests and suites overriding port
from cases that never exercised the command. Audit child timeout120s recorded
as timeout, not PASS; check leftover children before subsequent shared suites.
Then item4 reviewer r1-probes.ts filesystem tests, item5 halfway bytes, small
password items, final offline gates and per-driver manifests. Mark round2
complete only when all requirements pass, then STOP for review.

## Fix round 1: complete for review

Fixed review HEAD **2174b79b67527aca5786196b10a659a541b85aae**. Worktree clean;
all final gates completed, no running jobs. Stopping for independent re-review
as requested. No destructive DB command has landed. Earlier partial-status
headings below are historical and superseded by this section.

| Finding | Commits | Evidence / independent RED |
| --- | --- | --- |
| e1a I1 process liveness |21a4e0b3; systemctl11f42713| Independent reviewer probe and local process-alive RED; final12 + argv/environment trace PASS |
| e1a I2 abort/raw terminal |9af65b0e| Independent panic.py mechanics: RED SIGABRT/restored=false; final abort build exit1/restored=true |
| e5 I1 pin identity |a020a844| Independent reviewer fixture RED272000 vs922000; both directions fixed, final7 pin cases PASS |
| e5 I2 catalog suite |0033583f;2174b79b| Old fixture existence assertion RED; final70 limits +12 parser checks; general setup fixture now gpt-6-astra |
| e1a I3 status readers |961e035c| Independent malformed metadata RED; final2 malformed-row/whole-DB goldens PASS (raw used='bad' included) |
| e5 M1 filesystem |df517c33;028eddb2| Reviewer mkdir RED; local read-directory RED against prior binary; final TS EISDIR omits path, ENOTDIR includes mkdir/path |
| e5 M2 __proto__ |df517c33| Independent reviewer-derived local RED; omitted generated entry GREEN |
| e1a suite minors |bf86d897;2174b79b| Coverage hardening; expected codes/fields, per-case fixtures, whole DB, pidfile effects; no independent production RED claimed |

Authorized integration merge67d3ef78 imported9624fa13, no conflicts. Store
reader code was not edited locally. Final status uses existing shared control
metadata/raw quota JSON, not private SQL. Exact malformed-row outcomes match.

### Final fixed-commit verification

Offline `cargo test -p omni-cli -p omni-store`: **154 passed /0 failed /5 ignored**.
Offline strict all-target clippy for both crates, workspace fmt PASS. CLI built
with panic=abort via cargo rustc; every final CLI suite uses that binary.
This is a debug-profile abort build, not an optimized release build. PG tests
without configured URL may return early; no live-PG claim. Catalog --check PASS.

All22 TS drivers and3 Python regression drivers completed exit0. Per-suite:
setup-minors3; setup-pins7; setup-limits70+12parser; db-reads16;
password-bytes17+1mismatch; password30+2cancellation; password-cross10gateway;
status64+2live+6systemd; help470+31unavailable; plugin-refusals20;
setup600+4preprompt; keys-list135; key-mutations156+4repair+3usage+5PTY+16creation;
settings347; model-reads262; model-removals47; model-puts302;
model-catalog510+12refusal; date-boundaries40; lone-surrogates44;
captured-summary1gate; setup-prompt-authority8; process-alive12+1argument/env
trace; password-abort1; status-rows2. Logs read: review-final-*.log.
Also reconciled bf86d897 full22-suite matrix, all PASS (setup-minors then2).

### Final binary/run provenance

Every final driver has review-final-<suite>.manifest.json copied from
`/tmp/opencode/e1-e5/review-final-manifest.json`: commit2174b79b, panic=abort,
CLI `omni-review-final` SHA256
**b68610e0f7239bd14a4ae79478f14b83508d891ecfbf12e9f30e78675a1b7ee1**.
Rust gateway earlier01d1cf13 SHA256
fa4e1c93191820d79fa934d28fd0eb853ca8ee7e21091fe0628854e9ea7bd2a1;
TS gateway frozen a718ec0d SHA256
b34c2465dfadbad02c4bea8aedb93d25dc36c6adf1906580adaad43136f4aa7d.
TS CLI executes frozen source via Bun1.4.4. Python drivers also emit their own
per-run commit/hash manifest. Source/binary annotations for earlier runs below.
Latest focused runs: setup-read RED used bf86d897 binary55029bcf8ece0ebca495416c946d563baf0fceaf93f9975bd08709122bbf598d;
setup-read GREEN and final-strength password/status/setup used production028eddb2
precommit binary `omni-setup-read`9f37e9eb7f30fab34c4861ea81c0b12a5aade83b86045a0b80d728828033dc8e.
Intermediate failed read-format attempt not retained; exact per-attempt retention
is incomplete as already disclosed. Final fixed-commit provenance is complete.

### Known differences / review concerns

- Authorized intended multi-prompt completion remains; oracle uses frozen prompt
  injection seam. EPERM-as-dead and __proto__ omission are inherited TS quirks.
- No panic=abort Drop guarantee: ordinary fallible I/O restores through guard;
  allocation failure or forced termination cannot be guaranteed to restore.
- Status shared control health reader additionally reads health/settings/logs;
  broader malformed unrelated-row behavior remains a review concern. Store's
  typed QuotaWindow still coerces used='bad' toNaN; raw control projection is
  necessary for TS JSON parity. No store patches made.
- Filesystem formatting covers common Linux errnos; rare unmapped errnos retain
  Rust fallback. Read-directory and mkdir failures have exact goldens; write/
  rename formatting follows same formatter but lacks exhaustive fault injection.
- General PID/systemd broad suite plus dedicated process suite cover required
  cases; no actual live systemd service was managed (fake executable fixture).

STOP here for fix-round re-review. Backup/restore/vacuum/clear-bodies remain
unimplemented; future gateway refusals must reuse shared process::alive.

## Fix round 1 — partial, items 1–2 committed; authorized main merge complete

### Latest HEAD bf86d897 — d/e progress, final matrix pending

Refreshed pins-final matrix completed exit0, all21 logs read: prior baseline
counts unchanged plus setup-pins7; limits70+12 now has concrete catalog/exit
assertions. pins-tests.log CLI3 passed. No post-merge failure found.

- d → `961e035c`: status uses existing shared control credentials::list and
  credentials::health JSON readers, eliminating private SQL. Independent review
  probe/quota mechanics reproduced in status-rows.py. RED on omni-setup-pins
  (`status-rows-red.log`); GREEN2 malformed-row/whole-DB comparisons, status72,
  strict CLI clippy PASS. provider_data='{' emits exact TS JSON parse error;
  used='bad' is retained as string. No omni-store code changed.
- e production subset → `df517c33`: omit __proto__ generated model entry;
  mkdir error ENOTDIR uses TS code/description/operation/path. Reviewer-derived
  setup-minors.ts RED against prior binary, GREEN2. RED stopped at prototype,
  so mkdir RED is independently established by reviewer evidence, not a second
  local failing run. Formatter handles common errno values; other filesystem
  operations still have original error formatting and require completion.
- e suite strengthening → `bf86d897`: password reader asserts every expected
  exit, hash absence on cancellation, independent per-case DB clones, whole-DB
  comparison with only verified hash value masked. Initial whole-DB comparison
  caught migration timestamp differences; fixed by cloning one initialized
  fixture rather than masking. status matrix resets DB before each invocation,
  asserts code/process/admin/account/error fields, whole-DB preservation and
  pidfile contents/deletion. Systemd matrix asserts expected state/pid/codes.
  Password18 + status72 PASS. Coverage hardening, not an independent production
  RED; further assertions for live gateway and mismatch DB still desirable.

Shared-reader limitation recorded as instructed: store quota::list coerces
`quota_windows.used='bad'` to NaN in QuotaWindow.used:f64; serializing that typed
view cannot print TS `"used": "bad"`. Existing shared control health reader
preserves the raw scalar, so status uses that. It also reads health/settings/
request_logs for its fuller projection; malformed unrelated fields may expose
additional status differences. This needs review; no claim all raw-cell cases
are equivalent. Store readers were not patched.

Current exact binary bf86d897 `omni-fix1-latest` SHA256
55029bcf8ece0ebca495416c946d563baf0fceaf93f9975bd08709122bbf598d.
Status GREEN binary `omni-status-rows` built before961e035c:
6f0fd6f17ebc35938c0aee42db077e88c1b99d2c06e8fd176519a1101f17fc3a.
Setup minor GREEN and suite strengthening use omni-setup-minors (production
df517c33), same55029... hash as latest. Status RED uses a76a3de315f464f3559c1212fe343ea96a9b5fcef2061eee9ca9fd03ed349d05 froma020a844. Setup minor RED uses6f0fd... .
Source/hash mapping and gateways in fix1-latest-manifest.json; each final TS
suite gets a matching manifest. Python status-rows emits per-run manifest.

Current gates: CLI3 tests, strict all-target CLI clippy, workspace fmt PASS.
Full22-suite matrix running immutable latest binary, shell
`sh_1d53060b0001bN36fG9i5QsTjn`, logs fix1-latest-*.log. Do not build/run
shared-scratch suites until it ends. NOT marked complete-for-review yet.

Precise next: reconcile that matrix, finish remaining filesystem operation
diagnostics and suite expected-state gaps; run status-rows/process-alive and
panic=abort regression on final tree, then final gates as needed. General
setup.ts absent catalog fixture also remains. No destructive DB commands;
stop for review when genuinely complete. Worktree clean atbf86d897.

### Latest continuation: a–c committed, d/e next; NOT complete for review

HEAD `0033583f`; clean worktree. Do not start destructive DB work: operator now
requires stopping for fix-round re-review after a–e and all gates are complete.

Post-merge baseline67d3ef78 completed exit0 and all logs read:
db-reads16; password-bytes17+1; password30+2; password-cross10;
status64+2live+6systemd; help470+31unavailable; plugin-refusals20;
setup600+4; setup-limits70+12parser; keys-list135;
key-mutations156+4repair+3usage+5PTY+16creation; settings347;
model-reads262; model-removals47; model-puts302; model-catalog510+12refusal;
date-boundaries40; lone-surrogates44; captured-summary gate1;
setup-prompt-authority8. Additional process11 and catalog --check PASS.
Rust tests154 passed/0failed/5ignored. Logs and binary manifests remain
`/tmp/opencode/e1-e5/fix-round1-merge-*` (source67d3ef78, CLI SHA256
868c00426f04d310e44c294cc4ea1fbb9aa10d78cfcddf85b8312c64fe0ed672).
These limits70 were the old weak suite, not evidence against the review finding.

| Follow-up | Commit | RED / GREEN |
| --- | --- | --- |
| a systemctl goldens | `11f42713` | Existing independent no-kill RED from item1; expanded tests are coverage-only, no new behavior defect/RED claimed.12 comparisons + exact argument/environment trace PASS |
| b item3 serving-account identity | `a020a844` | Independent review-derived setup-pins.ts RED:272000 !=922000; both directions GREEN2 |
| c item4 meaningful catalog limits | `0033583f` | New catalog existence assertion RED against old gpt-5 fixture (`limits-fixture-red.log`); corrected real catalog fixtures GREEN70+12; expanded enabled/disabled/missing/custom endpoint/nonstring endpoint pins GREEN7 |
| d item5 shared status readers | pending | Next item; no status implementation changes yet |
| e item6 minors | pending | Filesystem/__proto__/password+status expected state assertions pending |

Frozen systemctl authority exact references: apps/cli/src/runtime.ts:7–14
spawns argv with inherited environment/cwd/PATH and collected pipes;
service.ts:71–72 supplies --user except system scope; service.ts:163–177
defines is-active/show calls and stdout/stderr/unknown precedence independent of
exit code. Missing executable propagates to CLI error exit1. Unexpected output
is reported literally, never active unless exactly "active". Test now asserts
missing message, nonzero state, unexpected text, exact argv, inherited sentinel.

Setup now calls omni_router::serves_target via an identity-only adapter to the
existing Target/Credential types. It retains lone UTF16 endpoint identity and
uses dummy unused routing fields; no third endpoint comparison implementation.
Added existing workspace omni-router dependency offline (Cargo.lock only adds
CLI dependency). Both reviewer directions pass, plus disabled/missing/custom
and unusable account endpoints. Limits matrix now asserts fixture existence,
nested exit0, concrete context/output values, absent limits only for deliberately
unknown provider, exit2 for parser errors, and whole DB preservation. Expanded
matrix exposed no additional production defect beyond item3. General setup.ts
still seeds absent gpt-5: update that fixture as part of remaining suite minors.

Verification so far: CLI3 unit tests, strict all-target CLI clippy, fmt and
Biome for changed TS suites PASS. Full refreshed matrix running on immutable
`omni-setup-pins` as shell `sh_1d524ebf0001uWnA40dM5EhrAT`; no full-final
success claim until notification/log reconciliation. No build/shared-scratch
suite until that job ends. It includes new setup-pins suite.

Run provenance: systemctl-expanded-green and setup-pins RED use merged67d3ef78
binary868c00426f04d310e44c294cc4ea1fbb9aa10d78cfcddf85b8312c64fe0ed672.
setup-pins GREEN, limits fixture RED, limits GREEN, expanded pins GREEN and
refreshed full matrix use omni-setup-pins SHA256
a76a3de315f464f3559c1212fe343ea96a9b5fcef2061eee9ca9fd03ed349d05,
production a020a844 built before commit; later0033583f only tests. Per-run
Python/TS manifests and pins-final-<suite>.manifest.json retain HEAD/hash;
pins-final-manifest.json annotates production source. Intermediate unsuccessful
first adapter attempt used shallow(data), losing endpoint; corrected to project
only endpoint before GREEN. That overwritten intermediate binary is not retained.

Exact next step after matrix: item5 RED with reviewer part2/probe.py and quota.py
redirected to fresh scratch. No edits to omni-store readers permitted. Shared
control `omni_control::credentials::list` returns JSON with providerData parsed
using operator_json (exact TS error), and `credentials::health` exposes raw quota
JSON. Inspect API fit before using health since it also reads health/settings/logs.
Merged store QuotaWindow still stores used as f64 (coerced); direct serialization
cannot preserve used='bad'. Report that exact remaining store projection gap
with TS output if needed; do not patch store. Prefer existing raw control reader
if its extra reads preserve status behavior. Then complete item6, gates, mark
complete-for-review ONLY if all pass, and STOP for user review.

Continuation systemctl authority: frozen runtime.ts runCommand uses Bun.spawn
with inherited cwd/environment/PATH, collecting stdout/stderr/exit. service.ts
status runs `systemctl --user is-active omnigateway.service` and then
`systemctl --user show omnigateway.service --property=MainPID --value`; system
scope omits --user. Nonzero exits still yield state=trim(stdout)||trim(stderr)||
unknown; running only for exactly active. PID is positive integer Number(stdout).
Missing executable throws through status to CLI exit1, no status object. Existing
item1 suite pins missing/nonzero behavior; extension adds unexpected text,
explicit state assertions, inherited environment and exact argument trace.
Post-merge matrix still active during this inspection; no build or conflicting
suite started. Counts will be finalized on completion, not inferred from partial
logs. Item3 regression prepared from independent review but not executed yet.

Current HEAD `67d3ef78bdc6be804f64f86279cefb48ac1f6e7e`. Worktree clean.
Read both independent reviews completely and final progress.md rulings684/686.
Destructive DB work paused per operator; none enabled.

| Finding / item | Commit | Independent RED → GREEN |
| --- | --- | --- |
| e1a I1 process-alive / item1 | `21a4e0b3` | Review part2/probe.py executed with only paths redirected: no-kill returned running in TS, stopped and deleted live pidfile in Rust. Committed process-alive.py also RED on57cba4e1 (`fix1-independent-red.log`), GREEN11 |
| e1a I2 raw-mode abort / item2 | `9af65b0e` | Review panic.py mechanics in committed password-abort.py: abort binary exits-6/restored=false (`fix2-red.log`); fixed abort binary exits1/restored=true (`fix2-green.log`) |
| Authorized merge of9624fa13 | `67d3ef78` | `git merge --no-ff --no-edit 9624fa13`; no conflicts, no manual outside-owned-file edits |
| e5 I1 / item3 | pending | NEXT: reuse router serves_target; independent review probe not yet rerun here |
| e5 I2 / item4 | pending | limits fixtures/assertions remain review-defective |
| e1a I3 / item5 | pending | merged store readers available; do not edit their credential/health/quota implementations |
| minors / item6 | pending | filesystem diagnostics, __proto__, suite assertions/state checks |

Item1: rustix process feature resolved/builds offline. Shared
`crates/omni-cli/src/process.rs::alive` uses signal-zero, no subprocess/PATH.
EPERM is false as frozen TS (inherited quirk). Linux PID1 EPERM fixture verified
with Python os.kill before both CLIs. Suite11: live/no PATH, ESRCH, EPERM,
zero/negative/nonnumeric/huge PID strings, missing systemctl, nonzero systemctl
with stderr and empty output. Invalid pidfiles remain; valid-but-dead are deleted.
Huge finite integer pidfiles now retain JS numeric parse semantics so they are
probed/refused and removed, not silently retained by a u64 parse cap.
Missing systemctl returns TS's `Executable not found in $PATH: "systemctl"`;
nonzero results use stdout/stderr/unknown like frozen service.ts. Other spawn
errors still use Rust error display and need broader diagnostic coverage.
All future DB running-gateway checks must use the shared liveness function.

Item2: raw-mode prompt writes are fallible; UTF8 prefix expect and indexing
replaced with checked accesses; errors return through Termios guard. Dispatcher
error reporting is fallible too, preventing a second abort on closed stderr.
**Correction superseding prior report claims:** Drop restores during unwind,
NOT panic=abort. There is no general panic/abort restoration guarantee. The
ordinary stderr-failure path now returns normally and restores before exit1.
Verified with `cargo rustc --offline -p omni-cli --bin omni -- -C panic=abort`,
not a full optimized release build. Allocation failure/forced termination are
not restoration guarantees. Reader18 regression comparisons pass on abort build.

### Verification and provenance

At exact committed9af65b0e: CLI3 tests, strict offline all-target clippy and fmt
PASS; full existing CLI matrix PASS: 3,165 ordinary comparisons (prior3149+D16),
gateway10, unavailable31, plugin20/provider12, frozen prompt8/captured-summary;
new process11 and abort1 separately PASS. Existing setup-limits70 is still
vacuous for catalog branches per review; passing it does not resolve item4.
Logs `fix-round1-final-*.log`; each TS driver run has matching manifest.

At merge67d3ef78: `cargo test -p omni-cli -p omni-store` reports **154 passed,
0 failed, 5 ignored** (CLI3 included). PG tests may return early without a test
URL: no live PostgreSQL verification claimed. Scoped all-target clippy for both
crates and workspace fmt PASS. Process11 and catalog --check PASS. Full merged
CLI matrix launched as `sh_1d5191295001BbLGYFHVUkODMA`, completion pending.
Both earlier DB broad jobs completed exit0; their immutable binary manifests
remain in db-regression-* and db-date-regression-*.

Binary SHA256s and run/source mapping:
- item1 RED: omni-db-date,57cba4e1, `b86555083187750dcec6d5cc594527be75bf3d41b5fbae28cd43b57605c13f1b`.
- item1 GREEN: omni-process, changes committed21a4e0b3 (preformat build), `40b0389b7adf19cfae4f9ac621133a4da894b7d330f55264c0d2804314c40280`.
- item2 RED: omni-abort-red,21a4e0b3 with panic=abort, `9919b0458d87b81cbc3b6a5d84571e31fee0ca6f14980f82ef3d7ae98a9aa069`.
- item2 GREEN/reader/status: omni-abort-fixed, item2 source before unused-binding rename committed9af65b0e, `a5e3804081ff5f93fd108adacf2e548ae00c1d26a77deed4907177c9e9ae28ed`.
- exact9af65b0e abort binary/full matrix/process/abort: omni-fix-round1-partial, `800b8006709a2399cafcaa3971e89d78bcd29ffad2a05dcf9aab6cdeea1ad690`.
- exact merge67d3ef78/full merged matrix/process: omni-fix-round1-merged, `868c00426f04d310e44c294cc4ea1fbb9aa10d78cfcddf85b8312c64fe0ed672`.
- Full mapping: `/tmp/opencode/e1-e5/fix-round1-provenance.json`,
  `fix-round1-final-manifest.json`, `fix-round1-merge-manifest.json`, plus
  per-suite copies and Python per-run manifests. Initial item1 draft check
  caught huge-PID retention before the final correction; that intermediate
  executable was overwritten, so its manifest hash exists but binary not retained.
- Gateway hashes unchanged: Rust fa4e1c93191820d79fa934d28fd0eb853ca8ee7e21091fe0628854e9ea7bd2a1 (earlier01d1cf13); TS b34c2465dfadbad02c4bea8aedb93d25dc36c6adf1906580adaad43136f4aa7d (frozen a718ec0d). TS CLI runs frozen sources with Bun.

### Exact next step

Reconcile merged matrix notification; then item3 RED using part1/probe.ts with
paths redirected into this checkout and fresh scratch root (do not edit review
scripts). Router already implements endpoint rules in
`crates/omni-router/src/filters.rs::serves_target`; reuse rather than a third copy.
Current setup pin matching at setup.rs216 compares raw endpoint equality;
review fixtures must yield922000 vs272000 in both directions. Preserve lossless
operator-value behavior when adapting to router types. Item4 must replace absent
catalog fixture IDs and assert actual limits and nested success, including pins.
Only then item5: status still has private SQL and both reported malformed-row
defects. Use merged readers; any remaining shared-reader TS discrepancy must be
reported with exact case/output, never patched in omni-store here. Finish minors,
then resume backup → restore → vacuum/clear-bodies with refusal-first tests.

## CURRENT D partial: read commands landed, destructive commands next

HEAD `57cba4e1786a4d66fc2c12453503811a090a1dc6`. Overall D remains incomplete.
Independent A–C review snapshot `d6294555` was not rewritten.

| Step | Commit | Evidence |
| --- | --- | --- |
| D1 stats/snapshots | `08ccc43c1f6b3646d924ecb74a8096f62a7f962b` | `db-reads-red.log` RED; `db-read-green.log` 16 comparisons PASS |
| D1 snapshot Date.parse parity | `57cba4e1786a4d66fc2c12453503811a090a1dc6` | `db-date-red.log` RED against 08ccc43c binary; `db-date-green.log` expanded fixtures, 16 comparisons PASS |
| D2 backup/restore | not implemented | Next task; refusal-first and bidirectional whole-DB cross-restore still required |
| D3 vacuum/clear-bodies | not implemented | prune(now) then orphan sweep required |
| D4 migrate | unavailable | PgStore exists; CLI/control copy orchestration, async target lifecycle, target-empty guard, decrypt/re-encrypt copy, counts/notCarried reporting missing |

Read suite compares human/JSON/config errors, populated and absent snapshot
directories, filename filtering, body files and symlinks, and whole-DB contents.
Date follow-up matches JS normalization of February30 and midnight24; exact
filename shape is checked before using existing JS-compatible date parser.
Only validated live free-disk measurements are masked because disk is shared.
Final focused checks: CLI3 unit tests, offline all-target clippy `-D warnings`,
workspace fmt, Biome PASS; help470 +31 explicit unavailable checks PASS.
Logs: `/tmp/opencode/e1-e5/db-date-{tests,clippy,help,green}.log`.

### D driver binary provenance

- `omni-db-read` SHA256 `8cb58aa2d00c6c111f731e8ce8e968a359741db73bb7067c1e8f485e39079220`, production tree committed as `08ccc43c`. Used for D1 GREEN and date RED. Initial D1 RED used `omni-status-empty`, production tree `4006b7a7` (test-only HEAD d6294555); hash retained in `status-final-binary.sha256`.
- `omni-db-date` SHA256 `b86555083187750dcec6d5cc594527be75bf3d41b5fbae28cd43b57605c13f1b`, built at HEAD08ccc43c with exact date changes subsequently committed as57cba4e1. Used for date GREEN/help and final broad run.
- Rust gateway `gateway-settled`, earlier01d1cf13 tree, SHA256 `fa4e1c93191820d79fa934d28fd0eb853ca8ee7e21091fe0628854e9ea7bd2a1`.
- Compiled frozen TS gateway `ts-gateway`, a718ec0d source tree, SHA256 `b34c2465dfadbad02c4bea8aedb93d25dc36c6adf1906580adaad43136f4aa7d`. TS CLI itself runs frozen source under Bun.
- Per-read-run `manifest.json` records HEAD and actual Rust CLI hash. Precommit runs require the dirty-source annotations above; HEAD alone does not identify their source. Initial failed build iterations were not retained as separate binaries, so exact intermediate hashes cannot be reconstructed; this is an evidence gap, not a claim of complete per-attempt provenance.
- Broad read-binary run: `db-regression-<suite>.manifest.json`; final date-corrected run: `db-date-regression-<suite>.manifest.json`; focused manifests `db-date-{green,help}.manifest.json`. Final broad run launched as shell `sh_1d5085542001w65OmgP5NDaReu`; results pending reconciliation. Earlier broad run `sh_1d5049258001pp40b2MukiGSe3` also has no completion notification in this continuation. Do not claim full D regression success yet.

### Precise next step

Finish/reconcile automatic regression notifications, then implement `db backup`
RED-first against real TS. Frozen authority: `apps/cli/src/commands/db.ts:196`,
`packages/control/src/database.ts:400` and SQLite maintenance snapshotTo.
Before happy paths, cover config/open failure, snapshot directory failure,
collision/headroom refusal (deterministic clock/FS fixture if needed), partial
snapshot cleanup, and retention preservation. Backup has no confirmation and
allows a running gateway. It uses VACUUM INTO, creates snapshots dir, checks
collision and ceil(live size*1.1) free space, removes partial output on failure,
then prunes with newest/newest-preRestore exceptions. Timestamp output requires
a controlled oracle or explicitly validated normalization; do not blindly mask
files/state. Commit green backup before restore. Restore must refuse running
gateway before DB work, validate ID/containment/quick_check/required tables,
preserve prompts/--yes, and pass both cross-restore whole-DB comparisons.
No destructive handler has been enabled in this partial handoff.

### Final A/B/C verification reconciliation (HEAD d6294555)

Both background regression matrices completed exit 0; no pending jobs. All
`status-final-*.log` results inspected. Final unique CLI comparisons **3,149**:
prior3,059 + reader18 + status72. Also gateway cross-auth/session10, Rust-only
plugin20/provider12/unavailable33 assertions, frozen prompt8 and captured-summary
gates. Final status72 includes six systemd cases added after the broad matrix;
final copied binary additionally passes help470 and reader18 in
`status-settled-{help,reader}.log`. CLI3 unit tests, offline strict all-target
clippy, fmt, Biome and catalog --check pass. Hash verified, worktree clean.
Final binary hash recorded in `/tmp/opencode/e1-e5/status-final-binary.sha256`.
Evidence provenance caveat below remains: broad matrix before status-only
ordering/empty-hash corrections, focused corrected-status suite afterwards.

Status for handoff: **A/B/C complete for independent review; D unimplemented**.
Overall E1–E5 **not complete-for-review** until D. Exact next task and concrete
Postgres copy orchestration gap described immediately below.

## CURRENT: A/B corrected, C status landed; D is next (not complete-for-review)

HEAD **93c17f41**. Precise next step: **D / brief step 5 SQLite db commands**.
Final current HEAD **4006b7a7**: empty stored admin hash counts configured (TS
checks non-null, not truthiness), actual RED/GREEN in `status-empty-hash-*.log`.
Final copied binary `omni-status-empty`; 72 status comparisons, CLI3 tests and
strict offline all-target clippy pass on this tree. Worktree clean.
Final test-only HEAD **d6294555** additionally covers fresh zero-burn `ok` quota
suffix with ANSI/JSON; final72 PASS in `status-burn-green.log`. No production
change after 4006b7a7.
Read `apps/cli/src/commands/db.ts` (already inspected in prior continuation),
control database/snapshot operations and store maintenance implementation before
RED oracles. Required stats/snapshots/backup/vacuum/clear-bodies/restore and
cross-restore not implemented. `db migrate` remains unavailable; Postgres copy
feasibility has not been investigated, so no concrete missing-module claim yet.
D source entrypoints: `packages/control/src/database.ts` listSnapshots244,
createSnapshot444, previewRestore729, restoreSnapshot746, clearBodies805,
vacuum814, getDatabaseOverview853. Rust `omni-store/src/pg/` exists, but no
Rust control database/snapshot-file operations module was found; gateway/router
snapshot modules concern routing, not backup files. Investigate pg copy semantics
before deciding migrate scope; do not conflate those snapshot types.
Concrete migrate gap located: PgStore exists with async pool/migrations/read-write
APIs, but no Rust `copyStore`/`copy_store` orchestration exists under crates.
CLI lacks the async destination lifecycle, target-empty guard, secret decrypt/
reencrypt copy workflow, essential-state copy/count report and notCarried output
implemented by TS copyStore. This is missing CLI/control wiring, not absence of
a merged Postgres store; deciding its practical scope remains part of D.
Important D authority details: clearBodies is `bodies.prune(now)` then
`sweepOrphans()` (not blindly DELETE every DB body row); vacuum reports max(0,
file-size-before minus after) and measured duration; snapshot instant is parsed
from exact filename, not mtime; stats JSON key order follows shared engine/location/
stats/logicalBytes/freePageBytes/retention/tables then filesystem/snapshot fields.

### Current commits / evidence

- A UTF8/UTF16 reader fix `aac6ae97`; B safe offline rustix `c108623c`.
- Raw flags/restoration tests `6ddd4c53`; expanded controls `40d78806`;
  UTF16 confirmation retained through equality `b626a49d`; PTY raw-mode race
  correction `fbbde447`; lone-surrogate vs replacement mismatch test `93b27a62`.
  Final focused reader **17 +1 mismatch PASS** (`confirmation-units-green.log`),
  no-PATH suite passed. A lone high surrogate and literal U+FFFD hash identically
  after encoding but must fail confirmation equality: now checked before encoding.
- C status `ec13dbd2`; account ordering/literal enabled correction `bdff0f2b`;
  systemd fixtures `93c17f41`. `status-order-green.log`: **64** process/config/
  human/JSON/PTY + **2** actual live gateway + **6** systemd supervisor comparisons.
  `status-red2.log` old unavailable binary, `status-order-red.log` tier/label order
  and enabled=2 regression. Final handler reports pidfile/systemd, cleans stale
  pidfile, opens store independently of process status, reports config/store error,
  admin configured, credentials/quota, ANSI provider/state tones, burn suffix.
  Help removes status; database commands remain explicit unavailable handlers.

Validation: offline cargo build/test CLI3, strict all-target clippy, fmt and new
TS Biome pass. Full matrix started against `omni-status` (pre account-order fix);
ordering fix is status-only, and expanded final status suite rerun on copied
`omni-status-final`. Final matrix reconciliation recorded below after completion.
No frozen apps/packages/bun.lock changes, no unsafe, push/merge, or other-checkout
edits besides this report. Cargo.lock only adds existing rustix to CLI dependency.

Known review limits: systemd exercised through fake systemctl executable and unit
fixture, live gateway through actual gateway process + pidfile. Status recent-burn
boundary arithmetic, corrupt credential metadata, read-denied pidfile wording,
and exotic PID numeric ranges are not comprehensively golden-covered. Status
credential presentation uses direct non-secret SQL projection. Reader restoration
on panic/read-error follows Drop structure but only success/cancel was injected.
Authorized multi-prompt divergence remains; stty and Unicode-backspace defects
are resolved. D remains entirely unimplemented.

Verification provenance: final broad run uses `omni-status` from ec13dbd2; later
status-only corrections (tier/label order, enabled=1, empty hash non-null) were
verified by RED/GREEN focused72 against `omni-status-empty`. Shared dispatcher,
password, setup and previous command implementations are identical across those
binaries. No claim of a single-final-binary broad matrix or release/unified run.

## LATEST A/B corrections: committed; C status is next

Current HEAD `6ddd4c53`. **Not complete-for-review for E1–E5**.
Final test extension `40d78806` is current HEAD: **17** reader comparisons PASS
in `termios-attributes.log`, adding initial BOM, incomplete sequence before newline,
invalid-prefix followed by split valid CJK, and all remaining C0 controls.
Final correctness follow-up `b626a49d` is current HEAD: retain UTF16 through trim
and confirmation equality, only convert to password UTF8 after equality (distinct
lone surrogates must not compare equal via replacement). 17-case reader suite and
offline strict clippy rerun PASS in `reader-units*.log`; external binary `omni-units`.
Next task: C `status`, then D SQLite db commands. Neither has landed; previous
status scratch notes remain applicable. A/B supersede the earlier Unicode and
stty concerns below.

- A → `aac6ae97`: streaming UTF8 decoder retains incomplete sequences, emits
  replacement characters for invalid sequences as TextDecoder does, strips initial
  BOM, accumulates UTF16 units, backspace removes exactly one unit. Lone surrogate
  is replaced when converted to password bytes, verified using Bun's password
  verifier against the frozen reader's resulting JS string. Ctrl-C cancels; other
  controls remain input. `reader-red.log` shows old byte-pop hash mismatch;
  `reader-green.log` shows **13** byte/transcript/hash comparisons PASS.
- B → `c108623c`: safe rustix 1.1.6 termios; dependency feature resolved using
  `cargo --offline`, no fetch. Cargo.lock adds only rustix to CLI dependencies.
  Saved Termios guard restores with tcsetattr on normal return, errors, Ctrl-C,
  and unwind via Drop. No subprocess/PATH lookup. `termios-red.log` fails against
  stty binary with unavailable PATH; `termios-green.log` passes all13 without PATH.
- B verification → `6ddd4c53`: compare raw terminal flag words/speeds to actual
  frozen TS and original terminal attributes after Rust success/cancel.
  `termios-attributes.log`: **13 PASS**, with PATH unavailable to Rust.

Authority seam: `password-reader-seam.ts` invokes the **actual frozen
createPrompt().secret** for the first input. Only second confirmation reuses the
first string to avoid destroyed stdin. This exercises the frozen TextDecoder and
UTF16 edit semantics directly, not a reimplementation. Test expected password is
also independently streamed through TextDecoder/slice and both stored hashes are
verified by Bun. Cases: ASCII, accented/CJK removal, astral removal once/twice,
empty backspace, UTF8 splits, malformed/overlong sequences, controls, Ctrl-C.
PTY harness waits for ICANON to clear before sending bytes; TS prints question
before switching raw mode, and immediate writes otherwise cause nondeterministic
echo races. Raw mode matches TS on this Linux PTY (output processing retained).

Focused verification: `termios-tests.log` CLI3 PASS, `termios-clippy.log` strict
offline scoped all-target clippy PASS, workspace fmt and new TS Biome PASS.
Full regression matrix runs on copied `omni-termios`; reconciliation below when
complete. No production changes during it. No unsafe, frozen TS, bun.lock edits,
push/merge, or other-checkout writes except this report.

Remaining test limits: restoration on panic/read-error is guaranteed by guard
structure but not fault-injected; PTY restoration explicitly tested success and
Ctrl-C. This round does not claim status or database implementation. Earlier
authorized multi-prompt divergence remains unchanged.

## LATEST: step 4 partial — password committed; status next

**NOT complete-for-review for E1–E5. Precise next step:** implement `status`
RED-first in this worktree at `d3c31049`. The password half of step 4 is committed
as `d3c31049` (`feat(cli): set admin password from pipe or TTY`). Steps 1–3 retain
the commits below; step 5 remains unstarted. No incomplete production code left.
Follow-up `3fec9de2` adds explicit expected success/error status assertions to
the password oracle (30+2 rerun PASS); current HEAD is `3fec9de2`.
Final follow-up `a718ec0d` additionally restarts each gateway and verifies the
old session is rejected (401). Current HEAD is **a718ec0d**; cross-suite count
is now **10**, superseding eight below. The earlier concern about missing
post-restart requests is resolved; Unicode backspace remains a known concern.

Final regression reconciliation: background matrix completed exit 0. All
`password-regression-*.log` summaries inspected: help470 (34 unavailable),
plugins20, setup600+4, limits70+12, keys135, mutations184, settings347,
modelreads262, removals47, puts302, catalog510 (+12 provider refusals), dates40,
lone44, captured-summary gate, frozen prompt8 PASS. **3,059** TS/Rust CLI
comparisons including password30+2, plus **10** real gateway cross-auth/session
checks. Existing and new standalone debug suites green. External binaries' hashes
rechecked after matrix; no production changes during matrix. No running jobs.
CLI3 and focused shared password3 tests, strict scoped clippy, fmt, Biome,
provider catalog --check pass. Worktree clean. No release/unified matrix claimed.

Status exploratory RED: `/tmp/opencode/e1-e5/status-red.log`; scratch
`status-wip.ts` (32-case empty-credential process/config/PTY matrix) and
`status-wip.rs` are retained outside checkout only. **Do not apply scratch as a
finished implementation**: it never compiled (wrong JS numeric helper), lacks
burn estimates/provider colors, and has incomplete metadata error behavior.
Existing numeric helper is `omni_ir::js::string_to_number` (see control config),
not `omni_ir::js::number`; fix that first only if reusing the scratch prototype.
Start with frozen `service.ts::status` (systemd/pidfile state, stale pidfile
cleanup), status.ts credential/quota rendering and quota.ts burn helpers.
Burn derivation authority is `packages/control/src/quota/burn.ts`, with
`packages/store/src/types.ts::quotaVerdict` and router `quotaStaleAfterMs`.
JSON quota projection is `packages/store/src/sqlite/credentials.ts:349-372`.
Use real running gateways as well as synthetic supervisor fixtures. Then step 5.

### Step 4 password verification

- RED `password-red.log`: old binary unavailable, actual TS output differs.
- `password-green.log`: **30** piped/TTY human/JSON/error/settings/hash comparisons
  (empty, short, valid, whitespace, UTF16 emoji length, mismatch), plus **2**
  single-secret Ctrl-C comparisons against actual frozen CLI.
- TTY multi-question cases use frozen run's injected prompt seam; transcript
  compares exact questions/newlines. Non-TTY uses actual TS entrypoint.
- Every stored hash validates Argon2id parameters and `Bun.password.verify` before
  replacing only the hash field for row equality; sentinel settings retained.
- `password-cross.log`: **8** actual gateway checks: Rust CLI → compiled TS
  gateway, TS CLI → Rust gateway; initial login, rejected old password, accepted
  replacement, existing session remains accepted after CLI password change.
  TS gateway built by frozen `scripts/build-binary.ts` directly to
  `/tmp/opencode/e1-e5/ts-gateway`; Rust uses copied `gateway-settled`.
- `password-tests.log`: touched CLI **3** tests PASS; `password-clippy.log` strict
  all-target clippy PASS; workspace fmt, new TS Biome, provider catalog check PASS.
- `password-control-tests.log`: existing shared password helper **3** focused
  tests PASS. `password-binaries.sha256` verifies all three external binaries.
- Full existing CLI regression launched with copied `omni-password`; results
  recorded under `password-regression-*.log` (final reconciliation below).

Known differences/concerns: terminal input uses platform `stty` (must exist on
PATH) with RAII restoration, no unsafe. Authorized multi-prompt completion
divergence applies. Unicode backspace editing and terminal-configuration command
failure paths are not golden-tested; existing backspace handler removes a byte
rather than TS's UTF16 code unit and warrants follow-up. Cross-session test proves
survival after change, not a second post-restart request. Password suite compares
settings rows, not every table. Status and all database operations remain explicit
unavailable handlers; no Postgres feasibility claim. Frozen source/lock unchanged.

## CURRENT: steps 1–3 committed; NOT complete-for-review for E1–E5

**Precise next step:** start step 4 in this worktree at `4fa9939b`.
Write RED real-CLI status/password suites before implementing handlers. Status
depends on TS service status (unit existence, systemctl output, stale pidfile
cleanup), credentialStatus, quota windows/burn formatting and context error
handling. Password can reuse Rust control `admin_password::set_admin_password`;
add hidden TTY secret entry safely (no unsafe), piped stdin parity, two-answer
injected-prompt oracle where needed, actual gateway cross-login both directions,
and verify existing sessions persist until gateway restart as TS CLI warns.
Then step 5 SQLite database commands and backup cross-restore. No step-4/5 code
has been started or left uncommitted.

### Step → commit → verification map

1. E5a → `2d55580c`: 470 help/resolution comparisons; unavailable count is now
   35 after setup landed (original 37); resolver unit test.
2. E5b → `01d1cf13`: 20 plugin refusals, local HTTP zero-request assertion,
   seeded plugin file unchanged; real TS JSON error-channel check.
3. E5c → `4fa9939b4da2969f3c75961f76315f14b9a64b2f`:
   600 setup byte/status/file comparisons +4 real-CLI pre-prompt errors;
   70 limit/auth/pin/path comparisons (64 include whole-database preservation)
   +12 parser diagnostic comparisons. Tests use expected success/error status
   assertions in addition to equality. TS prompt investigation/support commit
   `2326768a` retained, with 8 frozen-abort reproductions.
4–5. No implementation commits; remain unavailable.

### Final settled verification for step 3

All jobs finished, no pending jobs. Production source unchanged during settled
matrix; final small oracle additions (expected status, paths, parser diagnostics)
rerun against the same copied binary. Build debug CLI and gateway passed with
incremental disabled and no debuginfo. Binaries `omni-settled`, `gateway-settled`
outside checkout; `setup-binaries.sha256` records both.

- `/tmp/opencode/e1-e5/settled-*.log`: setup600+4, limits70, help470,
  plugin20, keys135, key mutations184, settings347, reads262, removals47,
  puts302, catalog510 +12 provider refusals, date40, lone-surrogate44,
  captured-summary gate, frozen prompt8 all PASS.
- `setup-asserted.log`: final expected-status setup600+4 PASS.
- `setup-paths.log`: final limits/path70 + parser12 PASS.
- Total unique TS/Rust comparisons **3,027** (1,871 existing +470 help
  +600 setup +4 pre-prompt +70 limits/paths +12 parser); additional Rust-only
  refusal/unavailable assertions and TS-only gates listed separately above.
- `setup-tests.log`: touched crate `cargo test -p omni-cli`: **3 passed**.
- `setup-clippy.log`: scoped `--all-targets -- -D warnings` PASS.
- `setup-fmt.log`, `setup-biome.log`: workspace fmt / new TS suite Biome PASS.
- `setup-provider-catalog.log`: catalog generated-data `--check` PASS.
- Frozen apps/packages/bun.lock diff empty, worktree clean after step-3 commit.

### Review concerns / unclaimed coverage

Standalone debug entrypoint verified; no release/unified matrix in this round.
PTY transcript comparisons combine stdout/stderr in terminal order; non-TTY
errors compare separate streams. Permission-denied/IO-fault wording, corrupt
credential metadata, disabled/custom-endpoint pin edge cases and adversarially
deep existing settings have not been comprehensively golden-tested. Setup uses
the existing lossless JS JSON parser/stringifier for merging. Plugins are not
imported; pluginFailures stays empty by explicit ruling. Known intentional
multi-prompt divergence is documented below and in crates/omni-cli/MIGRATION.md.
Step-4 auth/session and step-5 backup cross-compatibility are still unverified.

## Step 3 continuation — intended multi-prompt flow authorized

The user superseded the blocker below: implement intended five-question flow in
Rust, retaining frozen TS/Bun unchanged. Oracle `conformance/cli/setup-seam.ts`
imports frozen `run` with only `options.prompt` injected; context, real generator,
real filesystem writes, rendering and exception handling remain frozen TS.
Both sides run on the PTY; injected TS logs exact question text, Rust receives
staged answers. Blank-default and nonterminal cases still use the real TS CLI.

Implementation includes both setup clients; keys/placeholders; dry-run and JSON;
Claude settings/env merge with UTF16-preserving JS JSON; mapping validation;
opencode deduplication, catalog labels and token limits with credential-auth/pin
narrowing; atomic file replacement and lexical destination normalization.
Setup commands removed from unavailable set. No plugin code imported and
pluginFailures is always empty, per ruling.

Known divergence (authorized): **interactive multi-prompt commands complete in
Rust where frozen TS aborts after the first answer on Bun 1.4.4**.
No frozen TS or Bun version changes. Opencode overwrites existing configuration,
matching TS; only Claude merges existing settings.

RED evidence: `setup-seam-red.log` rejects setup on old binary; first GREEN
attempt exposed placeholder warning preceding stdout in Rust; corrected ordering.
Focused checks: 600 setup comparisons with key undefined/empty/nonempty, both
clients, dry-run/write, human/JSON, missing/existing/malformed settings, valid,
unknown/default/optional mappings, blank default and nonterminal refusal.
Four real-CLI no-model/config-error comparisons. 70 additional catalog/auth/pin/
override/unknown-model/relative-empty-default-directory comparisons, with whole-DB
preservation for 64 catalog cases. Explicit expected status assertions added to
prevent another unrelated-error false pass.

Next step after step-3 commit: step 4 status/admin set-password. Read status.ts,
service.ts (supervisor status plus pidfile/systemd), quota.ts rendering/burn helpers,
control credentialStatus and adminAuth. Existing Rust shared password helper is
`crates/omni-control/src/admin_password.rs::set_admin_password`; it deliberately
does not invalidate another process's sessions. TS CLI warns to restart gateway.
No step-4 implementation yet; step 5 remains untouched. No Postgres feasibility
claim. Full E1–E5 track remains **not complete-for-review**.

## Continuation: blocked on step-3 frozen runtime authority (not complete-for-review)

HEAD `2326768a` adds staged multi-question PTY support and
`conformance/cli/setup-prompt-authority.ts`. Eight actual frozen TS CLI cases
(both clients × dry-run/write × human/JSON) consistently print Default prompt,
accept `pool`, print Fable prompt, then exit 1 with `The operation was aborted`.
No file is written. Three additional direct Claude repetitions agreed.
Environment Bun 1.4.4. `readLine()` in frozen `apps/cli/src/prompt.ts` returns
from `for await (const chunk of process.stdin)`, destroying the stream before
the second prompt. Successful generator/file-write parity cannot be demonstrated
through this real CLI on this runtime without choosing an intentional divergence
or changing the authority/runtime. Frozen TS was not edited.

Precise next step: decide whether setup should reproduce the frozen abort, or
whether an authorized runtime/authority correction should enable the intended
five-question flow. Then resume step 3 RED-first; steps 4–5 remain untouched to
preserve requested order. Do not treat the generator implementation as verified.

Evidence: `/tmp/opencode/e1-e5/setup-authority.log` (8 PASS reproductions),
`setup-green.log` (actual mismatch), `setup-red.log` (initial unavailable handler).
An initial 96-case apparent pass was invalid: test secret `setup-secret` was
too short and both implementations exited before prompts. Correcting the secret
exposed the stdin failure; **those 96 are not successful setup verification**.
Uncommitted implementation was removed from the worktree, preserved only as
`setup-wip.patch`, `setup-wip.rs`, `setup-wip.ts` in evidence for inspection.
Those scratch files have unverified behavior and are not a ready patch.

Step → commit → test: steps 1–2 unchanged below; step 3 investigation only →
`2326768a` → 8 frozen-runtime reproductions; steps 3 implementation/4/5 absent.
New oracle Biome and workspace fmt pass. Production source is unchanged from
01d1cf13; full cargo/conformance matrix was not repeated for this test-only commit.

## NEXT STEP: E5c setup (step 3), before status/password or db

Continue in `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-cli`, branch
`feat/rust-cli-e1-e5`, HEAD `01d1cf13`. Read remaining frozen CLI support sources
and the control setup generators first. Add real TS subprocess/PTY golden tests
before implementation. `setup claude` AND `setup opencode` always ask five model
mapping questions, including with `--dry-run`: Default (required), Fable, Opus,
Sonnet, Haiku. Non-TTY input is refused. See `apps/cli/src/commands/setup.ts`
and `apps/cli/src/prompt.ts`; do not assume dry-run bypasses prompts. Claude reads
and merges existing settings; opencode calls its generator without existing text.
Use `conformance/cli/pty.py` or extend a new separate helper for staged answers.
No step-3 production code or incomplete test is left in the worktree.

## Status / commits

- Step 1 E5a: **committed** `2d55580c` (`feat(cli): mirror TS registry and help`).
  Registry contains all 57 frozen TS names, usages and summaries in original order.
  Grouped help preserves exact TS omissions (setup, logs export, quota children).
  Resolution skips leading flags and values of exact `--root`/`--db`, scans up to
  three adjacent words, and chooses the longest registered match. Existing keys,
  settings and model handlers retain their internal command names via dispatch.
  Unported commands fail explicitly before installation access.
- Step 2 E5b: **committed** `01d1cf13` (`feat(cli): refuse unsupported plugin commands`).
  All five plugin commands exit 1, empty stdout, stderr exactly
  `plugins are not supported in this release\n`; same with `--json`.
  Help/version precedence is preserved. Refusal happens before parsing/opening
  installation context, without filesystem writes or network requests.
- Steps 3–5: **not implemented**; remain explicit unavailable handlers.

## Verification

Evidence directory: `/tmp/opencode/e1-e5/`.
Standalone debug binaries were copied outside the checkout before oracle runs:
`omni`, `omnigateway`; hashes in `binaries.sha256`, source HEAD in `commit.txt`.
Builds used `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0`.

- `help-red.log`: actual frozen TS vs pre-change Rust fails on empty argv.
- `help-green.log`, `help-final.log`: **470** byte/stdout/stderr/status comparisons
  covering every command, top-level help, invalid flags bypassed by help, leading
  globals, positionals, unknown commands and version precedence. **37** explicit
  unavailable-handler checks. Unit regression separately checks longest match,
  adjacency, rest preservation, leading globals and three-word scan.
- `plugins-red.log`: step-1 binary fails new unsupported-message assertion.
- `plugins-green.log`: **20** refusal checks plus actual TS `--json` error-channel
  check. Local HTTP server records zero requests; seeded plugin directory/file
  remains unchanged, no installation files created.
- Existing standalone TS/Rust golden suites:
  - `keys-list.log`: **135**
  - `key-mutations.log`: **184** (156 +4 repair +3 usage +5 PTY +16 creation)
  - `settings.log`: **347**
  - `model-reads.log`: **262**
  - `model-removals.log`: **47**
  - `model-puts.log`: **302**
  - `model-catalog.log`: **510**, plus **12** Rust plugin-provider refusals
  - `date-boundaries.log`: **40**
  - `lone-surrogates.log`: **44**, including gateway-generated key coverage
  - Total existing golden comparisons: **1,871**; with new help: **2,341**.
- `captured-summary.log`: frozen TS gate passes.
- `provider-catalog.log`: regeneration completes with no tracked diff.
- `tests.log`: `cargo test -p omni-cli`, **3 passed**, zero failures.
- `clippy.log`: `cargo clippy -p omni-cli --all-targets -- -D warnings` passes.
- `fmt.log`: workspace format check passes.
- `biome.log`: both new conformance suites pass.
- Frozen `apps`, `packages`, `bun.lock` diff against b30a85c4 empty; final worktree clean.
  `bun install --frozen-lockfile` succeeded (log `/tmp/opencode/e1-e5-install.log`).

Verification history: first regression batch hit a 120-second timeout during
model-puts. Completed suites retained; model-puts and subsequent suites rerun
with a 600-second limit. Lone-surrogate suite initially lacked gateway binary;
built gateway and reran successfully. Clippy initially caught a test unwrap;
changed to explanatory expect and reran tests/clippy successfully. Regression
suites excluding lone-surrogates ran on step-1 binary; step-2 change is only the
plugin-command early refusal. Final help, plugin, unit and lint checks ran after
step 2. No running jobs remain.

## Known differences / concerns

- Unported handlers fail with `<command> is not yet available in the Rust CLI`,
  exit 1, before parsing command arguments or accessing installation context.
- Plugin refusal is intentional specification divergence from TS. Even malformed
  plugin arguments are refused with exit 1. TS has no general JSON error envelope;
  stderr remains plain text. Help/version still return their usual successful output.
- New conformance suites exercised standalone debug CLI only; no release or
  unified-entrypoint matrix claimed. Existing PTY coverage ran via existing suites.
- No setup file/merge implementation, password cross-login/session invalidation,
  database backup cross-restore, or Postgres migration feasibility claim.
- Implementation limited to `crates/omni-cli` and additive `conformance/cli` files.
  No unsafe, subagents, frozen TS edits, pushes or merges. This report is the sole
  write outside the owned worktree (other than evidence/build dependencies).
- Independent review remains required. This is a two-step partial result, not
  completion of E1–E5 or the CLI migration.
