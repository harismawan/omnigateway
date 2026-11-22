# Rust cluster: pretraffic bucket sweep

The cluster limiter seeds long windows from Postgres. Its Redis bucket counts
and companion metadata are tied to the Postgres lineage (xid8 domain) that
produced them. Do not reuse them after restoring or replacing that lineage, or
when switching between incompatible bucket formats. The sweep is mandatory on
DB restore/replacement/xid-domain change or incompatible companion changes,
**before** traffic or preseeding — even if the Redis server itself did not
change.

1. Stop every gateway writing to the chosen Redis database and verify the old
   fleet has drained. For a restore/replacement, take the final Postgres
   backup first.
2. With `OMNI_REDIS_URL` set to that fleet's coordinator database, run
   `omnigateway cluster-bucket-sweep` once. It discovers `omni:b:*` names by
   bounded SCAN and unlinks only returned names — bucket hashes and their
   `:meta` companions both match and must go. It does not change sessions,
   locks, or Postgres data. If it fails, keep the fleet stopped and retry.
   `scripts/cluster-bucket-sweep.sh` is the same sweep as a
   `valkey-cli`/`redis-cli` wrapper for hosts without the image: dry-run by
   default, `--apply` unlinks, then verifies zero remain and prints the counts
   to record.
3. After exit zero, start the fleet on the intended Postgres primary. Boot
   preseeding happens before the listeners accept traffic. Seeds read the
   primary; a lagging replica is not an accepted replacement for that
   visibility contract. Keep the same `fleet_max_keys` across replicas.

`SCAN` can return empty pages before cursor zero, and duplicate names; both
implementations continue to zero and tolerate already-unlinked names.
`omni:b:*` is a SCAN pattern, never a literal key supplied to UNLINK. Do not
use FLUSHDB/FLUSHALL or delete session/lease/lock namespaces as a substitute.
Record completion and counts, not connection secrets. Do not hand-edit
companions or fabricate snapshots/transaction IDs to make counters look
seeded.

Do not run the sweep for a routine restart or a compatible rolling update.
The standalone command does not check whether other writers are still live.
