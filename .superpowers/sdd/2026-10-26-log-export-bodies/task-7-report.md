# Task 7 — admin body reads

Status: DONE_WITH_CONCERNS (bounded aggregate preview/lifetime policy below).

## Implemented

- Gateway preview reads inject the existing body host into control; no gateway fallback to `store.bodies.get`, decrypt, or full artifact parse. Production app wires the same capture host into admin routes.
- Worker-only reader opens SQLite read-only with `query_only`; its body repo suppresses observation write-back. No new SQLite writes or main-connection barriers were introduced. PostgreSQL reads use the worker's existing lazy pool (max 2), closed on pause and recreated on resume.
- One read/decode/raw-retention slot on both sides, no waiting read queue. This bounds the legacy 2N envelope and decode intermediates too; an actual 60 MiB plaintext legacy envelope is exercised.
- Shared preview builder serializes each client request/response, numbered attempt request/response, and error; first 1 MiB UTF-8 prefix ends on a code-point boundary, reports full serialized byte size, and recognizes historical omission reasons and nullable sizes. `bodyState` is included. The dashboard mirrors this wire shape and imports only the existing store types.
- Raw route validates part names after admin authentication, streams exact compact serialized JSON, returns 404 for absent parts, sets attachment/JSON/no-store headers. Worker sends only one transferred slice per pull (at most 1 MiB; character slice is 256 Ki code units), with no main prefetch. Cancellation releases retained text. A slow raw client does not occupy the capture write chain.
- Host rejects/disposes reads on pause, halt, stop, drain and retirement/crash; refs never repeat within the host. Reader epochs fence in-flight completion on pause/cancel. Actual-close ownership, generation/publication fencing, stable-empty publication DB barrier and five-second capture drain/force logic are unchanged.
- CLI decrypts locally (never HTTP), keeps its privacy-preserving text summary, emits shared preview in `--json`, prints whole payloads with `--full`; `--json --full` contains whole serialized parts.
- Dashboard renders preview text without re-parsing it, full byte sizes, omission notes, preview truncation, stage/attempt labels and full-part download links. README and ARCHITECTURE explain the changed surfaces.
- No Task 8 export payload/delivery or Task 9 editor changes.

## Files

- `packages/control/src/{bodies,index}.ts`; `packages/control/test/{bodies,bodyPreview}.test.ts`.
- `packages/store/src/sqlite/bodies.ts` (optional read-only observation mode; existing public repo interface unchanged).
- `apps/gateway/src/bodies/{host,protocol,writer,read}.ts`, `src/routes/admin.ts`, `src/app.ts`.
- `apps/gateway/test/bodies/{host,read,readPostgres}.test.ts`, `test/routes/{admin,authMatrix}.test.ts`, `test/export/boundary.test.ts`.
- `apps/cli/src/commands/bodies.ts`, `apps/cli/test/bodies.test.ts`.
- `apps/dashboard/src/api/types.ts`, `src/features/logs/BodyArtifact.tsx`, `test/helpers/fixtures.ts`, `test/features/logs.test.tsx`.
- `README.md`, `ARCHITECTURE.md`, this report.

## RED / GREEN evidence

1. RED `bun test packages/control/test/bodyPreview.test.ts`: missing `previewBody` export; feature did not exist. GREEN after implementation: initially 2 pass / 15 assertions; final 3 pass / 17 assertions.
2. Real-worker integration RED `bun test apps/gateway/test/bodies/read.test.ts`: `GatewayError: body reader unavailable` after sequential preview/raw and resume. Worker was retaining its admission state after posting a reply, and resume reopened its reader only asynchronously. Fixed disposal-before-reply and immediate resume admission; GREEN 1 pass / 14 assertions, subsequently extended for capture progress and legacy reads.
3. Dashboard RED: `LogsBoard > the captured client and provider requests are labelled either side of RTK`: provider heading lost its exact accessible label. Preserved heading while adding attempt chip. GREEN full dashboard 817 pass.
4. Added crash regression while fixing cleanup: pending read death must not throw from cancellation posting and skip capture release. GREEN `bun test apps/gateway/test/bodies/host.test.ts -t reader`: 2 pass / 8 assertions (also no-prefetch/30-second expiry).
5. Legacy near-cap GREEN `bun test apps/gateway/test/bodies/read.test.ts -t near-cap`: 1 pass / 4 assertions, 6.79 s. This allocates a real authenticated ~120 MiB hex envelope for 60 MiB plaintext, then decrypts/parses in the actual worker.
6. Raw route GREEN `bun test apps/gateway/test/routes/admin.test.ts -t 'raw body'`: 1 pass / 9 assertions, including HTTP response cancellation then successful reread. Auth matrix includes raw route for every principal, pinning viewer 403 and unauthenticated 401.
7. Backpressure RED `bun test apps/gateway/test/bodies/host.test.ts -t 'reader lifetime'`: ten concurrent downstream reads generated ten pull credits (expected one). Fixed host underlying pull to remain pending until the transferred chunk arrives. GREEN same command: 1 pass / 5 assertions; real worker suite 3 pass / 23 assertions. This pins bounded buffering even with a consumer issuing concurrent `read()` calls.

Not every added assertion had its own isolated RED run: initial missing shared API and actual integration failures preceded implementation/fixes, while later edge coverage was added during self-review. No claim of an independently observed red for those later cases.

## Verification

Environment: existing `omni-sdd-pg` container left running; `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni` for affected package suites.

- `bun run typecheck`: core 723 files + dashboard 210 files, no errors.
- `bun run lint`: 950 files, zero diagnostics (warnings/non-null assertions found on first run were removed).
- `bun run check:claims`: no stale claims (23 removed symbols checked).
- `bun run check:dead`: latest no dead exports (208 changed files after staging the four new sources/tests); existing informational unchecked common words `state`/`note` remain checker output, not lint diagnostics.
- `bun run test:dashboard`: latest 817 pass, 0 fail, 2478 assertions / 52 files, 51.12 s. Existing deliberate plugin error-boundary and route-error tests emit console diagnostics; no new unexpected console output.
- Earlier whole affected suite: 3915 pass, 1 skip, 0 fail / 227 files, 46216 assertions, 178.06 s. One earlier 120-second runner timeout was rerun with a 600-second allowance; not a test failure.
- Final `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway packages/control apps/cli packages/store`: **3917 pass, 1 skip, 0 fail**, 46226 assertions across 227 files, 187.64 s. Includes near-cap legacy decode, raw cancellation, concurrent-read backpressure, expiry and wire type mirror. The compact runner output does not name the skipped test; the dedicated real PostgreSQL reader test also passed separately.
- `git diff --check`: clean.

## Interfaces produced

From `@omni/control` (defined `packages/control/src/bodies.ts`):

```ts
type BodyPart = "client.request" | "client.response"
  | `attempt.${number}.request` | `attempt.${number}.response` | "error";
type BodyPreview = {
  requestId: string; detailState: BodyDetailState; truncated: boolean;
  sizeBytes: number; at: number | null; bodyState: RequestLog["bodyState"];
  parts: Array<{ part: BodyPart; sizeBytes: number; preview: string;
    previewTruncated: boolean; omitted: BodyOmission | null }>;
};
type RequestBodyRead = BodyPreview;
type BodyDecoder = (requestId: string) => Promise<BodyPreview>;
readRequestBody(store: Store, requestId: string, decode?: BodyDecoder): Promise<BodyPreview>;
previewBody(requestId: string, bodyState: RequestLog["bodyState"], read: BodyRead | null): BodyPreview;
bodyParts(artifact: BodyArtifact): Generator<[BodyPart, unknown]>;
isBodyPart(part: string): part is BodyPart;
```

`BodyDecoder` is exported from the defining module (not the package root); root callers can supply the callback structurally.

`BodyWriterHost` adds `read(requestId: string): Promise<BodyPreview>` and
`readRaw(requestId: string, part: BodyPart): Promise<ReadableStream<Uint8Array> | null>`.
Existing lifecycle and capture members are unchanged. `protocol.ts` re-exports `BodyPart`;
capture transport's internal `part` remains arbitrary string (frame/chunk assembly keys).
Protocol adds `read`, `readRaw`, `read-pull`, `read-cancel` with monotonic `ref`;
replies `read-result`, `raw-ready`, `raw-chunk` (transferred ArrayBuffer + last), `read-error`.
`RequestBodyResponse` dashboard wire mirror = `BodyPreview`, pinned bidirectionally by
gateway type assignments. No full artifact crosses the admin preview wire.

## Self-review / concerns

- **Aggregate preview ceiling:** 8 MiB including JSON escaping and conservative per-part overhead. Individual previews are never shortened below the specified first 1 MiB to fit a total. An artifact with many large attempts can therefore get 503 for preview while its raw parts remain downloadable through the raw endpoint. This is a conscious bounded-reply tradeoff; the exact brief does not specify an aggregate policy.
- **Raw lifetime:** host cancels the entire read/download after 30 seconds, even if progressing; worker also has a 30-second idle raw-retention timer. Slow large downloads can terminate rather than holding memory indefinitely. No unbounded per-client capture dependency.
- **Memory:** single read admission is the memory bound, not a new env-configured byte budget. Existing capped whole-artifact decoding still has legacy hex/string/array amplification near 64 MiB; the 60 MiB real worker test passes but no RSS hard-limit assertion is claimed. No overlapping admin decodes or retained raw parts; a capture write can still overlap the read, as designed for capture progress.
- SQLite worker observes missing/corrupt without persisting detail state; CLI and existing main repo callers retain historical write-back. No main recordState operation was needed, avoiding additional swap-barrier writes.
- `host.ts` grew beyond 500 lines because it owns both capture and read lifecycle. No unrelated lifecycle refactor attempted; worker reader isolated in `read.ts`.
- CLI text default deliberately still withholds conversation contents; `--json` is bounded preview and `--full` opts into whole payloads. Stream-frame diagnostic output remains CLI-only, since `BodyPart` does not include stream-frame parts.
- No subagents, no push, no unrelated worktree touched.

## Commits

- `030e63d3 feat(bodies): add worker previews and raw reads` — coherent implementation, surfaces and coverage.
- Follow-up report-only commit records final evidence.
