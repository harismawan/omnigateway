# `omni db restore <id>` — the swap (what happens after the confirmation is accepted)

Written by the controller from the frozen source so the implementer does not have to spend its context reading it. Line numbers refer to the frozen TypeScript in the worktree. Where this note and the frozen code disagree, the frozen code wins — say so in the report.

## Where things are

- Frozen operation: `packages/control/src/database.ts` — `restoreSnapshot` 746–750, `swapIn` 566–680, `writeSnapshot` 400–442, `judgeCandidate` 541–552, `SwapFailedError` 460–479.
- Frozen store handle: `packages/store/src/sqlite/store.ts` — `closeHandle` 109–114 (idempotent), `reopen` 247–251 (= close if open, then the same `open()` used at boot: pragmas + migrations).
- Frozen file adapter: `packages/control/src/nodeFs.ts` 70–80 — `stat` → null on ANY error; `unlink` = `rmSync(path, {force: true})` (a missing file is not an error; other errors propagate with the `rm` message form); `rename` = `renameSync`; `copyFile` = `copyFileSync`.
- Frozen CLI output: `apps/cli/src/commands/db.ts` 377–388.
- Rust today: `crates/omni-cli/src/database.rs` line 49 returns `db restore is not yet available in the Rust CLI` after the confirmation; `crates/omni-control/src/database.rs` has `validate_restore` (123…), `write_snapshot(conn, path, now, retention, free_bytes, force)` (255–296; with `force` it names the file `preRestore` and skips retention), the process-local `EXCLUSIVE` latch (308–345), `unlink`, `fs_error`; `crates/omni-control/src/database_fs.rs` has the adapter's `stat`/`readdir`. The store: `omni_store::SqliteStore::open(path, day_offset)` = open + pragmas + migrate (`crates/omni-store/src/lib.rs` 89–99); `omni_store::rollup::rebuild_rollup(conn)` exists.
- Suite: `conformance/cli/db-restore-swap.ts` (7 cases + 5 undo round trips, `--compare` mode currently red at `yes-human`), `conformance/cli/db-file-state.ts` (full-state helper; masks live header bytes 96–99; newly written snapshots differ only at offsets 98–99).

## The frozen sequence, step by step

`restoreSnapshot(deps, id)`:

0. `path = snapshotPath(id)`; if `stat(path)` is null → `BAD_REQUEST: no such snapshot`. (Before the guard.)
1. Enter the exclusive guard with label `"a restore"`. Everything below is inside it.

`swapIn(deps, {path, consume: false})`:

2. `judgeCandidate(path)` AGAIN (the candidate is re-inspected after the confirmation): not ok → `BAD_REQUEST: that file is a database, but not one of ours: …` or `… failed its integrity check: …`. `inspection.counts` is what the result reports — the counts come from this second inspection.
3. `writeSnapshot({reason: "preRestore", force: true})`, unguarded (the guard is already held): `mkdir(snapshots)`; if `stat(target)` is not null → `CONFLICT: a snapshot for this instant already exists`; free-space check → `CONFLICT: not enough free disk space to write a snapshot`; `VACUUM INTO`; on failure `unlink(target)` then rethrow; NO retention. Result object: `{id, filename, createdAt, sizeBytes, reason: "preRestore"}`.
4. Read the admin password hash and the viewer password hash from the LIVE store (before). A failure here: ordinary error; the undo snapshot stays; nothing staged.
5. `staged = live + ".incoming"`. `copyFile(candidate, staged)` — the candidate's MAIN file only. On failure: `unlink(staged)` (if that unlink throws, ITS error is what propagates), then rethrow the copy error. This is still an ordinary error: live untouched, undo snapshot stays.
6. `try {` — from here a failure is a `SwapFailedError`:
   a. `store.close()`
   b. `unlink(live + "-wal")`
   c. `unlink(live + "-shm")`
   d. `rename(staged, live)`
   e. `store.reopen()` (open + pragmas + migrations on the new file)
   `} catch (error) {` try `store.reopen()` once more (records `reopened` true/false, swallowing its error) and throw `SwapFailedError(preRestoreSnapshot.id, error, reopened)` — message `the database swap failed and the database may be incomplete`. NO rollback: whatever file is at `live` stays; `.incoming` stays if the rename did not happen; the undo snapshot stays.
7. Read both hashes again from the reopened store (after). A failure here is an ordinary error (the swap already succeeded: new live, undo kept).
8. `store.usage.rebuildRollup()` — failure swallowed with a warning log (`usage rollup not rebuilt after the swap; run omni doctor`).
9. `reapplyPluginSchema?.()` — failure swallowed with a warning. Check what the frozen CLI passes for this dependency (grep `reapplyPluginSchema` in apps/cli); the Rust CLI has no plugins — if the frozen CLI passes nothing, there is nothing to do.
10. Result: `{ok: true, counts, preRestoreSnapshot, adminPasswordChanged: after !== before, viewerPasswordChanged: after !== before}` — `!==` on `string | null`, so gaining or losing a password is a change.

CLI (db.ts 377–388): JSON mode emits the whole result object (key order as constructed above — compare with the frozen output, including the nested `preRestoreSnapshot` object); human mode prints fields `restored <id>`, `undo <preRestoreSnapshot.id>`, then one line per entry of `counts`.

How the frozen CLI reports a `SwapFailedError` (exit code, stderr text, whether `preRestoreSnapshotId` is printed): find where the CLI's top level formats thrown errors (it is not handled in db.ts) and match it — the existing characterisation cases `older-ledger`/`newer-ledger` already show the observed text.

## Observed on the frozen CLI (reproduce, do not improve)

- A candidate row that exists only in the candidate's `-wal` is counted by the preview/result (4) and absent from the restored database (3): step 5 copies the main file only.
- When step 6e fails (the "shifted ledger" fixtures: migration 001 re-runs against existing tables), the candidate is already live, the undo snapshot is kept, no `.incoming`, no live sidecars at process exit, exit 1.
- A newly written snapshot (the undo) differs between the CLIs only at header offsets 98–99; compare it table by table and mask bytes 96–99 of that one file.
- Opening the live database can itself change it (journal mode, checkpoint); always compare Rust's post-state with the frozen CLI's post-state.

## Shape for the Rust side

In `crates/omni-control/src/database.rs`, one function for steps 1–10 that the gateway's admin route can reuse later, taking: the live path, the snapshot id, a clock, a free-space function, and a small store seam with exactly the operations the sequence needs — `inspect(path)`, `snapshot_to(path)`, `admin_hash()`, `viewer_hash()`, `close()`, `reopen()`, `rebuild_rollup()` — plus a file seam with `stat`, `unlink` (rm-force semantics, `rm` error form), `rename`, `copy_file`, `mkdir`, `free_bytes`. The CLI supplies real implementations (the store seam owns an `Option<SqliteStore>`: `close` drops it, `reopen` = drop then `SqliteStore::open`). Tests supply failing ones — that is how the rows of the contract table that no fixture can reach get tested later. A typed error for the swap failure carrying the undo id and `reopened`.

Do not hold a second connection to the live database anywhere during step 6 (the CLI opens the store before the preview — that same handle is the one closed in 6a).

## Order of work

1. Seams + the function + the CLI wiring, with the accepted path STILL returning "not yet available" behind a constant until step 3 of this list passes. Unit tests with fake seams for the happy path order (assert the exact sequence of seam calls equals steps 2–10).
2. Run `db-restore-swap.ts --compare` case by case; fix until all seven cases and the five round trips are equal (stdout, stderr, exit, full post-state through the helper).
3. In ONE commit: switch the accepted path on, replace the four Rust-only "unavailable" cases in `db-restore.ts`, register the swap suite in the pinned matrix with its exit histogram.
4. Then, each with the frozen CLI observed first: a live database with a non-empty WAL; a candidate from a genuinely older schema; one from a genuinely newer schema.
