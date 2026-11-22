# Smart-router scheduling

Accepted by the user (Nov 16) as the documented scheduling behaviour.

## What is fixed

For every check:

- the client response (status, headers, body, stream events);
- the routing decision (local or external) and the response model relabel;
- the destination of every classifier request: always the configured local-only
  classifier, never another provider, never confidential text to an external one;
- the parent request-log row, and the presence and status of the aggregated
  classifier row.

## What may vary

Around the first decisive classifier verdict (confidential, or a failure), the
router drops undecided siblings at the decision, including replies ready to poll
but not yet parsed. A refilled call is polled at once, so its request may already
have left when the decision arrives.

Consequently, depending on scheduling, runs may differ in:

- the number of classifier requests actually sent (for example 4 versus 5 for one
  check, on a first check or on a retry);
- the aggregated classifier row's attempts, tokens and cost;
- which verdicts end up cached, and therefore how many classifier requests later
  checks send.

The outcome varies between runs of the same binary; it is not deterministic.

## History

Awaiting stopped siblings (473d50fe) counted replies that had not been parsed;
41796e6f restored dropping undecided siblings. The readiness-controlled test
`stopped_ready_sibling_is_dropped_without_caching` pins this behaviour.
