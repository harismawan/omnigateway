# Bounded limiter history

Minute history is independent of configuration, including concurrency-only
subjects. Lowering, disabling or arbitrarily raising a limit discards nothing.
For finite ordered millisecond timestamps, equal-stamp compression remains
exact, including expiration at equality (`stamp <= now - 60000`).

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

The minute window appends in arrival order, removes only an expired prefix, and
never restores deleted stamps. It is not a historical query database and does
not filter future stamps from its count. The limiter keeps a high-water
timestamp, clamps backdated records to it, and returns a fail-closed maximum
count on reads below it. Gateway high-water survives empty-ring eviction, so a
wall-clock rollback cannot make minute admission silently forget earlier usage.
Normal operation resumes at the high-water instant; clamped debt expires one
window later (plus at most the trailing bucket). Clamping is conservative: it
can refuse requests an unclamped history would admit.
Once any record is clamped, `forget` retains all rollback debt until the
retained history drains: original timestamps and the reverse-scan stopping
point are no longer known. Repeated forget calls cannot remove ambiguous
representatives. One boolean records this ambiguity, so memory remains bounded.
Fresh ordered history after draining regains exact forget behavior; continuous
traffic may retain the conservative forget restriction longer than one window.
The one-bucket error bound applies only to ordered traffic. The window does not
promise exact historical reconstruction arbitrarily far into the past.

## Long-window seeds

SQL selects the newest capped rows (`ORDER BY at DESC LIMIT cap`) then reverses
them for ascending consumers, matching debit eviction. Aggregate admission sums
are unchanged and uncapped. Omitted older rows can make the reported reset later
than the store-derived oldest row would give, even after live population drops
below cap (for example after ongoing debits evicted older rows). Exact reset
recovers once all omitted rows expire; no blanket below-cap exactness guarantee
is made.