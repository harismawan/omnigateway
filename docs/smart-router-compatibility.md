# Smart-router scheduling difference

At the first decisive classifier verdict (confidential or failure), Rust drops
undecided siblings, including replies ready to poll but not yet parsed. Frozen
TypeScript may already have parsed such a sibling and count/cache its verdict.
Simultaneous completion can therefore differ in the aggregate classifier row's
attempts, tokens, cost, and subsequent cache warmth. Client response, routing
decision, and upstream requests for the decisive check are unchanged.

This intentionally restores the pre-473d50fe behavior: awaiting stopped siblings
counted replies frozen fetch had not parsed and made black-box race parity worse.
The readiness-controlled `stopped_ready_sibling_is_dropped_without_caching` test
pins the Rust side of this documented difference.
