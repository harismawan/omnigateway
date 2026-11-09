# Bounded Rust limiter history

Minute history is independent of configuration, including concurrency-only
subjects. Lowering, disabling or arbitrarily raising a limit discards nothing.
For finite ordered millisecond timestamps, equal-stamp compression remains
exact, including TS's expiration equality (`stamp <= now - 60000`).

At more than 65,536 distinct retained stamps, history converts to fixed
one-second buckets. Each count is represented by its bucket's exclusive END;
it expires at END + 60 seconds, at equality. A fractional trailing minute can
overlap 61 buckets. No count is lost: relative to an exact timestamp oracle,
overcount is confined to the one bucket containing the trailing cutoff. Reset
is the oldest occupied bucket's end + window, at most one second later than
that bucket's actual first event. A low limit stays exact under ordinary
admission; after conversion approximation persists until history empties,
even if the configured limit or live population falls below the cap.
Rollback of an unidentified bucket event retains conservative debt; the gateway
records only successful admissions, so it does not use that approximate rollback.
Storage is capped exact entries or about 61 bucket entries, never one allocation
per request. The full-process 80 MiB target still requires later benchmarking.

## Clock rollback and out-of-order events

Actual TS `SlidingWindow` appends in arrival order, removes only an expired
prefix, and never restores deleted stamps. It does not implement a historical
query database or filter future stamps from its count. Rust keeps a high-water
timestamp, clamps backdated records to it, and returns a fail-closed maximum
count on reads below it. Gateway high-water survives empty-ring eviction, so a
wall-clock rollback cannot make minute admission silently forget earlier usage.
Normal operation resumes at the high-water instant; clamped debt expires one
window later (plus at most the trailing bucket). This may refuse more than TS.
The one-bucket error bound applies only to ordered traffic. Neither implementation
promises exact historical reconstruction arbitrarily far into the past.

## Long-window seeds

SQL selects the newest capped rows (`ORDER BY at DESC LIMIT cap`) then reverses
them for ascending consumers, matching debit eviction. Aggregate admission sums
are unchanged and uncapped. Omitted older rows can make the reported reset later
than TS's store-derived oldest row, even after live population drops below cap
(for example after ongoing debits evicted older rows). Exact reset recovers once
all omitted rows expire; no blanket below-cap exactness guarantee is made.
