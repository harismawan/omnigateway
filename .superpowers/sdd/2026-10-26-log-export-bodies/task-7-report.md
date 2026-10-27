# Task 7 — admin body reads

Status: fix round 1 — original implementation history below; superseded policies and corrected evidence in the appended fix report.

## Implemented

- Gateway preview reads inject the existing body host into control; no gateway fallback to `store.bodies.get`, decrypt, or full artifact parse. Production app wires the same capture host into admin routes.
- Worker-only reader opens SQLite read-only with `query_only`; its body repo suppresses observation write-back. No new SQLite writes or main-connection barriers were introduced. PostgreSQL reads use the worker's existing lazy pool (max 2), closed on pause and recreated on resume.
- One read/decode/raw-retention slot on both sides, no waiting read queue. This bounds concurrency, NOT practical RSS safety; the original 60 MiB success did not measure peak memory. See I4 fix measurements below.
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
6. Original raw route GREEN `bun test apps/gateway/test/routes/admin.test.ts -t 'raw body'`: 1 pass / 9 assertions, including HTTP response cancellation then successful reread. **Correction:** the original matrix expected 401 for every rejected principal, including viewers; it did NOT pin viewer 403. Fix round 1 adds the endpoint-specific 403 exception and explicit assertions.
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

- **Original aggregate ceiling and fixed raw lifetime were rejected by the controller and removed in fix round 1.** They were not approved tradeoffs.
- **Original memory claim corrected:** a single slot only bounds admission concurrency; it did not justify legacy allocation amplification or establish safe RSS. Fix round 1 removes the avoidable number arrays and reports measured, not guaranteed, peak memory below.
- SQLite worker observes missing/corrupt without persisting detail state; CLI and existing main repo callers retain historical write-back. No main recordState operation was needed, avoiding additional swap-barrier writes.
- `host.ts` grew beyond 500 lines because it owns both capture and read lifecycle. No unrelated lifecycle refactor attempted; worker reader isolated in `read.ts`.
- CLI text default deliberately still withholds conversation contents; `--json` is bounded preview and `--full` opts into whole payloads. Stream-frame diagnostic output remains CLI-only, since `BodyPart` does not include stream-frame parts.
- No subagents, no push, no unrelated worktree touched.

## Commits

- `030e63d3 feat(bodies): add worker previews and raw reads` — coherent implementation, surfaces and coverage.
- Follow-up report-only commit records final evidence.

## Fix round 1 — review I1–I5

All five findings addressed; the previous aggregate refusal and absolute raw deadline were not accepted and are removed. This appendix supersedes the historical interfaces/policies above.

### Implementation / APIs

- **I1/I3:** `previewBody` has no aggregate cap. `previewBody(requestId, bodyState, read, full = false): BodyPreview` still produces every specified prefix; optional `full` directly serializes full parts, preserving omission metadata without constructing prefixes first. CLI text passes metadata only to the helper; `--json --full` uses direct full serialization. Text and full modes cannot fail due to preview preprocessing.
- `BodyWriterHost.read(requestId: string): Promise<ReadableStream<Uint8Array>>` now returns worker-encoded preview-envelope bytes. `readRaw` is unchanged. `preview-ready {ref}` replaces `read-result {ref, preview}`; both responses share existing one-credit `read-pull` / transferred `raw-chunk` / `read-cancel` flow. No object tree or aggregate string is cloned to the gateway. Admin preview returns `new Response(stream)` with JSON/no-store headers; no main `JSON.stringify`, `JSON.parse`, or `Response.json` of the envelope. Worker holds one encoded response and sends ≤1 MiB chunks on demand. Wire JSON `BodyPreview` and dashboard mirror are unchanged.
- **I2:** admission starts a bounded 30-second decode timer. `preview-ready`/`raw-ready` reset it to stream inactivity; each pull or received chunk renews inactivity. There is no total raw/preview transfer lifetime. Existing worker idle retention timer, one admission slot, pending-pull credit, cancellation/crash/pause/restore disposal remain. Fake clock proves an 80-second progressing download succeeds, no-prefetch/concurrent-credit bounds remain, a stalled reader expires, and decode admission remains bounded.
- **I4:** shared `decrypt` fills one preallocated `Uint8Array` using `unhexInto`; it never spreads decoded ciphertext into number arrays. IV parsing, input validation and authenticated-decrypt behavior unchanged. Regression blocks large typed-array iteration while actually decrypting legacy ciphertext; existing credential encryption tests cover malformed/tag/wrong-key/Unicode/empty cases.
- Added reproducible, manual `apps/gateway/test/fixtures/bodies/readMemoryProbe.ts`: separate `prepare ROOT` and `read ROOT` processes avoid conflating envelope construction with reader peak. Read path starts real host/worker, retains ~32 MiB collector text, and submits a ~16 MiB capture write while reading a legacy 60 MiB plaintext artifact. Repeated read invocations use unique write IDs.
- **I5:** only raw route checks an authenticated viewer and returns 403/no-store; anonymous and other non-admin principals still go through existing `requireAdmin` (401). Other admin routes/guards unchanged. Matrix exception is explicit, with an endpoint-only test of viewer403/anonymous401 and preview-viewer401.
- `ARCHITECTURE.md` updated. No new SQLite writes/barrier operations, no Task8/9 edits, no subagents or push.

### RED → GREEN evidence

- `bun test packages/control/test/bodyPreview.test.ts` RED: new escaped three-attempt regression threw `body preview reply exceeds 8 MiB`; 3 pass / 1 fail. After removing semantic cap, all parts keep exact 1 MiB prefixes/full sizes. HTTP and CLI regression uses eight 2.4 MB serialized bodies (~19 MB artifact), including escaping overhead. CLI exercises text, `--full`, `--json`, `--json --full`.
- `bun test apps/gateway/test/routes/admin.test.ts -t 'HTTP preview streams'` RED with original whole-envelope route behavior restored locally: instrumentation reports `main Response.json`, 1 fail. GREEN restoring streamed response: 1 pass / 26 assertions. Test calls actual Elysia route + actual worker; hooks main `JSON.stringify`, large parse, decrypt, `Response.json`, envelope fetch, then consumes HTTP bytes with saved test-only parser. Eight escaped prefixes and all full sizes checked. No main fallback.
- `bun test apps/gateway/test/bodies/host.test.ts -t progressing` RED with fixed-total timer behavior restored locally: `GatewayError: body reader unavailable` after first 20-second chunk, at next advance; 1 fail. GREEN `bun test apps/gateway/test/bodies/host.test.ts -t 'progressing|lifetime|decode admission'`: 3 pass / 13 assertions, including 80-second progress and real inactivity/decode expiration.
- `bun test packages/store/test/encryption.test.ts -t 'large legacy'` RED: `large numeric iterator allocation`, stack at legacy `decrypt` spread; 1 fail. GREEN all encryption tests in covering run; near-cap real worker read still works.
- `bun test apps/gateway/test/routes/authMatrix.test.ts -t 'every route'` RED: `GET /api/requests/m1/body/raw?part=client.request as viewer -> 401 (expected 403)`. GREEN `bun test apps/gateway/test/routes/authMatrix.test.ts`: 14 pass / 52 assertions including explicit raw viewer403/anonymous401 and unchanged preview-viewer401.
- Covering command before final broad run: `bun test packages/control/test/bodies.test.ts packages/control/test/bodyPreview.test.ts packages/store/test/encryption.test.ts apps/gateway/test/bodies apps/gateway/test/routes/admin.test.ts apps/gateway/test/routes/authMatrix.test.ts apps/gateway/test/export/boundary.test.ts apps/cli/test/bodies.test.ts`: 207 pass / 2 skip / 0 fail, 11320 assertions, 23.99 s. This invocation omitted PG env; dedicated `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway/test/bodies/readPostgres.test.ts` then passed 1 test / 7 assertions, checking streamed preview bytes and resumed raw bytes.

### Memory measurement (not a hard safety bound)

Exact commands:

```sh
mkdir -p /tmp/opencode/task7-memory-round1
bun apps/gateway/test/fixtures/bodies/readMemoryProbe.ts prepare /tmp/opencode/task7-memory-round1
/usr/bin/time -v bun apps/gateway/test/fixtures/bodies/readMemoryProbe.ts read /tmp/opencode/task7-memory-round1 > /tmp/opencode/task7-fix-memory.log 2>&1
/usr/bin/time -v bun apps/gateway/test/fixtures/bodies/readMemoryProbe.ts read /tmp/opencode/task7-memory-round1 > /tmp/opencode/task7-fix-memory-repeat.log 2>&1
```

Prepare output: `plaintext=62914692 envelope=125829449` (60 MiB request plus artifact frame). First read: `previewBytes=1048980 retainedBytes=33554440 writeState=ready budgetHeld=33554440`; **880236 KiB maximum RSS**, **3.23 s**, exit0. Repeated read with unique write ID: same output fields, **922748 KiB maximum RSS**, **3.48 s**, exit0. One attempted repeat before making probe IDs unique failed with SQLite duplicate request ID; it was a probe setup error, not used as a read measurement.

These are whole-process peak RSS observations with actual retained capture/write overlap, not a cgroup guarantee. Native decrypt, ~120 MiB envelope/string, whole artifact parse/serialization and runtime allocator high-water marks remain substantial. Single admission prevents concurrent admin decode multiplication but does not alone make this safe under arbitrary install memory limits. Review's old 16 MiB decode baseline (952304 KiB) used a different narrow probe; the ~60 MiB overlap measurements here are not an apples-to-apples speed/RSS comparison. No arbitrary legacy refusal was added.

### Final verification / self-review

- `bun run typecheck`: core724/dashboard210 files, no errors.
- `bun run lint`: 951 files, zero diagnostics.
- `bun run check:claims`: no stale claims; `bun run check:dead`: no dead exports (existing common-word unchecked notes only).
- `bun run test:dashboard`: 817 pass / 0 fail, 2480 assertions / 52 files, 52.56 s. Intentional plugin/route error-boundary console noise remains; not represented as pristine warning-free output.
- `OMNI_TEST_DATABASE_URL=postgres://postgres:omni@127.0.0.1:55433/omni bun test apps/gateway packages/control apps/cli packages/store`: **3924 pass, 1 skip, 0 fail**, 46293 assertions across227 files, 185.77 s. The explicit raw-only auth test was added while this broad run was running; the subsequent complete authMatrix run (14 pass) covers it independently. Compact output does not name the one skipped test. PG reader test separately passed (not skipped).
- `git diff --check`: clean. Lifecycle actual-close/publication/generation logic unchanged; read disposition remains synchronous on pause/crash. Encoded preview can be large but crosses threads only via bounded demand-driven slices. Host read handling is still concentrated in the already-large host file; no unrelated restructure.

Fix commits: `ecd7ba1d fix(store): avoid legacy decode number arrays`; `449584a6 fix(bodies): stream previews without semantic caps`; report-only commit follows. Status: DONE_WITH_CONCERNS solely for measured substantial whole-artifact memory costs and host size; I1–I5 closed by these changes, subject to review.
