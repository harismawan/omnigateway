# Final PR2 fix wave — I1, I2, I3

Status: DONE_WITH_CONCERNS (verification qualifications below; no known open Important finding).
Base: `03bf6015`. Implemented inline, no subagents, no push, no budget/ruling changes.

## Changes and self-review

- **I1:** supervisor always retains latest initialization gates, posts immediately only when running,
  and forwards deferred gates to a retained owner when it resumes. New owners initialize from latest
  gates. Real authenticated `adminRoutes` + real supervisor tests cover idle/no destinations, paused,
  and crash/backoff recovery: HTTP 200, committed retention value, `res:settings` invalidation, and
  latest gates on resume/restart. No generic-host lifecycle or route error policy changed.
- **I2:** both destination repositories implement a single SELECT joining the settings row, key row,
  and destination row. Its public result contains only policy booleans and destination identity,
  never config, encrypted/raw secrets, labels, or bodies. Both export readers delegate to this repo;
  SQLite's reopen forwarder forwards both arguments. Contract coverage runs on SQLite and PG17.
  After encoding/signing/gzip, every inline HTTP send, segmented metadata send, body segment, and
  413 retry takes a fresh snapshot. Admission compares generation/revision against the immutable
  snapshot used to prepare that sender (including its secret), not the mutable runtime destination.
  Synchronous boot-gate/signal/deadline checks remain immediately before transport.
  Sequential settings/key reads remain only as a cheap preflight for bounded metadata batching,
  never as final authorization. Initial denial retains metadata-only batching. Denial after body
  preparation stops without advancing the row cursor; attached reservations release in `finally`.
  Lease, epoch/cursor commits, retry schedules, secret/config snapshot preparation, segmentation,
  413 halving and dropped summaries are unchanged and covered by the export suite.
- **I2 linearization:** one database statement is the explicit policy linearization point. A change
  committed before its statement snapshot is observed; an edit after admission cannot retract an
  admitted network send. Cross-node/CLI writes require no local message. Each later segment is
  admitted independently. README, architecture, operations, spec and CLAUDE now state this boundary
  rather than promising instantaneous retraction.
- **I3:** pending and failed captures render distinct explanations, not capture-disabled advice.
  Active foreground pending queries poll every 1,000 ms; terminal/error/unmounted queries stop.
  Terminal previews remain excluded from general `res:logs` churn. Mounted pending→ready, terminal
  no-refetch after log invalidation, failed rendering/no polling, and pending unmount cleanup pass.

Self-review: all three Important requirements implemented; no unrelated refactors, no secrets in
new results/logs, no artifact or memory-budget redesign. Admission adds one small indexed-row
snapshot per body-bearing HTTP request, deliberately outside inference/main-thread work.

## RED / GREEN evidence

Logs live under `/tmp/opencode/` (not committed generated test output).

1. I1 RED: `bun test apps/gateway/test/routes/admin.test.ts --test-name-pattern 'settings commit and invalidate'`
   — **0 pass, 3 fail**, expected 200 / received 503 in idle, paused and recovering states
   (`final-i1-red.log`). GREEN same command: **3 pass**, 12 assertions (`final-i1-green.log`).
   Covering `bun test apps/gateway/test/exportHost apps/gateway/test/routes/admin.test.ts`:
   **144 pass**, 858 assertions (`final-i1-covering.log`).
2. I2 RED: `bun test apps/gateway/test/export/body/loop.test.ts --test-name-pattern 'consistent admission|every segment'`
   — **6 pass, 3 fail** (`final-i2-red.log`): inline and segmented historical destination/settings
   interleaving group sent one request despite expected zero; includeBodies change sent 11 segments
   rather than one. The original grouped test failed on its destination case before executing its
   settings case; final tests split all four mode/shape combinations so each independently executes.
   RED store: `bun test packages/store/test/contract/exportReader.test.ts --test-name-pattern 'body admission'`
   — **0 pass, 1 fail**, missing `r.bodyAdmission` (`final-i2-store-red.log`).
   GREEN focused interleavings: `bun test apps/gateway/test/export/body/loop.test.ts --test-name-pattern 'consistent admission'`
   — **4 pass**, 12 assertions (`final-i2-interleavings-green.log`). Tests preserve both historical
   prerequisite seams and place the equivalent committed edit before the replacement snapshot;
   no local notification is sent. Additional tests deny every subsequent segment after settings,
   key opt-out, revision, generation, enabled, includeBodies or deletion edits, test elapsed deadline,
   local cancellation during admission, and DB-only re-enable without notification.
3. I3 RED (from `apps/dashboard`):
   `bun test --preload ./test/setup/happydom.ts --preload ./test/setup/cleanup.ts ./test/features/bodyArtifact.test.tsx`
   — **1 pass, 2 fail**, missing Capture pending / Capture failed (`final-i3-red.log`).
   GREEN same command: **3 pass**, 9 assertions (`final-i3-green.log`).

Setup/correction diagnostics, not successes: first I1 draft mistakenly used a nonexistent harness
cookie, producing 401; corrected to authenticated `h.call`. Its first callback adapter passed the
route's boolean where the supervisor expects gates; corrected to the exact boot composition before
GREEN. First dashboard invocation omitted happy-dom preloads (document undefined); corrected above.
Initial covering run exposed the old resume message-list expectation; deferred gates now post only
when a change was actually pending. Tests that hooked the removed final destination read now hook
admission instead. Initial typecheck found optional edited.revision in a contract expectation;
explicit non-null narrowing corrected it. None of these outputs are represented as passing evidence.

## Verification

Services: dedicated `omni-sdd-pg17`, `postgres:17-alpine`, port **55434**, and
`omni-sdd-redis-final`, `valkey/valkey:8-alpine`, port **56379**. Existing PG18 on 55433 was
not replaced. Both dedicated containers left running. Bun **1.4.4**, matching CI.

Service prefix used below:
`OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni OMNI_TEST_REDIS_URL=redis://127.0.0.1:56379`.

| Exact command (with service prefix where noted) | Result / log |
|---|---|
| `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55434/omni bun test apps/gateway/test/export/body/loop.test.ts packages/store/test/contract/exportReader.test.ts apps/gateway/test/routes/admin.test.ts apps/gateway/test/exportHost` | 180 pass, 0 fail; `final-focused.log` |
| service prefix + `bun run test:all` | Root **5690 pass / 0 skip / 0 fail**, 342 files, 55,346 assertions; dashboard **829 pass / 0 fail**, 53 files, 2,524 assertions; `final-all.log` |
| service prefix + `bun test packages/store apps/gateway packages/control` | **3693 pass / 0 skip / 0 fail**, 221 files, 45,733 assertions; `final-affected.log` |
| service prefix + `bun test packages/store/test/contract/exportReader.test.ts apps/gateway/test/export` | Latest admission implementation/tests: **296 pass / 0 skip / 0 fail**, 24 files, 6,786 assertions; `final-i2-latest.log` |
| `bun run typecheck` | Core 736 files + dashboard 211 files clean; `final-typecheck.log` |
| `bun run lint` | 964 files, no fixes/diagnostics; `final-lint.log` |
| `bun run check:claims` | No stale claims, 23 removed symbols; `final-claims.log` |
| `bun run check:dead` | No dead exports, 224 changed files; `final-dead.log` |
| `bun install --frozen-lockfile` | 294 installs / 288 packages, no changes; `final-install.log` |
| `bun run build:dashboard` | Exit 0, production build + dashboard typecheck; `final-build.log` |

One whole-root run only. It preceded the final immutable prepared-identity strengthening and
independent interleaving/opt-out contract assertions; the affected run included the independent
interleavings, and the latest full export + both-backend reader contracts and typecheck/lint ran
after all implementation edits. Dashboard code did not change after its full 829-test run.
An extra local export-only run without service env recorded **260 pass / 1 expected PG skip**
(`final-export-latest.log`); it is superseded by the zero-skip service-enabled run above.

Expected diagnostics: root history negative fixture prints `missing-base` git error; isolated export
memory tests print `EXPORT_MEMORY_EVIDENCE`; dashboard negative fixtures print React act warnings
and deliberate route errors (including catalog unavailable); production build warns existing
AppShell route export is not code-split. Dead-export check reports existing common-word `state`/
`note` exclusions. No lint diagnostics. `graphify` executable is unavailable (`command -v graphify`
exit 1), so optional graph update could not run; source/contract checks used instead.

## Interfaces produced

```ts
// packages/store/src/types.ts
type BodyAdmissionSnapshot = {
  bodyLoggingEnabled: boolean;
  keyExists: boolean;
  keyBodyOptOut: boolean;
  destination: Pick<ExportDestination,
    "generation" | "revision" | "enabled" | "includeBodies"> | null;
};
// ExportDestinationRepo and ExportReader (both backends/readers):
bodyAdmission(id: string, keyId: string): Promise<BodyAdmissionSnapshot>;

// apps/gateway/src/export/deliver.ts — optional admission after encoding;
// existing synchronous beforeSend remains after it, immediately before transport.
type DeliverDeps = {
  admit?: () => Promise<void>;
  // existing fields unchanged
};
```

No HTTP wire or dashboard type changes. `ExportSupervisor.gatesChanged(gates: BodyGates): void`
and `useRequestBody(requestId: string | null): UseQueryResult<RequestBodyResponse>` signatures remain.

## Commits / concerns

- `55b6549e` fix(export): retain gates while worker unavailable
- `1ef43fc7` fix(export): admit body sends from one snapshot
- `3655748d` fix(dashboard): refresh pending body captures
- `416b3426` fix(export): bind admission to prepared identity

No known unaddressed Important finding. Accepted budget/default omission, at-least-once delivery,
and non-RSS-guarantee limitations remain unchanged. Polling is foreground-only and interval-bounded,
not an overall elapsed-time deadline; it stops on terminal/error/unmount. No live external receiver
interoperability, production load certification, or additional RSS guarantee is claimed.
