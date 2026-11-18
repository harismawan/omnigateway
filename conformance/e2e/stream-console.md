# A9 console and pressure boundaries

Run `bash conformance/e2e/stream-ns.sh FROZEN RUST PRIVATE_WORK` from this
worktree. It scrubs inherited environment and uses a loopback-only namespace.
The work directory must be new; failed evidence is never removed or reused.

`stream-console.py` compares REST JSON values and decoded event objects,
normalizing only private file paths. Journal tests install a private executable
stub; they never invoke the host journal. REST object key order is not asserted.
ConsoleFleet remote and `node=all` merging remain D4, not local-console parity.
RFC3339 parsed timestamps are covered; the full JavaScript Date.parse language
is not. Non-Linux file watching is not implemented. The source task is eager:
file inotify has no idle timer; journal preserves boot cursor/replay by polling
even without subscribers. Linux inotify remains armed without subscribers so
replay records the same source deltas. Logging format itself predates A9.

`stream-pressure.py` stops actual TCP reads after acknowledgment, appends 32
256KiB lines on distinct source floors, captures queue/drop metrics and process
RSS/HWM, resumes reads, and asserts sequences 1..32 and line indices 0..31.
Queue occupancy proves backpressure reached the registry; identical survivors
prove resumption without duplication. This does **not** saturate the queue1000
boundary. With two permitted local console topics and >=250ms source floor,
even subscribing to both cannot supply 1000 frames before frozen closes a
compliant socket at its <=80s shared pong deadline. No test-only publisher or
lifetime bypass is permitted. Drop-oldest remains covered by the real Hub's
deterministic 1100-frame unit test, not by a claimed black-box saturation.
Finite process memory samples include parsing/source/replay and boot costs;
they do not establish equivalent memory growth classes.

The composition is a repeatable acceptance subset, not a declaration that D4,
B10 quota publishers, A10 swap invalidation, black-box 12-hour expiry, exhaustive
JSON/date parsing, or warning-log parity were verified. Existing handshake
header normalization and frozen raw-pong callback bug remain unchanged.
