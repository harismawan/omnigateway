# Rust cluster: pretraffic bucket sweep

The Rust cluster limiter seeds long windows from Postgres. Its Redis bucket
counts and companion metadata are tied to the Postgres lineage that produced
them. Do not reuse them after restoring or replacing that lineage, or when
switching between incompatible bucket formats (including TS to Rust).

1. Stop every gateway writing to the chosen Redis database and verify the
   old fleet has drained. Do not mix TS and Rust writers.
2. With `OMNI_REDIS_URL` set to that fleet's coordinator database, run
   `omnigateway cluster-cutover-sweep` once. It discovers `omni:b:*` names by
   bounded SCAN and unlinks only returned names. It does not change sessions,
   locks, or Postgres data. If it fails, keep the fleet stopped and retry.
3. After exit zero, start the fleet on the intended Postgres primary. Boot
   preseeding happens before the listeners accept traffic.

Do not run the sweep for a routine restart or a compatible rolling update.
The standalone command does not check whether other writers are still live.
