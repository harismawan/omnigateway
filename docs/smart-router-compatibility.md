# Smart-router scheduling difference

Accepted by the user (Nov 16) as a documented difference from frozen TypeScript.

## What is the same

For every check, Rust and frozen agree on:

- the client response (status, headers, body, stream events);
- the routing decision (local or external) and the response model relabel;
- the destination of every classifier request: always the configured local-only
  classifier, never another provider, never confidential text to an external one;
- the parent request-log row, and the presence and status of the aggregated
  classifier row.

## What may differ

Around the first decisive classifier verdict (confidential, or a failure), the two
runtimes stop the remaining work at different points:

- Frozen starts the next segment's call (and counts it in `calls`, hence in the
  row's `attempts`) before the abort reaches `fetch`, so a counted call may never
  be sent. It may also have parsed a sibling reply that completed at the same
  moment, which it counts and caches.
- Rust drops undecided siblings at the decision, including replies ready to poll
  but not yet parsed. A refilled call is polled at once, so its request may already
  have left when the decision arrives.

Consequently, depending on scheduling, the two may differ in:

- the number of classifier requests actually sent (for example 4 versus 5 for one
  check, on a first check or on a retry);
- the aggregated classifier row's attempts, tokens and cost;
- which verdicts end up cached, and therefore how many classifier requests later
  checks send.

The outcome varies between runs of the same binary; it is not deterministic on
either side.

## History

Awaiting stopped siblings (473d50fe) counted replies frozen's fetch had not
parsed and made black-box parity worse; 41796e6f restored dropping undecided
siblings. The readiness-controlled test `stopped_ready_sibling_is_dropped_without_caching`
pins the Rust side of this difference.
