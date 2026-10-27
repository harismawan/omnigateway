# Log export, part 2: bodies — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store request bodies whole up to 64 MiB without touching the main thread's event loop, and let export destinations attach them to exported records.

**Architecture:** Capture keeps raw text on the main thread under a global byte budget and hands it to a dedicated **body writer** Bun Worker in ≤ 1 MiB transferred slices; the writer masks, serializes, seals and (SQLite) stages + renames the file or (Postgres) writes the `bytea` row; the main thread writes the pointer row and `request_logs.body_state` in one transaction. Admin reads decode in the writer and return a 1 MiB-per-part preview. The export worker reads artifacts read-only, extracts the client fields with a streaming scanner under a 192 MiB budget (one body at a time), and attaches them inline or as segmented body documents.

**Tech Stack:** Bun 1.4.4 (Worker, bun:sqlite, Bun SQL), TypeScript, Elysia, zod, React/TanStack (dashboard).

**Spec:** `docs/superpowers/specs/2026-10-24-log-export-design.md` — section `## Bodies` (all subsections), plus the body bullets of *Asynchrony*, *Worker protocol* (`gatesChanged`), *Testing* (Bodies), *Docs*, *Surfaces → Console* (bodies toggle). Binding.

Branch `feat/log-export-bodies`, stacked on `feat/log-export` (PR #277). Code map of today's body path: `docs/superpowers/plans/2026-10-26-log-export-bodies-map.md` (file:line survey; read the sections a task names).

## Global Constraints

- Read `CLAUDE.md` first. Store rule: every repo method in `types.ts`, both `sqlite/` and `postgres/`, the sqlite forwarder in `sqlite/store.ts`, a contract test in `packages/store/test/contract/`. LogFields is a closed allowlist (never log body content, secrets, receiver text). Dashboard calls `/api/*` only and mirrors wire shapes in `apps/dashboard/src/api/types.ts`. The main-thread import boundary (`apps/gateway/test/export/boundary.test.ts`) extends to the body writer: the main thread reaches it only via its `spawn.ts` + `protocol.ts`.
- TDD: failing test first, run red, then green. Postgres contract tests run with `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni` (container `omni-sdd-pg`; start per the PR1 plan if absent).
- Before DONE: `bun run typecheck`, `bun run lint` (0 diagnostics incl. infos), `bun run check:claims`, `bun run check:dead`, `bun test` for changed packages (whole repo in the last task), `bun run test:dashboard` when dashboard changes.
- Exact values (spec): `MAX_ARTIFACT_BYTES` = 64 MiB = 67,108,864; `MAX_CAPTURED_BODY_BYTES` = the same per side; `OMNI_BODY_CAPTURE_BUDGET_BYTES` default 512 MiB; slices ≤ 1 MiB transferred, `setTimeout(0)` between slices; writer queue ≤ 1,000 requests; staging dir `request_bodies/.staging/<requestId>.<nonce>`; staging files older than 1 h swept; `body_state` `pending|ready|omitted|failed` (null = not attempted); `sweepPending` fails rows `pending` 1 h after completion; preview = first 1 MiB of each part's serialized JSON + full size + `previewTruncated`; export waits ≤ 60 s after `completed_at` for a pending body; `OMNI_EXPORT_BODY_BUDGET_BYTES` default 192 MiB; body states `included|incomplete|omitted|unavailable`; ES body index default `omni-bodies-{yyyy.MM.dd}`, `_id` = `<requestId>:<part>:<n>`; webhook body headers `x-omni-request-id`, `x-omni-body-part`, `x-omni-body-segment`, `x-omni-body-segments`; 413 halves the effective limit once; writer shutdown budget 5 s; omission reasons `capture budget exhausted`, `backlog`, `nesting too deep`, `export budget`, and the >64 MiB reason; metrics `omni_bodies_dropped_total{reason}` (`budget|backlog|writer_crash|restore`), `omni_export_bodies_late_total`.
- Migrations: SQLite `023_body_state.sql`, Postgres `011_body_state.sql`.
- PR1 facts to rely on: export worker `apps/gateway/src/export/{worker,loop,deliver,protocol,spawn}.ts`; supervisor `apps/gateway/src/exportHost/supervisor.ts` (restart/pause/drain mechanics; restore hook `ExportPause` in `routes/database.ts`); `ExportDestination.revision`; `setDestinationBodies` refusal in `packages/control/src/export.ts`; `WorkerInit.exportBodiesAllowed` + `gates` already passed; `gatesChanged` accepted and ignored in `loop.ts`.

## Review Focus

1. **A client stream under capture pressure** — with the budget exhausted or the writer stalled/crashed, the client still receives a byte-identical, unslowed response and the row completes; only the body is omitted/failed. (Task 3, Task 5 tests.)
2. **Restore mid-capture** — a writer ack from before a swap never writes a pointer row into the restored DB; staged files from the old DB never become pointers. (Task 6 test.)
3. **Deep / huge / hostile JSON** — 100,000-deep nesting, a 60 MiB single string, invalid UTF-8 halves, and escaping-heavy text (`"\u0000"` runs) are masked, stored or omitted with a reason, and segment within `maxRequestBytes`. (Tasks 1, 8 tests.)
4. **Gate turned off after capture** — an artifact captured while all gates held is never exported once any gate is off, including mid-pass. (Task 8 test.)
5. **Legacy artifacts** — artifacts written under the 512 KiB cap (both envelopes, incl. legacy omission markers) still read, preview, and export as `omitted`/`included` correctly. (Tasks 1, 7, 8 tests.)

---

### Task 1: artifact limits, stack-safe masking, no structural bounding (store, pure)

Spec: *What changes in body capture* (all bullets except the capture-cap bullet), legacy readability.

**Files:** Modify `packages/store/src/bodies/artifact.ts`, `packages/store/src/bodies/mask.ts`; delete `packages/store/src/bodies/bound.ts` and its exports from `packages/store/src/index.ts` if nothing else uses them (check dashboard/control); Modify `packages/store/src/postgres/bodies.ts` (length filter follows); Test `packages/store/test/bodies/*.test.ts`.

**Interfaces — Produces:**
- `MAX_ARTIFACT_BYTES = 64 * 1024 * 1024`; `MAX_ENVELOPE_BYTES`, `MAX_BINARY_ENVELOPE_BYTES`, gunzip `maxOutputLength`, `parseBinary` bounds, `plaintextOf` and the Postgres filter derive from it (they already do — keep it so).
- `maskSecrets(value: unknown): unknown` — iterative, explicit stack, same output as today for every existing test.
- `prepareArtifact(input: BodyArtifact): { artifact: BodyArtifact; json: string }` — masks, never bounds; on `RangeError` from `JSON.stringify` returns an omission artifact with reason `"nesting too deep"`; over 64 MiB → omission with reason `` `artifact exceeded ${MAX_ARTIFACT_BYTES} bytes` ``; the omitted result is re-checked against the cap.
- `export type BodyOmission` moves to `packages/store/src/types.ts` (dashboard imports it from `@omni/store/types` instead of its hand mirror).

- [ ] Tests: 100,000-deep nested array/object masks without throwing; a stringify `RangeError` yields `client.request = { omitted: true, reason: "nesting too deep", … }`; a 20 MB client request + one attempt round-trips byte-identical after masking (SQLite and Postgres contract, incl. real Bun SQL `bytea`); an artifact of 64 MiB + 1 byte after masking is an omission; `boundValue` no longer applied (a 100 KiB string and a 500-item array survive whole); 512 KiB-era fixtures (binary and `enc:v1:` envelopes, and an old omission marker) still decode; an envelope one byte past `MAX_ENVELOPE_BYTES` reads `corrupt`; reader ceilings equal the formulas over `MAX_ARTIFACT_BYTES`.
- [ ] Implement; keep `sealArtifact` (raw codec) as the writer path.
- [ ] Verify (store + control suites, Postgres on) and commit `feat(store): 64 MiB artifacts, iterative masking, no structural bounding`.

### Task 2: `body_state` column and the pointer/state transaction (store)

Spec: *Capture state on the row*, *SQLite staging and the orphan sweep* (store side).

**Files:** Create `packages/store/src/sqlite/migrations/023_body_state.sql`, `packages/store/src/postgres/migrations/011_body_state.sql`; Modify `packages/store/src/types.ts`, `sqlite/{usage,bodies,store}.ts`, `postgres/{usage,bodies}.ts`, `packages/store/src/bodies/artifact.ts` (`listArtifacts`, staging helpers); Test `packages/store/test/contract/bodyState.test.ts`, `packages/store/test/contract/bodies.test.ts`.

**Interfaces — Produces:**
- `RequestLog.bodyState: "pending" | "ready" | "omitted" | "failed" | null` (store-owned on reads; `usage.begin` and `usage.append` inputs accept `bodyState: "pending" | null` — `append` sets it only when the row has none yet, so a row that never began (failed before routing) can still be pending, and a terminal state is never overwritten).
- `BodyRepo` additions:
  - `publish(row: { requestId: string; at: number; relPath: string; sizeBytes: number; sha256: string; truncated: boolean; omitted: boolean }): Promise<boolean>` — SQLite: in ONE transaction upsert `request_bodies` (`detail_state = 'ready'`) and `UPDATE request_logs SET body_state = ('omitted'|'ready') WHERE id = ? AND body_state = 'pending'`; returns false (writes nothing) if the log row is not `pending`. Postgres: the writer already wrote the row; `publish` only updates `body_state` (same guard).
  - `fail(requestId: string): Promise<void>` — `body_state = 'failed'` where `pending`.
  - `writeRow(row & { bytes: Uint8Array }): Promise<void>` — Postgres-only use from the writer's pool (both backends implement; SQLite throws "not used on SQLite").
- `sweepPending` also sets `body_state = 'failed'` for rows still `pending` 1 h after `completed_at` (both backends).
- `sweepOrphans` never lists `request_bodies/.staging/`, skips relPaths in an injected `isPending(relPath): boolean` (new optional param on the SQLite repo factory, wired by the gateway in Task 5), and removes staging files older than 1 h.
- Remove the put path's on-thread sealing only in Task 5; keep `put` working until then.

- [ ] Contract tests (both backends): begin with `bodyState: "pending"` → `publish` → `ready`/`omitted` in the same transaction (SQLite: assert both rows change or neither — inject a failing upsert); `publish` on a non-pending row writes nothing and returns false; `fail`; sweepPending fails 1 h-old pending rows only; orphan sweep spares `.staging/`, spares `isPending` paths, removes staging files > 1 h; `body_state` null for rows begun without capture. Migration test on a pre-023 SQLite DB.
- [ ] Implement; verify; commit `feat(store): request_logs.body_state and one-transaction body publish`.

### Task 3: capture budget and raw-text capture (gateway, main thread)

Spec: *Memory and the request path* §1 and the "raw text, not parsed trees" bullet of §2; *What changes in body capture* capture-cap bullet.

**Files:** Create `apps/gateway/src/bodies/budget.ts`; Modify `apps/gateway/src/bodyCapture.ts`, `apps/gateway/src/routes/proxy.ts` (read body as text once; `JSON.parse` for IR; keep text for capture), `packages/control/src/config.ts` (`OMNI_BODY_CAPTURE_BUDGET_BYTES`, default 536,870,912; positive integer), telemetry registry (`omni_bodies_dropped_total{reason}`); Test `apps/gateway/test/bodies/budget.test.ts`, `apps/gateway/test/bodyCapture.test.ts`, route tests.

**Interfaces — Produces:**
- `createCaptureBudget(limitBytes: number): CaptureBudget` with `reserve(bytes: number): boolean`, `release(bytes: number): void`, `held(): number`.
- `BodyCollector` keeps raw strings only: `client.request` becomes the raw request text; `client.response` is the serialized JSON the route sends (non-streaming) or the frame list (streaming); attempt requests/responses are raw text; `abandoned: null | "budget"` — once abandoned, buffers are freed, further bytes drained and discarded.
- `CapturedParts` (handed to Task 5): `{ requestId, at, client: { request: string|null; response: string|string[]|null; truncated }, attempts: Array<{ attempt; provider; request: string|null; response: string|null; streamChunks: string[]|null; truncated }>, error, abandoned: null|"budget", reservedBytes: number }`.
- Caps count **bytes** (UTF-8), not code units; 64 MiB per side.

- **Transitional (until Task 5):** the existing `store.bodies.put` path keeps working through `toArtifact(parts: CapturedParts): BodyArtifact` in `apps/gateway/src/bodies/toArtifact.ts` (parses on the main thread, as today). Task 5 deletes it. Rows begun or appended with capture on carry `bodyState: "pending"` (`usage.begin` and `usage.append` inputs accept it, so a request that fails before routing is still pending); the transitional path calls `store.bodies.publish`/`fail` after `put` so `body_state` is correct from this task on.

- [ ] Tests: the route reads the client body once as text and parses the IR from it (no second read; no `request.json()`); concurrent long streams never hold more than the budget (fake budget 1 MiB, three 2 MiB streams); the request that would exceed it is abandoned (`reason=budget`, metric incremented, artifact written as an omission `capture budget exhausted`, `truncated: true`) while its client stream is byte-identical and not delayed (assert chunk timing against an uncaptured run with a fake clock/scheduler); bytes past 64 MiB per side are drained, discarded, marked `truncated`; reservations are released after the write (transitional: after `put`).
- [ ] Implement; verify; commit `feat(gateway): capture budget and raw-text body capture`.

### Task 4: generic worker host (refactor, no behaviour change)

**Files:** Create `apps/gateway/src/workerHost/instance.ts` (+ `index.ts` if useful); Modify `apps/gateway/src/exportHost/supervisor.ts` to use it; Test `apps/gateway/test/workerHost/instance.test.ts`.

**Interfaces — Produces:** `createWorkerHost<In, Out>(deps: { spawn: () => HostedWorker<In, Out>; timers; now; logger; name: string; onMessage(m: Out): void; onExit?(): void }): WorkerHost<In>` with `start()`, `post(m: In)`, `pause(ack: (m: Out) => boolean): Promise<void>`, `resume(swapped: boolean): Promise<void>`, `halt(): Promise<void>`, `stop(): void`, `state()`, `restarts()` — carrying PR1's exact mechanics: never spawn beside a retiring instance (`close` = exited), restart backoff `min(60 s, 1 s·2^(n-1))`, consecutive reset after a 10-minute life, down after 5 deaths in 10 minutes, pause ack ≤ 5 s then terminate and wait ≤ 5 s for `close` else refuse (`NOT_QUIESCED`), `unsafe` halt survives failed recoveries, `stop()` final, `serial()` lifecycle chain. Destination-specific logic (readDestinations, idle/down polling, request/reply routing) stays in the export supervisor.

- [ ] Every existing `apps/gateway/test/exportHost/*.test.ts` passes unchanged; new host unit tests cover each mechanic above with a fake worker. Commit `refactor(gateway): extract the worker host from the export supervisor`.

### Task 5: the body writer worker (gateway)

Spec: *Memory and the request path* §2 (all bullets), *SQLite staging and the orphan sweep*, *Capture state on the row* (writer side), *Restore, import and shutdown* (shutdown).

**Files:** Create `apps/gateway/src/bodies/{writer.ts,protocol.ts,spawn.ts,host.ts,seal.ts}` (host built on Task 4's `createWorkerHost`); delete `apps/gateway/src/bodies/toArtifact.ts`; Modify `apps/gateway/src/logging.ts` (`finishLog` no longer awaits bodies), `routes/proxy.ts` (begin with `bodyState: "pending"`; hand `CapturedParts` to the host), `index.ts` (start/stop the writer; `stopLoops`), `scripts/build-npm.ts`, `scripts/build-binary.ts` (+ tests) for the writer entry; boundary test allow-list; Test `apps/gateway/test/bodies/{writer,host}.test.ts`.

**Interfaces — Produces:**
- `BodyWriterHost` (main thread): `enqueue(parts: CapturedParts): void` (never awaits; queue ≤ 1,000 else abandons with `backlog`), `read(requestId: string): Promise<BodyPreview>` (Task 7), `readRaw(requestId: string, part: BodyPart): Promise<ReadableStream<Uint8Array> | null>` (Task 7), `isPending(relPath: string): boolean`, `pause(): Promise<void>`, `resume(swapped: boolean): Promise<void>`, `halt(): Promise<void>`, `stop(): void`, `generation(): number`.
- Protocol main → writer: `part { requestId, generation, part, seq, last, bytes: ArrayBuffer (transferred, ≤ 1 MiB) }`, `meta { requestId, generation, at, error, truncated flags, abandoned }`, `publish-ok { requestId, relPath }`, `read { ref, requestId }`, `readRaw { ref, requestId, part }`, `pause`, `resume`, `stop`. Writer → main: `slice-ack { requestId, bytes }`, `publishing { requestId, relPath, generation }`, `written { requestId, generation, at, relPath, sizeBytes, sha256, truncated, omitted }` (Postgres: after its own `writeRow`), `write-failed { requestId, generation }`, read replies, `paused`.
- Writer: reassemble by `(requestId, part, seq)`, `JSON.parse` client/attempt texts (raw string kept if not JSON, as `asBody` does today), `prepareArtifact`, `sealArtifact`; SQLite: write `.staging/<id>.<nonce>`, `fsync`, post `publishing`, await `publish-ok`, rename to `relPathFor(id, at)`, post `written`. Postgres: own pool of 2, `writeRow`, post `written`. One write at a time.
- Main thread on `written`: ignore if `generation` ≠ current; else `store.bodies.publish(...)`, remove from the pending-publication set, release the request's budget reservation. On `write-failed` / writer death: `store.bodies.fail(id)` for each affected request, metric `writer_crash`, release reservations; restart with the shared backoff.

- [ ] Tests: `finishLog` returns and the client response is sent with the writer stalled (row completion and latency unchanged); a 64 MiB part crosses in ≤ 1 MiB transferred slices with a yield between them (instrument `postMessage` sizes and `setTimeout(0)` calls); SQLite: no file outside `.staging/` before `publish-ok`; rename only after it; the main connection writes every pointer row and `body_state` in one transaction and `PRAGMA data_version` seen by the main connection does not move from writer activity; orphan sweep never deletes a staged or pending-publication file; a crashed writer's pending paths are cleared and its requests become `failed` (counted); queue past 1,000 → `backlog`; `body_state` pending → ready / omitted / failed; build tests fail when the writer entry is missing; supervisor tests unchanged after the extraction.
- [ ] Implement; verify; commit (several commits fine: extraction first, then writer).

### Task 6: restore/import and shutdown for the body writer

Spec: *Restore, import and shutdown*.

**Files:** Modify `apps/gateway/src/routes/database.ts` (compose the export and writer pause hooks: both paused before the swap, both resumed/halted after; a refusal from either refuses the restore), `apps/gateway/src/app.ts`, `index.ts`; Test `apps/gateway/test/routes/database*.test.ts`, `apps/gateway/test/bodies/host.test.ts`.

**Interfaces — Consumes:** `BodyWriterHost.pause/resume/halt/generation`, PR1 `ExportPause`. **Produces:** `type WorkerPause = { pause(): Promise<void>; resume(swapped: boolean): Promise<void>; halt(): Promise<void> }` composed from a list; `DatabaseRouteDeps.workers: WorkerPause[]` replacing `exportWorker?`.

- [ ] Tests: on restore the writer pauses, drops its queue (each counted `reason="restore"`, requests `failed`), acks; a `written` ack from before the swap (old generation) is ignored and writes no pointer into the restored DB; staging is cleaned on resume; a writer that won't ack is terminated (5 s) and the restore refused if it won't exit; `SwapFailedError` halts both workers; shutdown gives the writer 5 s and counts the unwritten.
- [ ] Implement; verify; commit.

### Task 7: admin body reads in the writer (preview + raw)

Spec: *Memory and the request path* §3.

**Files:** Modify `packages/control/src/bodies.ts` (`readRequestBody` gains an injected decoder), `apps/gateway/src/routes/admin.ts` (`GET /api/requests/:id/body` → preview via the host; new `GET /api/requests/:id/body/raw?part=…`, admin-only, streamed download), `apps/cli/src/commands/bodies.ts` (CLI decodes in its own process but returns the same preview shape; `--full` prints whole parts), dashboard `apps/dashboard/src/api/types.ts`, `features/logs/BodyArtifact.tsx` (render preview, "Download full part" link, drop the "512 KB cap" wording); Test route, control, CLI, dashboard tests.

**Interfaces — Produces:**
- `type BodyPart = "client.request" | "client.response" | \`attempt.${number}.request\` | \`attempt.${number}.response\` | "error"`.
- `type BodyPreview = { requestId; detailState; truncated; sizeBytes; at: number|null; bodyState: RequestLog["bodyState"]; parts: Array<{ part: BodyPart; sizeBytes: number; preview: string; previewTruncated: boolean; omitted: BodyOmission|null }> }` (preview = first 1 MiB of the part's serialized JSON, cut on a code-point boundary).
- `RequestBodyResponse` wire type = `BodyPreview`.

- [ ] Tests: preview per part ≤ 1 MiB with full size and `previewTruncated`; the decode happens in the writer (main thread performs no decrypt/`JSON.parse` > 1 MiB — instrument); raw route streams the exact full part JSON and is 403 for a viewer and 401 unauthenticated; CLI text/`--json`/`--full`; dashboard renders the preview, omission notes, and the download link; legacy artifacts preview correctly.
- [ ] Implement; verify; commit.

### Task 8: body export in the export worker

Spec: *Exporting bodies* (all), *Export-worker memory* (all), *Inline or separate*, *Segmenting by encoded size*, *Asynchrony* artifact-reader bullet, *Worker protocol* `gatesChanged`.

**Files:** Create `apps/gateway/src/export/body/{scanner.ts,budget.ts,segment.ts,attach.ts}`; Modify `packages/store/src/exportReader.ts` (read-only artifact read: `bodyEnvelope(requestId): Promise<{ bytes: Uint8Array; sha256: string|null; truncated: boolean } | null>` with no `recordState`; plaintext length probe), `apps/gateway/src/export/{record.ts,loop.ts,deliver.ts,protocol.ts}`, encoders (`bodyPart` for ES index `bodyIndex`, webhook per-segment POST, OTLP logs per-segment LogRecord), `packages/control/src/export.ts` (`setDestinationBodies(true)` allowed when the destination is not OTLP traces; ES config `bodyIndex` default `omni-bodies-{yyyy.MM.dd}`), `apps/gateway/src/index.ts` + settings write path (post `gatesChanged { bodyLoggingAllowed, bodyLoggingEnabled }` on settings change), `OMNI_EXPORT_BODY_BUDGET_BYTES` config (default 201,326,592), metric `omni_export_bodies_late_total`; Test `apps/gateway/test/export/body/*.test.ts`, loop/deliver tests, control tests.

**Interfaces — Produces:**
- `RequestRecord.body?: { state: "included"|"incomplete"|"omitted"|"unavailable"; reason?: string; client?: { request: unknown; response: unknown }; parts?: { request: number; response: number } }` (record stays `omni.request_log/v1` — additive).
- `extractClient(text: string, signal: AbortSignal): { request: string|null; response: string|null }` — streaming scanner returning the two client fields' raw JSON text without building the tree.
- `segments(text: string, limitBytes: number, envelope: (seg: string, n: number, of: number) => number): string[]` — pure, deterministic; every encoded request ≤ limit for worst-case escaping.
- Body gates evaluated per record at send time: `bodyLoggingAllowed && settings.bodyLoggingEnabled && !key.bodyLoggingOptOut && init.exportBodiesAllowed && destination.includeBodies`; any off → no `body` field.

- [ ] Tests (from the spec's Testing list): pending row held ≤ 60 s after `completed_at`, then sent `unavailable` and counted late; each of the four gates off → no `body` (incl. an artifact captured before the gate went off, and a gate flipped mid-pass); opt-out key never yields a body; `included`/`incomplete`/`omitted` (with reason, incl. legacy 512 KiB omissions)/`unavailable` from matching artifacts; inline when it fits, otherwise segmented body docs with stable ids and every encoded request ≤ `maxRequestBytes` for worst-case escaping input; a 413 halves the limit once and retries; OTLP traces cannot enable bodies; three destinations exporting large bodies concurrently → one body in the worker at a time and peak reserved bytes ≤ budget; reservation from authenticated plaintext length (a highly compressible gzip artifact reserved at expanded size); reservation over budget → `omitted` / `export budget`; scanner extracts the client fields without `JSON.parse` of the artifact (instrument); metadata rows before a body row go in their own batch; cancellation between segments releases the semaphore and reservation; the worker's reads never write `detail_state`.
- [ ] Implement; verify; commit (several commits fine).

### Task 9: console, CLI, docs

Spec: *Surfaces → Console* (bodies toggle), *Docs*, *Sizing, stated in README*.

**Files:** Dashboard export editor/list (bodies toggle enabled only when all gates hold — read gates from `GET /api/settings` / export status; explain which gate is off; refuse for OTLP traces), `apps/cli/src/commands/export.ts` (`set <id> --bodies on|off`), README (`OMNI_EXPORT_BODIES_ALLOWED`, `OMNI_BODY_CAPTURE_BUDGET_BYTES`, `OMNI_EXPORT_BODY_BUDGET_BYTES`, 64 MiB limit, sizing paragraph, body-index ES mapping with `text` `index: false`, raising Bun's request-body limit above its 128 MB default if larger requests are expected), `docs/operations.md` (body_state, budget/backlog drops, late bodies), `ARCHITECTURE.md` (body writer, staging/publish, generation), CLAUDE.md invariants (body writer never writes the main SQLite file; main thread never parses/serializes a captured body).

- [x] Tests: dashboard toggle states per gate; CLI `--bodies`; docs claims checked against code (`check:claims`).
- [x] Whole-repo verification (all CI gates) and commit: Task9 round1 report records Redis+Postgres-enabled root suite with zero skips, dashboard, typecheck/lint/claims/dead and frozen install; local Postgres 18 per task setup versus CI 17 noted.
