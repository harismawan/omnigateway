# PR278 CI failure fix

Starting head: `3043c0d5`; base branch: `feat/log-export`.
Status: **DONE**. Both CI failures diagnosed and fixed; all CI checks pass locally.
CI run: `40504092665`. Implemented inline; no subagents or push.
CI totals: **5688 pass / 2 fail**, 5690 tests, 342 files; dashboard was not reached.

## Diagnosis before edits

Read `CLAUDE.md`, the systematic-debugging skill, the export design, both actual failing tests,
their shared fixture, worker spawners/build definitions, and the route/authentication/capture paths.
The working tree was clean. Bun **1.4.4**, matching CI.

1. **Missing-worker negative control races two independently exiting threads.**
   `scripts/test/build-npm.test.ts` bundles `workerProbe.ts` without either worker entry.
   The probe now starts both `spawnExportWorker` and `spawnBodyWriter`; either `onExit` prints
   its own diagnostic then exits 1. Nothing orders those exits, and production does not require
   such ordering. CI lines 79–97 show `body writer died` instead of `worker died`.
   Before edits, 30 independent runs of
   `bun test scripts/test/build-npm.test.ts -t 'bundled gateway'` failed **8/30** with this mismatch.
   Log: `/tmp/opencode/pr278-build-baseline.log`.
   The positive bundle already requires both an export preview response and a body-writer pause
   acknowledgement, so this was not evidence of an omitted production worker.

2. **Idle turns do not mean asynchronous request setup has completed.**
   `apps/gateway/test/bodies/capture.test.ts` released another upstream frame after 50
   `setImmediate` turns with no client output, even before receiving a response head.
   The route first authenticates via async `crypto.subtle.digest` and store reads, then performs
   capture/settings/request setup before dispatch consumes any released frames. Real async I/O
   can remain pending while arbitrarily many immediates run. Thus already-released frames could
   accumulate before dispatch started, producing different release/client interleavings without
   changing a single response byte. CI lines 5102–5198 show exactly that: releases 3 and 4 moved
   before the initial client events; byte equality had already passed.
   Unmodified test: **0/30 failures** locally (`pr278-capture-baseline.log`).
   Controlled RED: a temporary preload delayed only the captured request's authentication digest
   (fourth digest in this isolated test, after both seed hashes and bare authentication) by 20 ms.
   Command:
   `bun test --preload /tmp/opencode/pr278-delay-digest.ts apps/gateway/test/bodies/capture.test.ts -t 'same turns'`.
   Result: **0 pass, 1 fail**, exact transcript mismatch, byte equality still passing; releases 3–16
   preceded the initial client output (`pr278-capture-controlled-red.log`). The preload delegates
   to the real digest and changes neither capture nor dispatch. It is diagnostic-only, not committed.

   Reproducible preload (`/tmp/opencode/pr278-delay-digest.ts`):

   ```ts
   const digest = crypto.subtle.digest.bind(crypto.subtle);
   let calls = 0;
   crypto.subtle.digest = async (...args: Parameters<typeof digest>) => {
     if (++calls === 4) await Bun.sleep(20);
     return digest(...args);
   };
   ```

   The executed preload additionally prints when the fourth call is held; run this probe only
   with the isolated stream test so the seed/authentication call numbering is unambiguous.

These are nondeterministic test assumptions, not a demonstrated production ordering bug. The
collector's tee/drain starts without awaiting capture; client frame recording is synchronous;
the route hands the adapter its branch immediately. The replacement handshake below exercises
that actual production path, including midstream abandonment, with future input withheld.

## Smallest fix / changed semantics

Only two test files change; no production or shared-fixture behavior changes.

- **npm probe:** keep the exact successful preview assertion, additionally require exit 0, and
  make two independent controls: omit export while retaining the real body-worker bundle;
  omit body while retaining the real export-worker bundle. Bundle the control with the same
  explicit sibling URLs. Require each specific diagnostic **and exit 1**, not either acceptable
  message from a race. This strengthens coverage of each missing entry individually.
- **stream:** remove the idle-turn heuristic. Release the three frames needed to commit on the
  first text delta, await their three client events, then release each remaining delta/block stop
  only after the preceding output arrives. Release terminal usage/stop together because the
  Anthropic decoder emits completion on `message_stop`. A 2-second deadlock watchdog is a failure
  bound, never a criterion for releasing more input. Byte equality, exact controlled transcript
  equality, all 12 deltas, midstream budget exhaustion, omitted artifact, released reservations,
  and uncaptured absence assertions remain. Failure cleanup releases upstream to let the stream
  finish. The test proves no dependency on later upstream input; it deliberately does not equate
  two executions' event-loop counts or claim a wall-clock latency benchmark.

## RED / GREEN and fault sensitivity

All logs below are in `/tmp/opencode/`; temporary mutations were applied individually and removed.

| Experiment | Result | Log |
|---|---|---|
| Original npm control, 30 independent processes | 8 fail / 22 pass | `pr278-build-baseline.log` |
| Original stream test, 30 independent processes | 30 pass | `pr278-capture-baseline.log` |
| Original stream + 20 ms authentication delay | 1 fail, byte-identical / transcript differs | `pr278-capture-controlled-red.log` |
| Fixed stream + identical delay | 1 pass, 9 assertions | `pr278-capture-controlled-green.log` |
| Fixed npm test, 30 independent processes | 30 pass / 0 fail | `pr278-build-repeated-green.log` |
| Fixed stream + identical delay, 30 independent processes | 30 pass / 0 fail | `pr278-capture-repeated-green.log` |
| Remove export entry from real `bundleGateway` | 1 fail: expected successful preview, got `worker died` | `pr278-export-entry-mutant-red.log` |
| Remove body entry from real `bundleGateway` | 1 fail: expected successful preview, got `body writer died` | `pr278-body-entry-mutant-red.log` |
| Buffer captured adapter branch through EOF before delivering any byte | 1 fail: `client stalled before event 3` | `pr278-capture-buffering-mutant-red.log` |
| Restore all mutations; both affected test files | 18 pass / 0 fail, 94 assertions | `pr278-focused-green.log` |

## Verification

Service prefix:
`OMNI_TEST_REDIS_URL=redis://127.0.0.1:56379 OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni`.
Existing dedicated Valkey and PostgreSQL 17 services were reused, not restarted or removed.

| Command | Result / log |
|---|---|
| Service prefix + `bun test scripts/test/build-npm.test.ts scripts/test/build-binary.test.ts apps/gateway/test/bodies apps/gateway/test/bodyLogging.test.ts apps/gateway/test/export packages/store/test/contract/bodies.test.ts` | **420 pass / 0 fail**, 34 files, 17,937 assertions; `pr278-covering-green.log` |
| Service prefix + `bun run test:all` | Root **5690 pass / 0 skip / 0 fail**, 342 files, 55,352 assertions; dashboard **829 pass / 0 fail**, 53 files, 2,527 assertions; `pr278-test-all-complete.log` |
| `bun run typecheck` | Core 736 files + dashboard 211 files clean; `pr278-typecheck.log` |
| `bun run lint` | 964 files, no diagnostics/fixes; `pr278-lint.log` |
| `bun run check:claims` | No stale claims, 23 removed symbols; `pr278-claims.log` |
| `bun run check:dead` | No dead exports, 224 changed files; `pr278-dead.log` |
| `bun install --frozen-lockfile` | Exit 0; `pr278-install.log` |
| `bun run build:dashboard` | Exit 0, production build + dashboard typecheck; `pr278-dashboard-build.log` |

Initial `test:all` invocation was terminated by the
tool's explicitly configured 120-second timeout, with no `(fail)` lines and no test totals
(`pr278-test-all.log`); it is not passing evidence. The successful complete rerun had no command
timeout. All final tests/checks ran after diagnostic production mutations were removed; the final
production diff is empty.

Known qualifications: graphify executable/cache absent (`command -v graphify` exits 1), so graph
update unavailable; source was inspected directly. Dead-export check retains its pre-existing
common-word `state`/`note` exclusions. No production semantics changed and no known production
ordering defect remains from these two failures. CI has not been rerun remotely; no push authorized.
Expected diagnostics: history negative fixture prints `missing-base`; memory subprocesses print
`EXPORT_MEMORY_EVIDENCE`; dashboard negative fixtures print React act warnings and deliberate
route errors including `catalog unavailable`. Dashboard build retains its existing AppShell
code-splitting warning. None is a failing assertion or new lint/typecheck diagnostic.

## Review follow-up: restore deterministic delivery timing coverage

Review: `ci-fix-review.md`, Important finding against `4021d202`. Worker fix approved and
unchanged. Scope of this follow-up is only `capture.test.ts` plus this report; no production
changes, subagents, or push. The earlier handshake was insufficient to detect capture-only
pacing: slowing delivery also slowed each later release, preserving both transcripts.

### Reproduce the reviewer's negative control

Full executed preload, saved at `/tmp/opencode/pr278-review-delay.ts`:

```js
const originalTee = ReadableStream.prototype.tee;
let delayed = 0;
ReadableStream.prototype.tee = function (...args) {
  const [adapter, capture] = originalTee.apply(this, args);
  return [adapter.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      delayed++;
      await Bun.sleep(50);
      if (delayed === 17) console.error("REVIEW_PROBE: all 17 captured upstream frames delayed 50ms each");
      controller.enqueue(chunk);
    },
  })), capture];
};
```

Exact command (both before and after the test change):

```sh
bun test --preload /tmp/opencode/pr278-review-delay.ts apps/gateway/test/bodies/capture.test.ts -t 'before more upstream input'
```

- **Before:** 1 pass, 0 fail, 9 assertions; diagnostic confirms all 17 captured frames delayed.
  `/tmp/opencode/pr278-review-delay-before.log` (1103 ms). This confirms the review finding,
  not a passing fault-sensitivity result.
- **After:** 0 pass, 1 fail. Bytes and handshake transcripts still match; the new timing assertion
  fails with twelve **50** values against twelve **0** values, not a watchdog/global deadline.
  `/tmp/opencode/pr278-timing-delay-red.log`. Repeated on final code: **10/10 fail**, always
  the timing equality (`pr278-timing-final-repeat-delay.log`). The diagnostic still confirms all
  17 frames pass through the delayed adapter branch. The preload is not committed.

### Test change and deterministic boundary

- Keep the existing handshake, exact bytes/transcript, budget exhaustion/omission, reservation,
  and uncaptured absence assertions.
- Real authentication, store/settings reads, request setup, and stream commit run with real
  timers. Receiving the first three client events is the explicit setup-complete barrier;
  no number of quiet turns can satisfy it.
- Only then enable Bun's built-in fake timers at `NOW`. They control `setTimeout` **and
  `Bun.sleep`**, as verified by the exact reviewer preload, without mocking production methods.
  Capture a real `setImmediate` checkpoint before installing fake timers. After releasing each
  remaining available delta/block-stop frame, that checkpoint lets runnable stream/promise jobs
  drain without advancing virtual time. All upstream data needed for that event is already
  available; fixture/store setup cannot still be pending on this path.
- If the event waits on a timer, advance to that timer and record the virtual elapsed time.
  Twelve measurements cover the eleven remaining deltas and block stop, including the frame
  that exhausts the budget and the abandoned remainder. Assert bare values are twelve zeros
  and captured values exactly equal bare. No elapsed wall-clock threshold decides success;
  slowing CI does not advance this clock. The bounded timer-advance loop detects a stream that
  never supplies its next event; it is not an allowed latency budget.
- Restore real timers in `finally` before terminal usage/stop, stream completion, artifact
  publication, or writer cleanup. Preserve the original real-time deadlock watchdog outside
  the measured window. No production seam is necessary. Startup and terminal bookkeeping are
  deliberately outside the timing comparison, not claimed to have zero latency.

### Final follow-up verification

Bun **1.4.4**. Logs in `/tmp/opencode/`.

| Exact command / experiment | Result / log |
|---|---|
| `bun test apps/gateway/test/bodies/capture.test.ts -t 'before more upstream input'`, 30 independent processes | **30/30 pass**, each 35 assertions; `pr278-timing-final-repeat-normal.log` |
| Same command with `--preload /tmp/opencode/pr278-delay-digest.ts`, 30 independent processes | **30/30 pass** despite the real 20 ms captured-authentication delay; `pr278-timing-final-repeat-auth.log` |
| Same command with `--preload /tmp/opencode/pr278-review-delay.ts`, 10 independent processes | **10/10 fail** at the new timing assertion; `pr278-timing-final-repeat-delay.log` |
| Service prefix above + `bun test apps/gateway/test/bodies apps/gateway/test/bodyLogging.test.ts scripts/test/build-npm.test.ts scripts/test/build-binary.test.ts` | **101 pass / 0 fail**, 10 files, 10,692 assertions; `pr278-timing-covering-final.log` |
| `bun run typecheck` | Core 736 files + dashboard 211 files clean; `pr278-timing-typecheck-green.log` |
| `bun run lint` | 964 files, no diagnostics/fixes; `pr278-timing-lint-final.log` |
| `bun run check:claims` | No stale claims; `pr278-timing-claims.log` |
| `bun run check:dead` | No dead exports; existing `state`/`note` exclusions; `pr278-timing-dead.log` |

An initial typecheck found that Bun's runtime `jest.now()` is not declared in its pinned types
(`pr278-timing-typecheck.log`). Replaced it with typed `Date.now()`, which reads the same fake
clock; all final repetitions, covering tests, and checks above follow that correction.
Per request, no redundant whole-suite run: prior full-suite evidence remains above, and this
test-only follow-up runs all body tests and both build packaging suites plus checks. Graphify
remains unavailable. No known open scoped finding; remote CI remains unrun/unpushed.
