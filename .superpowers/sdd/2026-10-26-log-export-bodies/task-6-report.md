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
