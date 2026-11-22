-- Captured request and response bodies, and the api key opt-out that suppresses
-- them.
--
-- The row holds a pointer, never a body. Bodies are the largest thing this
-- gateway could ever store — a single conversation with a pasted file in it
-- dwarfs the whole of `request_logs` — and SQLite would carry every one of them
-- through the same page cache, the same WAL, and the same backup that the
-- routing tables live in. A prompt corpus inlined here would make the operating
-- database grow without bound, make every `VACUUM` copy it, and put plaintext
-- rows one `sqlite3` invocation away. The artifact instead lives at
-- `<dirname(databasePath)>/request_bodies/YYYY/MM/DD/<request_id>.json.enc`,
-- encrypted under the same key as provider credentials, and this row records
-- only where it is and whether it can still be trusted. OmniRoute reached the
-- same layout the expensive way: its `call_logs_v1_legacy` table exists purely
-- to drain inline blobs it had already shipped into file artifacts.
--
-- `rel_path` is relative so moving an installation does not invalidate every
-- row, and nullable because a row can exist with no artifact behind it: capture
-- may have been suppressed, or the file may have been swept.
--
-- `sha256` is taken over the bytes as stored — the ciphertext — not over the
-- plaintext. Truncation or bit-rot on disk is then detectable by a reader that
-- does not hold `OMNI_ENCRYPTION_KEY` at all, which is what makes `corrupt` a
-- state the reader can report rather than an exception it has to raise.
--
-- `detail_state` is one of `none`, `ready`, `missing`, or `corrupt`. A file tree
-- and a table it is not written to transactionally will drift — a crash between
-- the two writes is enough — so the reader records what it observed and hands
-- back the metadata. `missing` and `corrupt` are answers, not failures.
--
-- `truncated` is set when structural bounding altered anything, so a reader can
-- say "this is not the whole payload" without diffing it against nothing.
--
-- No foreign key to `request_logs`. Expiry is performed explicitly, deleting the
-- file and the row together, because `ON DELETE CASCADE` only fires while the
-- `foreign_keys` pragma is on: a pragma silently off would turn expiry of a
-- prompt corpus into indefinite retention of one, and that failure is invisible
-- until someone goes looking.
CREATE TABLE request_bodies (
  request_id   TEXT PRIMARY KEY,
  at           INTEGER NOT NULL,
  rel_path     TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT,
  detail_state TEXT NOT NULL DEFAULT 'none',
  truncated    INTEGER NOT NULL DEFAULT 0
);

-- Descending, because every read of this table is time-ordered from the newest
-- end: the retention sweep walks the oldest rows and the row cap walks them in
-- the same direction, and the console only ever asks about recent requests.
CREATE INDEX idx_request_bodies_at ON request_bodies (at DESC);

-- Per-key suppression, checked before any capture work begins.
--
-- A shared installation can be serving one client whose payloads must not be
-- retained while capturing everything else, and that client's operator cannot be
-- asked to trust a global switch they do not control. Default 0 keeps every
-- existing key on the installation-wide setting, which is itself off by default.
ALTER TABLE api_keys ADD COLUMN body_logging_opt_out INTEGER NOT NULL DEFAULT 0;
