-- Which process owns a pending request, and which processes are alive.
--
-- `sweepPending` used to retire every pending row at boot, on the premise that
-- an installation is one process. With several, a replica booting into a live
-- fleet would mark every other replica's in-flight request interrupted, and the
-- real owner would then complete it a second time — into rollups that add.
-- `node_id` names the owner; `nodes` says who is still here. A row whose owner
-- is absent from `nodes`, or unseen past the heartbeat's grace, is what a sweep
-- may retire.
--
-- `DEFAULT ''` rather than NULL: a row written before this migration has no
-- owner, and an owner nothing heartbeats for is exactly a dead one.
ALTER TABLE request_logs ADD COLUMN node_id TEXT NOT NULL DEFAULT '';

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);

-- Compare-and-swap for token material. Two processes refreshing one credential
-- at once must not both write: the second write would carry a rotation the
-- provider already invalidated. The refresher passes the version it read, and a
-- write whose version has moved is refused rather than applied.
ALTER TABLE credentials ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
