# A9 step 2 boundaries

Migration-wide HTTP comparison ignores header-name case and header order only.
`stream-handshake.ts` (including `raw` mode) compares the exact status line,
header multiset (lowercased names, byte-exact values except masked Date values),
and exact body/frame bytes. No header is excluded. Multiplicity is preserved.
Frozen missing-key content-type is already `text/plain;charset=utf-8`; HEAD
already has `content-length: 71`. Those checkpoint differences were name case,
not values. The real presence mismatch was bad-version's extra Hyper CL:0.

## Expiry

Frozen 1780bb39: `apps/gateway/src/app.ts` fixes TTL at 12 hours and supplies
the application clock; `packages/control/src/adminAuth.ts` issues every kind
with that TTL, verifies both KV presence and expiresAt, and returns null on
expiry. `packages/coord/src/index.ts` memory KV lazily expires entries.
No binary clock/TTL option or short-session HTTP minting route was found.
`routes/stream.ts` refuses null at upgrade (401, `a session is required`),
and revalidates the same token. `stream/registry.ts` asks on the next shared
20-second tick and closes false with 4401 / `session expired`, identically for
expiry and revocation; thrown verification is not false.

Rust regression uses real AdminAuth/MemoryKv with injected clock, expires a
short record (not logout), exercises the upgrade decision, and runs the actual
connection loop on a duplex transport at a nonzero shared heartbeat phase.
Black-box expired-session parity is **unverified**, not replaced by revocation.

## Backpressure

Frozen `stream/registry.ts`: capacity 1000, drop oldest, cumulative drop/queued
metrics, stop sending at 512 KiB, retry unsent head on drain; accepted buffered
sends are not retried. Bun defaults: backpressureLimit 16 MiB,
closeOnBackpressureLimit false. No overflow close or notice is generated.
`broadcaster.ts` delivers via registry after resource coalescing; stream frames
are sequenced, not coalesced. Rust regression covers exact retained sequence,
100 drops from 1100 frames, blocked drain at 16 MiB, resumption without
duplicate frames, and connection retention. The writer owns accepted frames;
only failed channel sends requeue the head. Stats feed existing stream metrics.

Publishers are intentionally not installed in step 2. Paired many-event
slow-reader experiments, OS/Bun buffer equivalence, warning-log parity and
overflow under production event timing remain **unverified**; the paired
experiment belongs to step 4 after step 3 publishers, not a fake socket result.
