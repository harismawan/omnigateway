# Task 6 — restore/import and body-writer shutdown

Status: DONE_WITH_CONCERNS. Base `44c5e326`. No subagents or push.

## Implementation

- Replaced the database route's single export hook with `workers: WorkerPause[]`; app supplies export and body hosts. Pause uses all-settled composition, so a fast refusal cannot roll back before a slow peer finishes pausing. Every worker resumes on pre-swap failure, or halts on `SwapFailedError`; a failed lifecycle callback cannot skip its peers. Successful restore reopens client admission only after both resume hooks cross the generation fence. Existing exclusive restore/import guard still covers the entire lifecycle.
- Collector options/parts retain the generation sampled before collection, including across the settings await and background `settle`. Host rejects old-generation handoffs before id/admission checks: release/count restore, no worker message, publication, or failure against the restored database. Old ACKs cannot affect even a newly admitted same-id capture.
- Restore closes admission, settles main publications, fails admitted unfinished rows serially against the original database (bounded 1000-entry map, no overflow-id queue), then waits for worker pause/closed handles. Every discarded capture counts `restore`. Worker-only resume cleanup removes fresh stale staging after quiescence; replacement threads clean before accepting buffered messages. Generic five-second pause ACK and termination/actual-close fence remain intact.
- Added `BodyWriterHost.drain()`: stops new admission but lets admitted slices/writes/publications finish for five seconds. Early completion stops gracefully; deadline discards/counts unfinished captures and immediately terminates instead of granting another generic grace period. Main publication/failure operations settle before drain resolves. Unknown publication decisions retain files and actual-close pending protection. A thrown publication is not treated as explicit refusal/unlink authorization, including a transaction that committed before its reply rejected.
- Shutdown starts writer drain concurrently with connection drain, without synchronous body stop in `stopLoops`. Store closure/exit waits for publication settlement even on deadline or second-signal escalation. Shutdown remains one-shot/idempotent at the store/exit boundary.
- Preserved hard queue admission, one-slot best-effort overflow/crash failure side channel, count/release behavior, sweep fallback, and worker-only parse/seal/filesystem ownership. No heavy main-thread body work or export request-path coupling.

## Files

- Runtime: `apps/gateway/src/{app,index,lifecycle,bodyCapture}.ts`, `routes/{database,proxy}.ts`, `bodies/{host,seal,writer}.ts`, `workerHost/instance.ts`.
- Tests: `apps/gateway/test/routes/database.test.ts`, `test/lifecycle.test.ts`, `test/bodyLogging.test.ts`, `test/bodies/{host,ownership,writer}.test.ts`.
- Documentation: `ARCHITECTURE.md` lifecycle/generation/shutdown ordering; this report.

## RED / GREEN evidence

1. `bun test apps/gateway/test/routes/database.test.ts` RED: **30 pass / 6 fail**. Updated harness supplied the required list interface, which old code ignored: missing pause/halt steps, and refusing export restore incorrectly returned 200. Added two-peer tests verify delayed pause rollback, either peer refusing, partial halt/resume failures, success and failed swap. `/tmp/opencode/task-6-swap-red.log`.
2. `bun test apps/gateway/test/bodies/host.test.ts` RED: **5 pass / 2 fail**. Late old-generation capture emitted a worker message after swap; `host.drain` absent. `/tmp/opencode/task-6-host-red.log`.
3. `bun test apps/gateway/test/lifecycle.test.ts` RED: **7 pass / 1 fail**. Connection deadline closed store while supplied writer/publication drain remained blocked. `/tmp/opencode/task-6-shutdown-red.log`.
4. GREEN expanded covering suite: `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway/test/bodies apps/gateway/test/bodyLogging.test.ts apps/gateway/test/lifecycle.test.ts apps/gateway/test/routes/database.test.ts apps/gateway/test/workerHost apps/gateway/test/exportHost` → **166 pass / 0 fail**, 10,999 assertions, 12 files. `/tmp/opencode/task-6-integration-final.log`.

Meaningful regressions include real SQLite snapshot/reopen with reused pending id and held old `written` ACK; delayed provider tail crossing generation change; pause ACK timeout then termination timeout/refusal and no replacement before actual close; real Bun thread pause/stop/close; staging preserved until handle quiescence then removed; five-second unwritten count/termination; successful admitted drain; real SQLite publication blocked before/after commit across drain expiry; post-commit publication rejection preserves readable owner file; existing stop/halt and refusal cleanup ownership cases remain green.

Intermediate integration failures were corrected, not skipped: unconditional await before normal slice ACK changed transfer reservation timing; now only actual resume cleanup waits. Publication rejection initially left an old test row pending; bounded failure handling is retained while unknown bytes survive. The timeout test initially created Bun's awaited rejection matcher before firing its fake clock; changed to captured rejection and asserted after driving both deadlines.

## Final verification

- `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway packages/control` → **2988 pass / 1 skip / 0 fail**, 26,532 assertions, 179 files. `/tmp/opencode/task-6-packages-final.log`. Final additional post-commit-rejection cases then passed in the 166-test covering rerun above.
- `bun run typecheck` → core 719 files + dashboard 210 files, no errors. `/tmp/opencode/task-6-typecheck-final.log`.
- `bun run lint` → 946 files, zero diagnostics. `/tmp/opencode/task-6-lint-final.log`.
- `bun run check:claims` → no stale claims, 22 removed symbols checked. `/tmp/opencode/task-6-claims-final.log`.
- `bun run check:dead` → no dead exports, 202 changed files checked; existing CLI `state`/`note` common-word notices only. `/tmp/opencode/task-6-dead-final.log`.
- `git diff --check` clean. Postgres left running. No dashboard code/imported wire types changed; dashboard typecheck passed, dashboard tests not required.

## Interfaces produced

```ts
// apps/gateway/src/routes/database.ts
export type WorkerPause = {
  pause(): Promise<void>;
  resume(swapped: boolean): Promise<void>;
  halt(): Promise<void>;
};
// DatabaseRouteDeps: required list, replaces exportWorker?: ExportPause.
workers: WorkerPause[];

// apps/gateway/src/bodies/host.ts, BodyWriterHost additions/changes
enqueue(parts: CapturedParts, generation?: number): void;
drain(): Promise<void>;
// enqueue defaults generation to parts.generation, then current generation
// for legacy direct callers. Production collectors always stamp it.
// Existing start/isPending/pause/resume/halt/stop/generation unchanged.

// apps/gateway/src/bodyCapture.ts
// Both BodyCollectorOptions and CapturedParts gain:
generation?: number;

// apps/gateway/src/routes/proxy.ts, ProxyDeps
bodyWriter?: Pick<BodyWriterHost, "enqueue"> & Partial<Pick<BodyWriterHost, "generation">>;
// AppDeps.bodyWriter remains complete BodyWriterHost.
// AppDeps.exportWorker uses Partial<WorkerPause> instead of Partial<ExportPause>.

// apps/gateway/src/workerHost/instance.ts, WorkerHost
stop(terminate?: boolean): void;
// true = immediate termination after owner grace expired; no extra five seconds.
// Retires/fences first; actual close still controls pending/replacement safety.

// apps/gateway/src/lifecycle.ts, ShutdownDeps
drain?: () => Promise<void>;
// Invoked once concurrent with connection drain; completion gates store close
// and exit, including forced shutdown. No change for callers without drain.
```

No protocol/store API changes. Task 7 should retain generation-fenced terminal disposal handling and drain settlement when adding reads.

## Self-review / concerns

- Worker grace is bounded to five seconds, but a hung **main database operation** can intentionally delay store closure/exit beyond that budget, even on escalation. Closing a connection underneath an unknown publication violates the required safety ordering; no cancellation/transaction-abort API exists here. This is the explicit concern behind DONE_WITH_CONCERNS, documented in architecture rather than claiming a five-second total process bound.
- During restore, serial failure writes are best effort; failure to update a row leaves existing stale-pending sweep as fallback. No unbounded per-overflow promise/id bookkeeping introduced.
- Existing synchronous `stop()` remains an immediate owner-retirement API for tests/other callers; production outer shutdown now uses `drain()`. Unknown owner files may remain until orphan reconciliation, intentionally safer than deleting committed bytes.
- Files remain scoped to lifecycle integration; no Task 5 rewrite or unrelated restructuring. Host grew modestly to accommodate actual graceful drain rather than relabelling immediate stop.

## Fix round 1 — I1–I4

Status: DONE. Read full `task-6-review.md` and controller ruling in `progress.md`. Base `fa5671dd`; no subagents/push. This section supersedes the original indefinite-shutdown-barrier concern and API semantics above.

### I1 — bounded quiescence and persistent old-operation barrier

- Body pause now starts generic worker pause immediately, concurrently with a five-second main-DB barrier. Worker ACK/termination retain their existing five-second/five-second bounds. A stuck DB operation refuses rather than authorizes swap; no unbounded pre-pause await remains.
- Actual outstanding publication/failure promises remain tracked across timeout and rollback. Every retry waits for those same operations. Timeout cancels further serial failure-sweep scheduling; there is no retained per-retry waiting-id queue or accumulated barrier promises. Generation and entry ownership checks prevent late rejected-publication continuations from initiating new fail/recovery operations after retirement. `resume(true)` additionally refuses if an old operation remains outstanding.
- Immediate worker pause must still allow already-started main publication decisions to finish. Pause carries their bounded id list; those worker waits remain open for explicit decisions until the existing ACK deadline. Other unknown waits abandon with null and preserve files. Generic host permits explicitly requested control replies during pause, never to a retired thread. The existing eight-cycle explicit-refusal cleanup regression stays green.
- Tests block failure writes and publications, repeat refused restore attempts, release the original operation, verify no delayed serial sweep/fail mutation, then recover successfully. Actual SQLite restore/reused-id stale-ACK coverage remains.

### I2 — immediate force and bounded normal shutdown

- Restored synchronous close/exit on explicit force or second signal, independent of a hung drain. Normal shutdown waits for server and writer concurrently only until the existing process deadline, then exits cleanly. Store/exit remains one-shot.
- Body drain returns at five seconds even if main bookkeeping remains unresolved. Unknown files/pending rows survive for existing reconciliation. Replaced the previous regression that asserted indefinite waiting; tests cover never-resolving drain, normal deadline, second signal and explicit force. SQLite blocked-before/after-commit drain cases now assert bounded completion while retaining readable owner bytes.
- Architecture updated: no claim that ownership requires indefinitely live process or forced shutdown waits on publication.

### I3 — recoverable publication-error retirement

- Added generic `recover()` lifecycle path: retire/fence current worker, request stop and bounded termination, suppress replacement beside a live old owner. Actual close starts normal restart backoff; final `stop()` and unsafe halt semantics unchanged.
- Publication rejection uses recoverable retirement, not final stop. Unknown files remain protected until actual close. Unit test proves one spawn before close, backoff afterward, then successful new publication. Real SQLite tests cover both pre-commit delayed path and committed-but-reply-lost errors, retain original artifact, close old thread, restart and publish/read a new request successfully.

### I4 — overlapping resume/pause

- Worker resume cleanup and handle-close/ACK transitions now run on one lifecycle chain. A synchronous epoch advance on pause/stop supersedes older resume admission immediately. Waiting parts/meta capture the epoch before awaiting cleanup and cannot escape after a newer pause; queued writes also check epoch. Host admission resume completion is similarly epoch-fenced.
- Regression overlaps resume, waiting part/meta, and pause. No ACKed slice/write can escape the pause, post-ACK meta stays rejected, and a subsequent valid resume accepts new-generation work. Existing real-thread close, staging cleanup and generic/export lifecycle tests remain green.

### RED / GREEN

- I1 RED: `bun test apps/gateway/test/bodies/host.test.ts -t 'timed-out database barrier'` → **0 pass / 1 fail**: blocked DB prevented any `pause` message. `/tmp/opencode/task-6-r1-I1-red.log`.
- I2 RED: `bun test apps/gateway/test/lifecycle.test.ts` → **7 pass / 2 fail**: never-resolving drain prevented normal and explicit force exit. `/tmp/opencode/task-6-r1-I2-red.log`.
- I3 RED: `bun test apps/gateway/test/bodies/host.test.ts -t 'retires recoverably'` → **0 pass / 1 fail**: final stop produced no restart/backoff timer after actual close. `/tmp/opencode/task-6-r1-I3-red.log`.
- I4 RED: `bun test apps/gateway/test/bodies/writer.test.ts -t 'newer pause'` → **0 pass / 1 fail**: stale resume emitted slice-ACK and `unowned`/write after pause. `/tmp/opencode/task-6-r1-I4-red.log`.
- Individual GREEN logs: `/tmp/opencode/task-6-r1-I{1,2,3,4}-green.log` (I2 includes real ownership tests; I3 includes generic/export hosts).
- Final covering GREEN: `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway/test/bodies apps/gateway/test/bodyCapture.test.ts apps/gateway/test/bodyLogging.test.ts apps/gateway/test/lifecycle.test.ts apps/gateway/test/routes/database.test.ts apps/gateway/test/workerHost apps/gateway/test/exportHost` → **198 pass / 0 fail**, 11,174 assertions, 13 files. `/tmp/opencode/task-6-r1-cover-final.log`.
- Intermediate failures fixed: immediate pause originally abandoned an explicit refusal before cleanup; added known-publication handshake above. Fake timeout selected the DB timer before generic timer when barrier was already done; now clears completed DB timer immediately. Typecheck required explicit BodyMeta test type and proper pause narrowing; fixed without casts/any.

### Required checks

- `bun run typecheck`: core 719 + dashboard 210 files, no errors. `/tmp/opencode/task-6-r1-typecheck.log`.
- `bun run lint`: 946 files, zero diagnostics. `/tmp/opencode/task-6-r1-lint.log`.
- `bun run check:claims`: no stale claims, 22 removed symbols. `/tmp/opencode/task-6-r1-claims.log`.
- `bun run check:dead`: no dead exports, 202 changed files; unchanged CLI common-word notices. `/tmp/opencode/task-6-r1-dead.log`.
- `git diff --check` clean. Scoped covering reruns per request; no unrelated full-package rerun or dashboard code changes. Postgres left running.

### Exact interface changes

```ts
// WorkerHost<In, Out> (workerHost/instance.ts)
post(message: In, duringPause?: boolean): void;
recover(): Promise<void>;
// duringPause only permits current-live-instance control replies while paused.
// recover is serialized, non-final retirement; backoff starts at actual close.

// MainMessage (bodies/protocol.ts), lifecycle pause arm:
| { type: "pause"; publications?: string[] }
// Bounded ids whose main publication already began. Their waits can receive a
// definite decision while pausing; omitted ids preserve unknown files instead.
```

No other public signature changes. `BodyWriterHost.drain()` now honors its five-second bound rather than waiting indefinitely for DB work; `ShutdownDeps.drain` is bounded by the outer process deadline and bypassed on force. `pause()` retains actual outstanding DB operations as a persistent swap barrier but bounds each attempt; `resume(true)` guards against bypassing it.

Self-review: all I1–I4 verified at their actual async boundaries. No overflow metadata/ids or unbounded failure side channel introduced. Forced exit may leave pending rows/orphans, explicitly accepted by controller ruling; unknown outcome never authorizes deleting committed files. No remaining concerns identified in this round.

## Fix round 2 — R1/I1 stable barrier and R2 retired-thread deadline

Status: DONE. Base `ac6e91c1`. Read `task-6-rereview-1.md` in full. Only R1 and R2 changed; accepted I2–I4 behavior retained. No subagents/push.

### R1 — operation-set fixed point before swap

- The bounded pre-swap DB barrier now drains the actual outstanding-operation set until empty, not one initial `Promise.all` snapshot. A publication rejection that schedules `failPending` therefore cannot resolve pause while that newly added operation is still blocked. Existing five-second bound and persistent tracking across refused retries remain.
- Publication settlement no longer awaits serialized `worker.recover()`. Recovery is independently scheduled lifecycle work, not a DB operation; DB settlement cannot depend on generic pause completing first. This avoids the publication → recovery → pause dependency cycle while preserving recoverable retirement, entry/generation guards and ambiguous-file ownership.
- Added ACK and actual-close variants: hold publication, start pause, reject during pause, block follow-up failure, then supply pause ACK or thread-close. Both remain pending, refuse at the DB deadline, refuse a retry without advancing generation, and succeed only after the actual failure operation settles. The test does not rely on the too-late `resume(true)` guard.

### R2 — immediate termination covers retired owners

- `WorkerHost.stop(true)` now terminates every live retiring instance, not just a current worker. It can also escalate after an earlier final graceful `stop()`. Final state suppresses replacement; actual close still alone releases pending-path protection.
- Body drain early completion after recovery now immediately terminates the already-retired live owner rather than leaving recovery's new five-second timer as another grace. Normal running-writer early drain retains its existing graceful stop behavior. Original deadline still calls immediate stop for all owners.
- Added generic regressions for recovering/uncooperative threads, including immediate escalation after final graceful stop; close callback not delivered by `terminate` must remain undelivered until actual close, and no replacement starts afterward.
- Body-host regressions use an advancing clock: recovery starts 4.9 seconds into drain, termination occurs at the original five-second deadline (not recovery's 9.9-second deadline); with immediate failure bookkeeping, early drain completion also terminates the retired owner. Both retain pending path protection until explicit close, clear timers at close, and never restart after final stop.

### RED / GREEN evidence

- R1 RED: `bun test apps/gateway/test/bodies/host.test.ts -t 'rejection during pause includes'` → **0 pass / 2 fail**. Both ACK and close variants unexpectedly resolved pause with follow-up fail blocked (`Expected "pending", Received "resolved"`). `/tmp/opencode/task-6-r2-R1-red.log`.
- R1 GREEN: `bun test apps/gateway/test/bodies/host.test.ts` → exit 0. `/tmp/opencode/task-6-r2-R1-green.log`.
- R2 RED: `bun test apps/gateway/test/bodies/host.test.ts apps/gateway/test/workerHost/instance.test.ts -t 'immediate stop terminates|late recovery cannot'` → **0 pass / 3 fail**. Original drain deadline termination count remained zero; both generic retired-thread cases reported `terminated=false`. `/tmp/opencode/task-6-r2-R2-red.log`.
- R2 early-completion RED: `bun test apps/gateway/test/bodies/host.test.ts -t 'late recovery cannot'` after the generic fix → **1 pass / 1 fail**. Deadline variant passed; early completion still retained the uncooperative retired thread. `/tmp/opencode/task-6-r2-R2-early-red.log`.
- R2 GREEN: `bun test apps/gateway/test/bodies/host.test.ts apps/gateway/test/workerHost apps/gateway/test/exportHost` → exit 0. `/tmp/opencode/task-6-r2-R2-green.log`.
- Final covering GREEN: `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway/test/bodies apps/gateway/test/bodyCapture.test.ts apps/gateway/test/bodyLogging.test.ts apps/gateway/test/lifecycle.test.ts apps/gateway/test/routes/database.test.ts apps/gateway/test/workerHost apps/gateway/test/exportHost` → **204 pass / 0 fail**, 11,217 assertions, 13 files. `/tmp/opencode/task-6-r2-cover.log`.
- `bun run typecheck` → core 719 + dashboard 210 files, no errors. `/tmp/opencode/task-6-r2-typecheck.log`.
- `bun run lint` → 946 files, zero diagnostics. `/tmp/opencode/task-6-r2-lint.log`.
- `bun run check:claims` → no stale claims, 22 removed symbols. `/tmp/opencode/task-6-r2-claims.log`.
- `bun run check:dead` → no dead exports, 202 changed files; unchanged CLI common-word notices. `/tmp/opencode/task-6-r2-dead.log`.
- `git diff --check` clean before commit. Scoped covering checks as requested, Postgres left running; no dashboard code/types changed.

### Interfaces / self-review

No new or changed public signatures or protocol messages. Existing `WorkerHost.stop(terminate?: boolean): void` now honors `true` for **all live retiring instances**, including after final graceful stop. Existing `BodyWriterHost.pause(): Promise<void>` guarantees stable-empty actual DB operation tracking before success; recovery scheduling is not part of that DB barrier. Existing drain/publication-generation/ownership APIs unchanged.

Self-review: reviewed actual operation additions/deletions and pause/recover serialization, not only final state checks. Timed-out attempts retain only real outstanding operations, do not gain another failure-id queue, and do not authorize swap via a post-swap check. Default shared exporter stop behavior unchanged. Immediate termination does not imply close, does not delete ambiguous bytes, and does not revive final hosts. No remaining concerns identified for R1/R2.
