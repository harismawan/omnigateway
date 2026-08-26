# Second Independent Review — feat/websocket-transport (PR #103)

Reviewer: second pass, different model. Base: main. 11 commits, 74 files, +7619/-107.

## Verification actually run (not trusted from commit messages)

| Check | Result |
| --- | --- |
| `bun test` | **2636 pass / 0 fail**, 174 files, 24414 expect() |
| `bun run --cwd apps/dashboard test` | **456 pass / 0 fail**, 32 files |
| `bun run typecheck` | exit 0 |
| `bun run lint` | biome, 559 files, no fixes, exit 0 |
| `bun run build:dashboard` | exit 0 |

Suite is genuinely green. It is also green over both blockers below, which is the point.

## First round's fix — verified, and only half true

Commit 6c1cbfb ("cover the close ordering through a real socket") is a real
regression test. Verified by mutation: swapping the two lines in
`routes/stream.ts:230-231` gives **86 pass / 1 fail**, and the one failure is
that test. Not vacuous.

But it only covers **client-initiated** close. See BLOCKER 2 — the same
invariant is violated on every **server-initiated** close path, and the new
test cannot see it.

## BLOCKER 1 — `flush()` misreads Bun's send status; frame duplication + amplification

`apps/gateway/src/stream/registry.ts:157-172`

`flush()` treats a `send()` status of `<= 0` as "the frame did not go out" and
leaves it at the queue head to retry on `drain`. Bun's own typings
(`bun-types/serve.d.ts:21`, docs `server.mdx:588`) say: **"Bytes sent, 0 if
dropped, -1 if backpressure applied."** `-1` means uWS *already buffered the
frame and will deliver it*. Only `0` is a real drop.

So every backpressured frame is delivered once by uWS **and** re-sent by
`flush()` on the next drain — where it is buffered again, forever. It is not
just duplication, it is a self-feeding amplification loop that never advances
past `queue[0]`.

Measured against the real registry driven by a real Bun server and a stalled
raw-socket client (400 frames, 60 KiB each):

```
server: {"event":"published","stats":{"connections":1,"dropped":0,"queued":341}}
client: {"totalFrames":374,"uniqueSeqs":84,"duplicatedSeqCount":1,
         "sampleDuplicates":[[59,291]],"outOfOrderTransitions":290,
         "first":[0,1,2],"last":[81,82,83]}
```

seq 59 delivered **291 times**; seqs 84-399 never arrived at all; 290
out-of-order transitions on a topic whose contract is a monotonic sequence.
The comment on :153-155 claims draining stops early "because sending the ones
behind it would reorder the topic" — the code produces exactly the reordering
it says it prevents.

Why tests miss it: the stub at `apps/gateway/test/stream/registry.test.ts:33-37`
returns `-1` *and discards the frame*. That is not Bun's behaviour. The stub
encodes the bug as the specification.

Fix: treat `-1` as sent (shift it), queue only on `0`, and gate on
`ws.getBufferedAmount()` (`bun-types/serve.d.ts:295`) rather than on the return
status. Then fix the stub to model send/drop/buffer as three distinct outcomes.

## BLOCKER 2 — server-initiated closes never fire plugin `onClose`

`apps/gateway/src/stream/registry.ts:198-205` (`closeOne`)

`closeOne()` calls `detach(connection)` — which empties the topic set and drops
the connection from the map — **before** `socket.close()`. The route's `close`
handler (`routes/stream.ts:224-234`) then reads `deps.registry.topics(id)` and
gets `[]`. Every `onClose` handler goes unfired, silently. That is precisely
the failure CLAUDE.md rule 15 and the 6c1cbfb comment say must not happen; the
ordering is correct in the route and undone one layer below it.

Affects every server-side close: 4401 session expiry (:238), pong deadline
(:216), ping failure (:223), and `closeAll` on restart/shutdown (:338).

Proven with two probe tests against `streamHarness` — both fail on the branch
as shipped:

```
PROBE: server-initiated 4401 close fires plugin onClose   -> expected [ws_449095dd…], got []
PROBE: shutdown closeAll(1001) fires plugin onClose       -> expected [ws_2760d5f1…], got []
```

For the RC plugin this branch exists to unblock, this means a gateway restart
or a session expiry leaves the plugin believing every session is still live.

Fix: have `closeOne` close the socket first and let the route's close handler
do the detaching, or notify channels from inside `closeOne` before `detach`.

## SHOULD-FIX — a queue overflow on `stream:*` is a silent skip

`registry.ts:174-186` drops the oldest frame when the queue is full. On a
`stream:*` topic that breaks sequence continuity, and **the client never
notices**: `apps/dashboard/src/session/stream.tsx:304` does
`seen.set(topic, frame.seq)` with no comparison against `seen + 1`. Frames
5-7 dropped, frame 8 arrives, the console appends 8 after 4 and calls itself
current.

The spec is unambiguous (design doc lines 169-171): "Never claim gapless… Silent
skipping is the failure this class exists to prevent." The ring honours it; the
backpressure path does not. Either refuse to drop `stream:*` frames (close or
emit `gap` instead), or have the client treat a seq jump as a `gap`.

## SHOULD-FIX — a hung `revalidate` disables auth re-verification for the connection's life

`registry.ts:227-246`. `checking` guards against stacking, and `.catch` resets
it — but a promise that never settles leaves `checking === true` forever, so
that connection is never revalidated again. The 12h-session-expiry guarantee
("a socket must not outlive its session") quietly stops applying to it. Needs a
timeout, or a generation counter that expires the in-flight check.

## NIT — no per-connection topic cap

`routes/stream.ts:197`. Topic names are bounded to 128 chars
(`protocol.ts:61`) but the *count* is not. An authenticated admin can subscribe
to unlimited distinct `res:<random>` topics, growing `connection.topics` and the
registry `index`. Admin-only and reclaimed on disconnect, so low severity, but a
cap is cheap.

## NIT — journald cursor drops same-millisecond lines

`stream/console.ts:255` advances the cursor to the max `line.at`, and
`packages/control/src/console.ts:101` filters `line.at <= since` (strictly
newer). Two lines sharing a millisecond: the second is dropped from the stream
permanently. Plausible on a busy gateway at ms resolution.

## NIT — log rotation silently kills the file console stream

`stream/console.ts:191-202`. `fs.watch` holds the old inode when a file is
replaced; the topic stays declared, so the console keeps a subscription that
will never speak again. The code comments acknowledge this without handling it.
Acceptable while `OMNI_LOG_FILE` is documented as unrotated — worth a
`declareStream` retraction or a re-watch on `null` reads.

## NIT — `holds()` is O(n) allocation per frame

`stream/channels.ts:169-170` builds the whole topic array via
`registry.topics()` and `.includes()` on every inbound and outbound frame. On
the keystroke-latency channel this design exists to serve, that is an
allocation per keystroke. A `has(id, topic)` on the registry would do.

## Checked and found correct

- **Machine-token deferral is airtight.** `principal` is only ever
  `{kind:"admin"}`; bearer+cookie is refused (`stream.ts:102-107`), bearer alone
  fails `requireAdmin`. The `authorised` machine arm (`stream.ts:45`) is
  unreachable, and correctly scoped to its own `plugin:<id>:` prefix when it
  lands. No privilege bypass.
- **Plugin capability boundary holds.** `<id>` comes from the validated manifest
  via `channels.for(manifest.id)` (`loader.ts:147`); the plugin supplies only the
  tail, matched against `^[a-z0-9][a-z0-9:._-]{0,63}$`. Plugin id is
  `^[a-z][a-z0-9-]{0,31}$` — no colons — so no cross-namespace forgery. `opened`
  answers what exists, `authorised` decides who may hold it; opening a channel
  cannot widen reach. Confirmed against CLAUDE.md rule 15.
- **Elysia double-`beforeHandle`** claim verified in
  `elysia/dist/ws/index.js`; `drain` and `pong` are genuinely forwarded
  (:32-43). Server-side pong receipt verified empirically (9 pongs in 3s).
- **Coalescer** leading+trailing, no debounce re-arm, `stop()` clears both maps.
- **Ring** gap detection correct across never-pushed, past-head, evicted-head and
  post-`reset()` cases. Sequence wraparound not reachable in practice.
- **CLAUDE.md rules 12 and 15** updated consistently with the code; dashboard
  imports stay within the permitted set (`pushedLines.ts` deliberately restates
  the level filter rather than importing `@omni/control`).

## Verdict

**REQUEST CHANGES.**

Two blockers, both invisible to a green suite, both reproduced against real
sockets rather than argued from reading. BLOCKER 1 is a correctness failure on
the transport's core delivery path with a test stub that encodes the bug as
spec. BLOCKER 2 breaks the exact invariant the first review flagged, on every
path except the one the new test covers.

The design work here is genuinely strong — the documentation, the injected
seams, the ring's gap contract, the capability scoping are all better than
typical. The gap is that the tests are written against the same mental model as
the code, so where the model is wrong about the runtime (Bun's send status) or
about a second call path (server-initiated close), the suite agrees with the bug.
