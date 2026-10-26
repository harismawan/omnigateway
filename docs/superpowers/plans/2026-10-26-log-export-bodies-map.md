# PR2 body map — current state (read-only survey, 2026-10-26)

Repo: /home/homebrew/.local/share/opencode/worktree/1600a1/feat-log-export
HEAD while surveyed: `9c12a2f7` ("fix(export): a lease answer delayed past its TTL claims no epoch (I4)").
**Note:** another session committed during the survey (HEAD went 8c5f9681 → 9c12a2f7). Those commits
touched `export/loop.ts`, `export/state*`, `exportHost/supervisor.ts` (comment only), `index.ts`
(`readDestinations` revision), `store/types.ts` (+`ExportDestination.revision`), `control/export.ts`
and the export migrations. The loop.ts and supervisor.ts line numbers below were re-checked at 9c12a2f7.
Paths are relative to the repo root unless they are absolute.

Design spec that already describes PR2: `docs/superpowers/specs/2026-10-24-log-export-design.md`
§Bodies L248–487 (64 MiB, no bounding, body writer `apps/gateway/src/bodies/writer.ts`, `body_state`,
1 MiB transfer slices, staging + publish-ok, preview + raw route, export body states, budgets,
restore/generation). Metrics named there that **do not exist yet**: `omni_bodies_dropped_total{reason}`,
`omni_export_bodies_late_total`. Env vars named there that **do not exist yet**:
`OMNI_BODY_CAPTURE_BUDGET_BYTES`, `OMNI_EXPORT_BODY_BUDGET_BYTES`.

---------------------------------------------------------------------------------------------------

## 1. packages/store/src/bodies/

Files: `artifact.ts` (696 lines), `bound.ts` (127), `mask.ts` (227). Nothing else lives there.

### 1.1 artifact.ts — constants
| symbol | line | value |
|---|---|---|
| `ARTIFACT_SCHEMA_VERSION` | 16 | `1` |
| `MAX_ARTIFACT_BYTES` | 27 | `512 * 1024` (the comment says "applied after structural bounding") |
| `BODY_ROW_CAP` | 36 | `100_000` |
| `BODIES_DIRNAME` | 39 | `"request_bodies"` |
| `MAX_ENVELOPE_BYTES` (exported) | 230 | `2 * MAX_ARTIFACT_BYTES + 65` (legacy hex = 2N+65) |
| `BINARY_MAGIC` | 232 | `encoder.encode("OGBA")` |
| `LEGACY_PREFIX` | 233 | `encoder.encode("enc:v1:")` |
| `BINARY_VERSION` | 240 | `1` |
| `BINARY_HEADER_BYTES` | 242 | `10` (magic 4, version 1, codec 1, claimed uint32 BE 4); this is also the GCM AAD |
| `BINARY_IV_BYTES` / `BINARY_TAG_BYTES` | 243/244 | 12 / 16 |
| `BINARY_OVERHEAD` | 245 | 38 |
| `MAX_BINARY_ENVELOPE_BYTES` (private) | 246 | `MAX_ARTIFACT_BYTES + BINARY_OVERHEAD` |
| `CODEC_RAW` / `CODEC_GZIP` | 249/251 | 0 / 1 |
| `GZIP_MIN_PLAINTEXT_BYTES`, `GZIP_LEVEL`, `GZIP_MIN_SAVING_BYTES`, `GZIP_FRAME_BYTES` | 262–266 | 1024, 1, 64, 18 |
| `LEGACY_IV_HEX_CHARS` / `LEGACY_TAG_HEX_CHARS` | 435/436 | 24 / 32 |
| `SAFE_REQUEST_ID` | 68 | `/^[A-Za-z0-9_-]{1,128}$/` |

### 1.2 artifact.ts — types and functions (exact signatures)
- `export type BodyOmission = { omitted: true; reason: string; serializedBytes: number }` (L48–52)
- `export function bodiesDirFor(databasePath: string): string` (L56): `join(dirname(db), "request_bodies")`
- `export function isSafeRequestId(id: string): boolean` (L70)
- `export function relPathFor(requestId: string, at: number): string` (L83–89): `YYYY/MM/DD/<id>.json.enc`, UTC
- `export async function sha256Hex(bytes: Uint8Array): Promise<string>` (L91)
- `function bodyPair(pair: {request: unknown; response: unknown; truncated?: boolean}): {request; response; truncated: boolean}` (L112–124):
  `boundValue(maskSecrets(x))` per half; `truncated = pair.truncated === true || req.truncated || res.truncated`, an OR and never recomputed.
- `function omission(serializedBytes: number): BodyOmission` (L126–132): reason
  `` `artifact exceeded ${MAX_ARTIFACT_BYTES} bytes after structural bounding` ``.
- `function omitBodies(artifact: BodyArtifact, marker: BodyOmission): BodyArtifact` (L142–157): `client` becomes
  `{request: marker, response: marker, truncated: true}`; each attempt keeps `attempt` and `provider` and gets
  `request/response = marker, streamChunks: null, truncated: true`; `error` is kept.
- `export function prepareArtifact(input: BodyArtifact): { artifact: BodyArtifact; json: string }` (L171–218). This is the
  equivalent of "buildArtifact": it masks, then bounds each pair; streamChunks go through `boundValue(chunks.map(maskString))` (L179–180);
  `error` goes through `boundValue(maskSecrets(error))` (L190); the result is rebuilt with `schemaVersion: ARTIFACT_SCHEMA_VERSION` (L192–199);
  `JSON.stringify`, then `Buffer.byteLength` is compared with `MAX_ARTIFACT_BYTES` (L201–205). When it is over, `omitBodies` runs (L207–212), and if that is still over the
  error is replaced by the marker too (L216–217). That last fallback is **not rechecked** (see `plaintextOf`).
- `type SealedArtifact = { bytes: Uint8Array; sha256: string }` (L276, private)
- `function plaintextOf(json: string): Uint8Array<ArrayBuffer>` (L288–294): throws
  `"artifact plaintext is outside the binary envelope's bounds"` if the length is <1 or >MAX_ARTIFACT_BYTES.
- `export async function sealArtifact(key: CryptoKey, json: string): Promise<SealedArtifact>` (L304–307). This is the **only writer used by
  both stores**: binary OGBA, codec raw.
- `export async function sealArtifactWithGzip(key, json, level = GZIP_LEVEL): Promise<SealedArtifact>` (L318–344). It is used only by the
  benchmark and runs gzip via `CompressionStream`.
- `async function sealBinary(key, claimed: number, codec: number, payload: Uint8Array): Promise<SealedArtifact>` (L347–372):
  header written at [0..10), random IV, AES-GCM with `additionalData` = header, digest over the whole envelope.
- `export type ArtifactFailure = "missing" | "corrupt"` (L375)
- `export type ArtifactRead = { ok: true; artifact: BodyArtifact } | { ok: false; failure: ArtifactFailure }` (L377–379)
- `export async function readArtifact(key: CryptoKey, dir: string, relPath: string, expectedSha256: string | null): Promise<ArtifactRead>` (L389–398)
- `async function acquireArtifact(path: string): Promise<Uint8Array | ArtifactFailure>` (L409–432): it opens a handle and stats it;
  `size > MAX_ENVELOPE_BYTES` gives `"corrupt"`; it reads size+1 bytes and returns "corrupt" if the file grew; an open or read error gives `"missing"`.
- `function isLegacyStructure(text: string): boolean` (L447–463): 5 `:` parts, `enc`, `v1`, IV of 24 hex, tag of 32 hex.
- `type BinaryEnvelope = { header; codec; claimed; iv; sealed }` (L466–472)
- `function payloadFits(codec, payloadBytes, claimed): boolean` (L481–490): raw requires `payload === claimed`; gzip requires `>= 18`.
- `async function expand(codec, payload, claimed): Promise<Uint8Array>` (L493–502)
- `export async function gunzipArtifact(payload: Uint8Array, claimed: number): Promise<Uint8Array>` (L518–528):
  `gunzipAsync(payload, { maxOutputLength: MAX_ARTIFACT_BYTES, info: true })` (L519–522); it then checks
  `consumed === payload.length` and `output.length === claimed`.
- `function inflateResult(result: unknown)` (L534–541)
- `function parseBinary(bytes: Uint8Array): BinaryEnvelope | null` (L549–565): length must be in
  `[BINARY_OVERHEAD, MAX_BINARY_ENVELOPE_BYTES]`, version 1, `1 <= claimed <= MAX_ARTIFACT_BYTES`, and `payloadFits` must hold.
- `async function openBinary(key, envelope): Promise<string>` (L567–584): decrypt, then expand, then `TextDecoder(fatal)`.
- `export async function decodeArtifact(key: CryptoKey, bytes: Uint8Array, expectedSha256: string | null): Promise<ArtifactRead>` (L603–632):
  `bytes.length > MAX_ENVELOPE_BYTES` gives corrupt; the magic picks binary or legacy with no fallback between them; the digest is checked; `JSON.parse`; a non-object
  gives corrupt; **any throw gives `{ok:false, failure:"corrupt"}`**. The success result is `parsed as BodyArtifact`, with no shape validation
  beyond "is a plain object".
- `export async function writeArtifact(dir: string, relPath: string, bytes: Uint8Array): Promise<void>` (L634–642):
  `mkdir -p` + `writeFile`, with **no staging, no fsync and no rename**.
- `export async function deleteArtifact(dir: string, relPath: string): Promise<void>` (L651–669): unlink, then rmdir any empty shard dirs.
- `export async function listArtifacts(dir: string): Promise<string[]>` (L679–696): a recursive walk that includes **every** file
  (there is no `.staging` exclusion today).

Package exports (`packages/store/src/index.ts` L1–16): `ARTIFACT_SCHEMA_VERSION, BODIES_DIRNAME, BODY_ROW_CAP,
bodiesDirFor, MAX_ARTIFACT_BYTES`, `MAX_ARRAY_ITEMS, MAX_DEPTH, MAX_OBJECT_KEYS, MAX_STRING_BYTES`, the sqlite
`createBodyRepo`. `package.json` subpaths: `.`, `./exportReader`, `./exportStatus`, `./types`. The artifact.ts
functions are not exported from the root; `MAX_ENVELOPE_BYTES` and `decodeArtifact` are imported by `postgres/bodies.ts` directly.

### 1.3 bound.ts
- `MAX_STRING_BYTES = 64 * 1024` (L24), `MAX_ARRAY_ITEMS = 24` (L33, keeps the **last** items), `MAX_DEPTH = 6` (L43),
  `MAX_OBJECT_KEYS = 80` (L46, keeps the first), `STRING_TRUNCATION_MARKER = "…[truncated]"` (L49), `DEPTH_MARKER` (L52).
- `export type Bounded<T> = { value: T; truncated: boolean }` (L81)
- `export function boundValue(value: unknown): Bounded<unknown>` (L89–127): a recursive `walk(input, depth)`.
- Used only by `artifact.ts` L8, L117–118, L180, L190. Nothing in `apps/` calls it.

### 1.4 mask.ts
- `ELIDED = "[redacted]"` (L43). Rules: `BEARER` L50, `PREFIXED_KEY` L67, `VENDOR_KEY` L97, `VENDOR_PREFIX` L100, `XAI_KEY` L122, `OPAQUE`
  `/[A-Za-z0-9_-]{41,}/g` L152.
- `export type MaskRuleId` L155; `export type MaskRule = { id; pattern: RegExp; keep(match): number }` L165–170;
  `export const MASK_RULES: readonly MaskRule[]` L176–193.
- `export function maskString(value: string): string` (L196–205): the rules are reduced in order.
- `export function maskSecrets(value: unknown): unknown` (L218–227): **recursive**. A string goes to `maskString`; an array is
  `map(maskSecrets)`; an object is `Object.fromEntries(Object.entries(v).map(([k,v]) => [k, maskSecrets(v)]))`. Keys are not masked, and there is no
  depth guard (it relied on `boundValue` only *after*, so deep input recurses unbounded here).

### 1.5 Artifact JSON shape (`packages/store/src/types.ts`)
- `BodyDetailState = "none" | "ready" | "missing" | "corrupt"` (L1130)
- `BodyPair = { request: unknown; response: unknown; truncated: boolean }` (L1139–1144)
- `BodyAttempt = BodyPair & { attempt: number; provider: ProviderId; streamChunks: string[] | null }` (L1147–1157)
- `BodyArtifact = { schemaVersion: number; requestId: string; at: number; client: BodyPair; attempts: BodyAttempt[]; error: unknown }` (L1172–1180)
- `BodyArtifactRow = { requestId; at; relPath: string|null; sizeBytes; sha256: string|null; detailState: BodyDetailState; truncated: boolean }` (L1183–1194)
- `BodyRead = { row: BodyArtifactRow; artifact: BodyArtifact | null }` (L1202–1205)
- `interface BodyRepo` (L1207–1234):
  `put(artifact: BodyArtifact): Promise<BodyArtifactRow>`; `get(requestId: string): Promise<BodyRead | null>`;
  `prune(olderThan: number): Promise<number>`; `pruneToCap(cap?: number): Promise<number>`; `sweepOrphans(): Promise<number>`.
- `Store.bodies: BodyRepo` (L2068). `BodyOmission` is **not** in types.ts; it is in artifact.ts L48 and a hand-mirrored copy
  sits in `apps/dashboard/src/api/types.ts` L549.

Example stored JSON:
```json
{"schemaVersion":1,"requestId":"req_…","at":1730000000000,
 "client":{"request":{…parsed client JSON…},"response":{…or SSE frame strings[]…},"truncated":false},
 "attempts":[{"attempt":1,"provider":"anthropic","request":{…},"response":{…|string},"streamChunks":null,"truncated":false}],
 "error":null | {"code":"UPSTREAM","status":502}}
```
For an omitted artifact, each `request` and `response` is `{"omitted":true,"reason":"artifact exceeded 524288 bytes after structural bounding","serializedBytes":N}`.

### 1.6 Where `truncated` is recorded
1. Capture layer (gateway): `Attempt.truncated` in `bodyCapture.ts` (L64, set at L214/219/225/268/301), the
   `FrameSink.truncated` flag (L145, L171), and the route sets `captured.client.truncated = true` on cancel (`proxy.ts` L817, L985) and on frame-sink
   eviction (L593).
2. Bounding: an OR is applied in `bodyPair` (artifact.ts L122) and for chunks at L187; `omitBodies` forces `true`.
3. Row column: `truncated = prepared.artifact.client.truncated || attempts.some(a => a.truncated)` (sqlite/bodies.ts L92–94, postgres/bodies.ts L92–94),
   stored in `request_bodies.truncated`.
4. Read side: `RequestBodyRead.truncated` (control/bodies.ts L23) comes from `row.truncated`.

---------------------------------------------------------------------------------------------------

## 2. Bodies repo on both backends

### 2.1 Schema
- SQLite `packages/store/src/sqlite/migrations/008_body_logging.sql` L39–47:
  `request_bodies(request_id TEXT PK, at INTEGER NOT NULL, rel_path TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT, detail_state TEXT NOT NULL DEFAULT 'none', truncated INTEGER NOT NULL DEFAULT 0)`,
  `idx_request_bodies_at (at DESC)` L52; `ALTER TABLE api_keys ADD COLUMN body_logging_opt_out` L60. There is no FK to request_logs.
- Postgres `packages/store/src/postgres/migrations/001_init.sql` L233–243: the same columns (BIGINT/BOOLEAN) **plus `bytes BYTEA`**.
- Latest migrations: sqlite `022_log_export.sql`, postgres `010_log_export.sql`, so the next numbers are 023 and 011. SQLite migrations are imported as text in
  `sqlite/db.ts` (L2 onward, `import … with { type: "text" }`).
- `request_logs` has **no `body_state`** column today (`grep body_state` finds nothing in src or migrations).
- `request_bodies` is in `CORE_TABLES` (`packages/store/src/plugins/guard.ts` L70).

### 2.2 SQLite `packages/store/src/sqlite/bodies.ts`
- `export function createBodyRepo(db: Database, key: CryptoKey, dir: string): BodyRepo` (L54)
- `toDetailState` (L32): an unknown value becomes `none`.
- `removeRows` (L63–72): deletes the file first, then `DELETE FROM request_bodies WHERE request_id = ?` in one transaction.
- `recordState(requestId, state)` (L74–76): `UPDATE request_bodies SET detail_state = ? WHERE request_id = ?`.
- **put** (L79–127): `isSafeRequestId` throw (L83) → `prepareArtifact` (L87) → `sealArtifact(key, json)` (L88), so **encryption happens
  in the repo on the calling (main) thread** → `relPathFor(id, at)` (L89) → `writeArtifact(dir, relPath, bytes)` (L90) → upsert (L106–125):
  ```sql
  INSERT INTO request_bodies (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT (request_id) DO UPDATE SET at = excluded.at, rel_path = excluded.rel_path, size_bytes = excluded.size_bytes,
    sha256 = excluded.sha256, detail_state = excluded.detail_state, truncated = excluded.truncated
  ```
  It writes `detailState: "ready"` and returns the row.
- **get** (L129–148): `SELECT *`; null when there is no row; `{row, artifact:null}` if `relPath===null || detailState==="none"`; otherwise
  `readArtifact(key, dir, relPath, sha256)`. On ok it records `ready` if the row was not already ready; on failure it records `missing` or `corrupt`. This write happens on the
  main connection during a read.
- **prune(olderThan)** (L150–156): `SELECT * … WHERE at < ?`, then removeRows.
- **pruneToCap(cap = BODY_ROW_CAP)** (L158–171): COUNT, then the oldest `ORDER BY at ASC, request_id ASC LIMIT total-cap`.
- **sweepOrphans** (L191–211): snapshot `Set` of `rel_path`, then for each `listArtifacts(dir)` not in the set it re-queries
  `SELECT COUNT(*) … WHERE rel_path = ?` before `deleteArtifact`. There is no staging exclusion and no pending-publication set.
- Sqlite store forwarder `packages/store/src/sqlite/store.ts`: the `Handle` type has `bodies: BodyRepo` (L39); `open()` builds
  `bodies: createBodyRepo(db, opts.encryptionKey, bodiesDirFor(opts.path))` (L99). The stable forwarder (L206–212) is:
  ```ts
  bodies: { put: (a) => handle.bodies.put(a), get: (id) => handle.bodies.get(id), prune: (o) => handle.bodies.prune(o),
            pruneToCap: (c) => handle.bodies.pruneToCap(c), sweepOrphans: () => handle.bodies.sweepOrphans() },
  ```
  `reopen()` and `close()` swap `handle`. `routing.version()` reads `PRAGMA data_version` (L255–257).

### 2.3 Postgres `packages/store/src/postgres/bodies.ts`
- `export function createBodyRepo(sql: SQL, key: CryptoKey): BodyRepo` (L60). `META` column list (L46) excludes `bytes`.
- removeRows (L61–69): `DELETE … WHERE request_id IN (SELECT jsonb_array_elements_text($1::jsonb))`.
- put (L79–130): the same prepare and seal on the caller's thread, `relPathFor` kept as the name; upsert including `bytes = EXCLUDED.bytes` (L106–128).
- get (L132–168): the **length filter**:
  ```sql
  SELECT ${META}, CASE WHEN octet_length(bytes) <= $2 THEN bytes ELSE NULL END AS bytes,
         octet_length(bytes) AS encoded_size FROM request_bodies WHERE request_id = $1   -- $2 = MAX_ENVELOPE_BYTES
  ```
  `encoded_size === null` gives missing; `bytes === null` gives corrupt; otherwise `decodeArtifact(key, new Uint8Array(bytes), sha256)`.
  The state write-back is the same as on SQLite.
- prune / pruneToCap (L170–190); `sweepOrphans()` returns 0 (L193–195).
- Wired in `postgres/store.ts` L101: `bodies: createBodyRepo(sql, opts.encryptionKey)`. Postgres has no forwarder (the pool is stable;
  `reopen()` is a no-op, L118–121).
- `request_bodies` carries no `bump_config_version` trigger (the triggers are at 001_init.sql L275–293, on other tables).

### 2.4 Other callers of the repo
- `packages/control/src/database.ts`: `DatabaseStore.bodies: Pick<BodyRepo,"prune"|"sweepOrphans">` (L89);
  `clearBodies(deps)` (L805–811) runs `prune(deps.now())` + `sweepOrphans()`; `getDatabaseOverview` `bodiesBytes` (L879 Postgres from table
  stats; L890 SQLite `fs.dirBytes(bodiesDirFor(live))`).
- `packages/control/src/copyStore.ts` L25: bodies are **not carried** to a new backend.
- CLI `ctx.store()` (`apps/cli/src/context.ts` L240–256) always uses `createStore` (SQLite) with a fresh key.

---------------------------------------------------------------------------------------------------

## 3. apps/gateway/src/bodyCapture.ts (327 lines)

- `MAX_CAPTURED_BODY_BYTES = MAX_ARTIFACT_BYTES` (L35), imported from `@omni/store` (L3).
- Private `type Attempt = { attempt; provider; request: unknown; responseChunks: string[]; responded: boolean; frames: string[]|null; truncated: boolean }` (L45–65);
  `textOf(entry)` joins the chunks (L74).
- `export type BodyCollectorOptions = { captureStreamChunks: boolean }` (L78–86)
- `export type BodyCollector = { wrap(http: HttpClient): HttpClient; client: BodyPair; attempts(): BodyAttempt[]; settle(): Promise<void> }` (L88–105)
- `asBody(text)` (L108): `""` gives null; otherwise `JSON.parse`, or the raw string if parsing fails. `framesOf(text)` (L125) splits on blank lines.
- `export type FrameSink = { frames: string[]; truncated: boolean; write(frame: string): void }` (L132–147)
- `export function createFrameSink(): FrameSink` (L158–176): keeps the most recent frames; evicts from the head while
  `bytes > MAX_CAPTURED_BODY_BYTES` (it counts **code units**, `frame.length`).
- `export function createBodyCollector(options: BodyCollectorOptions): BodyCollector` (L178–327)
  - `client: BodyPair = { request: null, response: null, truncated: false }` (L181). It is filled by the route.
  - `drain(stream, entry)` (L203–230): reads the tee branch to the end, decodes with `TextDecoder(stream)`, stops storing past the cap (bytes) but keeps
    reading; a source error sets truncated; frames are derived after the drain if `captureStreamChunks`.
  - `captureResponse(res, entry)` (L242–273): the `body` getter tees on first touch and pushes `drain()` into `drains`;
    `text()` keeps `text.slice(0, MAX_CAPTURED_BODY_BYTES)` (code units).
  - `wrap(http)` (L278–309): per outbound call it records `request` as `asBody(req.body)`, or a sliced raw string if over the cap (with truncated set),
    before awaiting `http(req)`. `req.headers` is never read.
  - `attempts()` (L311–320): `response: entry.responded ? asBody(textOf(entry)) : null` (the parse runs on the main thread).
  - `settle()` (L322–325): `Promise.all(drains)`.
- Streaming capture of the client response: `proxy.ts` L877–883 creates the sink, sets `captured.client.response = sink.frames` (a live
  array), and passes `onFrame = sink.write` to `sseResponse`, which calls `onFrame?.(\`event: …\ndata: …\`)` per frame (`proxy.ts` L379).

---------------------------------------------------------------------------------------------------

## 4. Route → finishLog chain, body read, gates

### 4.1 Routes (`apps/gateway/src/routes/proxy.ts`, 1163 lines)
- `proxyRoutes(deps: ProxyDeps)` (L1023): `POST /v1/messages` (L1043, surface anthropic), `/v1/responses` (L1047),
  `/v1/chat/completions` (L1051). Each calls `server?.timeout(request, 0)` and then `handle(dispatchDeps, rateLimiter, surface, request)`.
  `POST /v1/messages/count_tokens` (L1094) reads `await request.json()` (L1107) and writes no row and no capture.
- `async function handle(deps: ResolvedProxyDeps, rateLimiter, surface: Surface, request: Request): Promise<Response>` (L432). In order:
  1. `requestId`, `startedAt`, `trace` (L438–447); locals `collector`, `writeBodies: BodyWriter|undefined`, `frameSink`, `logged` (L462–479).
  2. `authenticateApiKey` (L545) gives `keyId`.
  3. **`const captured = await bodyCollectorFor(deps, key)`** (L563). If it is non-null, `writeBodies = async (completed) => { await captured.settle(); if (frameSink?.truncated) captured.client.truncated = true; await deps.store.bodies.put({ schemaVersion: ARTIFACT_SCHEMA_VERSION, requestId, at: startedAt, client: captured.client, attempts: captured.attempts(), error: completed.errorCode === null ? null : { code: completed.errorCode, status: completed.status } }) }` (L588–607).
  4. **Body read: `const body: unknown = await request.json();`** (L610). It is read as JSON, never as text.
  5. **`if (captured !== null) captured.client.request = body;`** (L611), which stores the parsed object.
  6. parse → `parseAnthropicRequest|parseResponsesRequest|parseOpenAIRequest(body, headers)` (L612–617); allowlist; `rateLimiter.admit` (L644).
  7. `runWith(...)` → `dispatch(...)` with `http: captured.wrap(deps.http)` when capturing (L681). **`onRoute`** (L683–699): on the first call it runs
     `beginLog(deps.store, newPendingRequestLog({...}), keyId, logger, broadcaster)` (L698), which is **`usage.begin`**; later calls run `routeLog` (L685), which is `usage.route`.
     So `usage.begin` comes **after** the collector is created and after `client.request` is set, at the first route of dispatch.
  8. `log(cancelled, failure)` (L809–864): sets `captured.client.truncated` on cancel (L817), `logged = true` (L850), then
     **`await finishLog(deps.store, completed, keyId, deps.logger, writeBodies, debit, deps.emit, deps.broadcaster, deps.telemetry, trace)`** (L852–863).
  9. Streaming (L866–923): the frame sink (L877–883), then `sseResponse(frames, finish, keepalive, dispatched.events, limitHeaders(), onFrame)`;
     `finish` calls `release?.()` and then `log()` (L893–910). For a stream, the finishLog/body write runs after the client stream ends (on the stream's own path).
  10. Non-streaming (L925–957): collect events, `responseBody` object (L935–942), **`captured.client.response = responseBody`** (L943),
      `await log()` (L945), **then** `jsonResponse(responseBody, …)` (L951). jsonResponse runs `JSON.stringify(body)` (L282–290). So the
      non-streaming client response waits on `finishLog`, which includes the awaited body put.
  11. Terminal catch (L958–1013): `collector.client.truncated = true` if cancelled (L985); `collector.client.response = rejection` if `!logged`
      (L989); `if (!logged) await finishLog(... writeBodies ...)` (L990–1002).
- `bodyCollectorFor(deps, key): Promise<BodyCollector | null>` (L416–427): `deps.bodyLoggingAllowed !== true` gives null (L420);
  `key.bodyLoggingOptOut` gives null (L421); `settings = (await deps.snapshots.get(deps.now())).settings` (L422); `!settings.bodyLoggingEnabled`
  gives null (L423); `createBodyCollector({ captureStreamChunks: settings.bodyLoggingCaptureStreamChunks })` (L424–426).

### 4.2 `apps/gateway/src/logging.ts` (420 lines)
- `beginLog(store, log: Omit<RequestLog,"state">, keyId, logger?, broadcast?)` (L162–205) calls `store.usage.begin({...log, state:"pending", apiKeyId})` (L171).
- `routeLog(store, requestId, target, logger?, broadcast?)` (L217–241) calls `store.usage.route` (L226).
- `export type BodyWriter = (log: RequestLog) => Promise<void>` (L251)
- `export type UsageDebit` (L260); `export type PluginEmit = (event: RequestCompleted) => void` (L295)
- **`export async function finishLog(store: Store, log: RequestLog, keyId: string | null, logger: Logger = noopLogger, bodies?: BodyWriter, debit?: UsageDebit, emit?: PluginEmit, broadcast?: Invalidator, telemetry?: Telemetry, trace?: TraceRecord | null): Promise<void>`** (L297–420). In order: `store.usage.append` (L312) → debit (L331) → plugin emit (L351) → invalidate `res:usage`/`res:logs` (L393–401) → **`await bodies(log)` in try/catch, which reports "failed to persist request bodies"** (L403–409) → `telemetry.record` (L411) → `telemetry.flush` (L416).
- Other finishLog callers pass `bodies = undefined`: `guardrail/judge.ts` L192, `smartRouter/check.ts` L327. `beginLog` is also called at
  `guardrail/judge.ts` L136.

### 4.3 Store usage (`packages/store/src/sqlite/usage.ts`)
- `begin` (L384–389) is an INSERT with state pending; `route` (L391–398); `append` (L400–402) calls `complete(log)`, a transaction (L338–348) that upserts COMPLETE,
  stamps `completed_at`, and rolls up. Postgres equivalents: `begin` L337, `route` L344, `append` L353, `complete` L320.
- `sweepPending(now)`: SQLite L404–426, Postgres L357–381. It selects `state='pending' AND (node_id = me OR node_id NOT IN live nodes)` and
  completes each with `status 499, errorCode "interrupted", durationMs 0`. It does nothing with bodies. Interface at types.ts L1568.
  `NODE_GRACE_MS = 60_000` (types.ts L1775).
- Export cursor read: `exportPageSql` (`packages/store/src/exportPage.ts` L16 onward) uses `state='done' AND completed_at IS NOT NULL AND completed_at <= settledBefore AND (completed_at,id) > (…)`, plus filter clauses; sqlite `exportPage` is at usage.ts L500, `EXPORT_FROM` at L321.

### 4.4 Gates — where each is read or checked
| gate | defined | checked |
|---|---|---|
| `OMNI_BODY_LOGGING_ALLOWED` | `packages/control/src/config.ts` L31 (type), L149 (parse: TRUTHY set), L182 | `index.ts` L383 → `createApp` dep `bodyLoggingAllowed` (`app.ts` L96) → proxyRoutes L469 / adminRoutes L480; checked at `proxy.ts` L420; surfaced on `GET /api/settings` (`admin.ts` L597); passed to the export worker init as `gates.bodyLoggingAllowed` (`index.ts` L344) |
| `OMNI_EXPORT_BODIES_ALLOWED` | `config.ts` L37, L150–152, L183 | only `index.ts` L343 → `WorkerInit.exportBodiesAllowed` (`export/protocol.ts` L35). Never read inside the worker today |
| `settings.bodyLoggingEnabled` | types.ts L969; default false L2106; zod `control/schemas.ts` L392 | `proxy.ts` L423 (per request, through the routing snapshot cache); dashboard `queries.ts` L393 |
| `settings.bodyLoggingCaptureStreamChunks` | types.ts L977; default false L2107; zod `schemas.ts` L394 | `proxy.ts` L425 → `BodyCollectorOptions.captureStreamChunks` → `bodyCapture.ts` L229, L269 |
| `ApiKey.bodyLoggingOptOut` | types.ts L615; column `api_keys.body_logging_opt_out` | `proxy.ts` L421; CLI `keys.ts` L465/L523; set only at creation |
| `settings.bodyRetentionDays` | types.ts L919; default 1 L2101 | `maintenance.ts` L55–56 |

---------------------------------------------------------------------------------------------------

## 5. Admin body read surfaces

- Route: `apps/gateway/src/routes/admin.ts` L812–815:
  ```ts
  .get("/api/requests/:id/body", async ({ request, params }) => { await requireAdmin(request, deps.admin); return readRequestBody(deps.store, params.id); })
  ```
  This is admin-only (`requireAdmin`, not `requireReader`); the reasoning is in the comment at L800–811. There is no raw route today.
- `packages/control/src/bodies.ts`:
  `export type RequestBodyRead = { requestId: string; detailState: BodyDetailState; truncated: boolean; sizeBytes: number; at: number | null; artifact: BodyArtifact | null }` (L12–29);
  `export async function readRequestBody(store: Store, requestId: string): Promise<RequestBodyRead>` (L43–64). It calls `store.bodies.get`,
  which decrypts and parses on the caller's (main) thread; when there is no row it returns `detailState: "none", at: null`. Re-exported at control `index.ts` L15.
- CLI `omni bodies`: `apps/cli/src/commands/bodies.ts`. `export const bodies: Command` (L152); usage `bodies <request-id> [--full]`;
  `run` calls `readRequestBody(await ctx.store(), requestId)` (L170), which runs **in-process and directly against SQLite, not over HTTP**, and then `emit(ctx, writer, read, …)`:
  `--json` prints the whole `RequestBodyRead`; text mode prints `frame()` (state, captured, size "on disk", truncated) (L60–70), a `pairs()` table
  (L80–116, with `payloadBytes = encode(JSON.stringify(v)).length`), and the full `JSON.stringify(v,null,2)` blocks only with `--full` (L128–150, L222–226).
  `ABSENCE` strings are at L22–35. Registered in `apps/cli/src/registry.ts` L2.
- `omni db clear-bodies` path: `apps/cli/src/commands/db.ts` L261 → `clearBodies`. HTTP: `DELETE /api/database/bodies` (`routes/database.ts` L430–435).
- Dashboard:
  - Wire type `apps/dashboard/src/api/types.ts` L531–540:
    `export type RequestBodyResponse = { requestId: string; detailState: BodyDetailState; truncated: boolean; sizeBytes: number; at: number | null; artifact: BodyArtifact | null }`;
    `export type BodyOmission = { omitted: true; reason: string; serializedBytes: number }` (L549). `BodyArtifact, BodyAttempt, BodyDetailState, BodyPair`
    are type-imported from `@omni/store/types` (L5–8, re-exported L44–47).
  - Query `apps/dashboard/src/api/queries.ts`: key `requestBody: (id) => ["logs","body",id]` (L187);
    `export function useRequestBody(requestId: string | null): UseQueryResult<RequestBodyResponse>` (L638–646), which does
    GET `/api/requests/${encodeURIComponent(id)}/body` with no polling. `useClearBodies` mutation (L777).
  - Component `apps/dashboard/src/features/logs/BodyArtifact.tsx` (268 lines): `ABSENCE` (L23–39); `BYTES` formatter whose comment
    mentions the "512 KB cap" (L42–49); `asOmission(value)` (L114); `BodyBlock({title, stage, value})` renders the omission note or
    `<Payload>{JSON.stringify(value, null, 2)}</Payload>` (L140–160); `AttemptSection` (L163); `Artifact({body})` (L184–231);
    `export function BodyArtifact({ requestId }: { requestId: string })` (L240–268). It is mounted in `features/logs/LogsBoard.tsx` L32 (import), L335
    (`<BodyArtifact requestId={open.id} />`).
  - Settings toggles are in `features/settings/SettingsBoard.tsx` L68–69, L523, L728–761.

---------------------------------------------------------------------------------------------------

## 6. Maintenance, sweepPending, restore/import

### 6.1 `apps/gateway/src/maintenance.ts` (181 lines)
- `export async function pruneLogs(store: Store, now: number): Promise<{ raw; daily; quotaSamples; bodies; bodiesOverCap; bodyOrphans }>` (L39–61):
  `bodyHorizon = now - min(bodyRetentionDays, logRetentionDays) * DAY` (L55–56); `store.bodies.prune(bodyHorizon)` (L57),
  `pruneToCap()` (L58), `sweepOrphans()` (L59).
- `export function startMaintenance(deps: MaintenanceDeps): () => void` (L97–181): a 10 s heartbeat (L104–109); an hourly timer under
  `underLease(deps.lease, "maintenance", 2h, prune)` (L117–123); `prune()` runs `store.usage.sweepPending(now)` (L129–136), then
  `void pruneFiles(files)` (L138), then `void pruneLogs(...)` (L151). `MaintenanceDeps = { store; now; logger?; fs?; lease? }` (L83–91).
- Boot: `index.ts` L164–166 runs a heartbeat and then `store.usage.sweepPending(now())`, **before** the workers start; `startMaintenance` is called at L419.
- No maintenance loop runs in the export worker apart from its own `ORPHAN_SWEEP_INTERVAL_MS` (loop.ts L75, export-state orphans).

### 6.2 Restore/import `apps/gateway/src/routes/database.ts` (561 lines)
- `DatabaseRouteDeps` (L32–73) includes `latch: QuiesceLatch`, `snapshots?`, `broadcaster?`, **`exportWorker?: ExportPause`** (L72).
- **`export type ExportPause = { pause(): Promise<void>; resume(swapped: boolean): Promise<void>; halt(): Promise<void> }`** (L76–85).
  This is the hook shape; a second worker would need either a second dep of the same shape or a composite.
- Module-level `let swapping` + `holdSwap()` (L99–107); `swap(deps, logger, label, operation)` (L131–143) → `swapGuarded` (L145–287):
  1. `closedHere = !latch.isClosed()` (L168)
  2. `await Promise.all([latch.close(deadline), pauseExport(deps)])` (L173–176). The latch drain and the worker pause run in parallel.
  3. A pause refusal causes reopen-latch-if-closedHere, then `settleExport(deps, logger, "refused")`, then throw (L183–189)
  4. `operation()` (L194), then `outcome="swapped"`, `snapshots.invalidate()`, `latch.open()`, session invalidation, `broadcaster.invalidateAll()`
  5. catch `SwapFailedError` sets `outcome="failed"` (latch stays closed) (L258–275); any other error reopens the latch if closedHere
  6. `finally: await settleExport(deps, logger, outcome)` (L280–286). It runs after `reopen()` so that the WAL and SHM exist before the worker's read-only handle.
- `pauseExport(deps): Promise<GatewayError | null>` (L293–302); `settleExport(deps, logger, outcome: SwapOutcome)` (L304–318), which calls
  `halt()` on "failed" and otherwise `resume(outcome === "swapped")`. `type SwapOutcome = "swapped"|"refused"|"failed"` (L290).
- Routes: restore L487–490, import L500–516 (with `stageUpload` L340–395).
- Wiring in `app.ts` L370–376: `exportPause` is derived from `deps.exportWorker` when it has pause, resume and halt, then passed to `databaseRoutes` at L521.
  `AppDeps.exportWorker?: ExportWorkerHandle & Partial<ExportPause>` (L181). In `index.ts` the supervisor object is passed as `exportWorker` (L387).
- Underlying swap: `packages/control/src/database.ts` `swapIn` (L566 onward): `store.close()` → unlink -wal/-shm → rename → `store.reopen()`.
  SQLite `Store.reopen` swaps `handle`, so a new body repo is built from the same path.
- Shutdown: `index.ts` `stopLoops` (L463–488) includes `() => exportWorker.stop()` (L470); `lifecycle.ts` `createShutdown` has
  `STOP_DEADLINE_MS = 5_000` (L37) and runs stopLoops (L71) before stopServer and closeStore.

---------------------------------------------------------------------------------------------------

## 7. Worker patterns

### 7.1 `apps/gateway/src/export/spawn.ts` (59 lines)
- `export type ExportWorker = { post(message: MainMessage): void; onMessage(listener: (m: WorkerMessage) => void): void; onExit(listener: () => void): void; terminate(): void }` (L12–21)
- `declare const OMNI_EXPORT_WORKER: string | undefined` (L30); `exportWorkerUrl()` (L33–36) resolves
  `new URL(OMNI_EXPORT_WORKER ?? "./worker.ts", import.meta.url).href`.
- `export function spawnExportWorker(init: WorkerInit): ExportWorker` (L38–59): `new Worker(url, { name: "omni-export", workerData: init })`;
  `onExit` listens for `close` (once). An `error` event is not treated as exit.

### 7.2 `apps/gateway/src/export/worker.ts` (128 lines)
- Reads `workerData as WorkerInit` (L43, from `node:worker_threads`); builds its own logger to stdout (L45–51) and `Timers` (L53).
- `open(): Promise<Handles>` (L58–91): `deriveKey(init.encryptionKey)`. On Postgres it creates `new SQL({url, max: 2})`, `createPostgresExportReader`,
  `createPostgresExportState` and an optional `redisCoord` lease. On SQLite it calls `openSqliteExportReader(path, key, Date.now)` (read-only) and
  `openSqliteExportState(exportDbPathFor(path))`.
- `createExportLoop({ open, transport: httpTransport, now, timers, random, post, logger, nodeId })` (L93–102).
- `self.onmessage` validates `type ∈ MAIN_MESSAGE_TYPES` and runs `loop.handle(message)`; after `stop` it calls `process.exit(0|1)` (L106–122).
  `loop.start().catch → process.exit(1)` (L124–128).
- `apps/gateway/test/export/boundary.test.ts` pins that the main-thread graph (`index.ts`, `export/spawn.ts`) never reaches the worker-only modules
  (list at L27–43, including `packages/store/src/exportReader.ts`).

### 7.3 `apps/gateway/src/export/protocol.ts` (155 lines)
- `export type WorkerInit = { databasePath: string|null; databaseUrl: string|null; encryptionKey: string; redisUrl: string|null; nodeId: string; logLevel: "debug"|"info"|"warn"|"error"; exportBodiesAllowed: boolean; gates: BodyGates }` (L22–37)
- `export type BodyGates = { bodyLoggingAllowed: boolean }` (L40)
- `export type MainMessage` (L44–66): `destinationsChanged`, `gatesChanged {gates}`, `test {ref,id}`, `preview {ref,requestId}`,
  `skip {ref,id}`, `ackGap {ref,id,seenAt}`, `pause`, `resume`, `stop`. `MAIN_MESSAGE_TYPES` (L69–79).
- `DestinationCounters` (L93–100), `DestinationStatus` (L102–128), `TestResult` (L130–132), `WorkerMessage` (L134–147; `status`,
  results, `paused`), `REPLY_ERRORS` (L150–155).

### 7.4 `apps/gateway/src/exportHost/supervisor.ts` (653 lines)
- `export type Timers = { setTimeout(fn, ms): unknown; clearTimeout(h): void }` (L52–55)
- `export type SupervisorState = "idle"|"running"|"restarting"|"down"|"paused"|"halted"|"stopping"|"stopped"` (L57–74)
- `export type ExportRequest` (L77–81); `REQUEST_TIMEOUT_MS` (L93–98: test 30 s, others 10 s)
- Constants: `PAUSE_ACK_MS 5_000` (L101), `STOP_TERMINATE_MS 5_000` (L103), `RESTART_MIN_MS 1_000` (L104), `RESTART_MAX_MS 60_000` (L105),
  `RESTART_WINDOW_MS 10 min` (L107), `RESTART_GIVE_UP 5` (L108), `IDLE_RECHECK_MS 30_000` (L110), `DOWN_RECHECK_MS 30_000` (L112),
  `TERMINATE_WAIT_MS 5_000` (L114); messages `NOT_RUNNING`, `NO_REPLY`, `NOT_QUIESCED` (L116–118).
- `export type DestinationsRead = { count: number; revision: string }` (L126)
- `export type SupervisorDeps = { init: WorkerInit; spawn: (init: WorkerInit) => ExportWorker; readDestinations: () => Promise<DestinationsRead>; timers: Timers; now: () => number; logger: Logger; metrics?: ExportMetrics; onChange?: () => void }` (L128–141)
- `export type ExportSupervisor = { start(): Promise<void>; destinationsChanged(): Promise<void>; request<R extends ExportRequest>(r: R): Promise<ReplyOf[R["type"]]>; pause(): Promise<void>; resume(swapped: boolean): Promise<void>; halt(): Promise<void>; stop(): void; state(): SupervisorState; statuses(): readonly DestinationStatus[]; restarts(): number }` (L143–168)
- `export function createExportSupervisor(deps: SupervisorDeps): ExportSupervisor` (L219)
- Behaviour summary:
  - **Export-specific coupling**: whether it should run is tied to destinations (`readDestinations`, `startIfWanted` L497 onward, idle and down polling,
    `revive` on a revision change), and replies are routed by `REPLY_TYPE` for export result types. It is typed to the export `WorkerInit`,
    `MainMessage` and `WorkerMessage`, and its log strings say "export worker". It is **not generic**; reuse would need extraction or parameterisation.
  - Generic mechanics that could be reused: the `Instance {worker, startedAt, exited, gone}` model; `spawn()` (L335) never starts beside a retiring
    worker; `retire()`; `exited()` → `died(startedAt)` (L399–430) with exponential backoff `min(60 s, 1 s·2^(n-1))`, a consecutive reset after a 10-minute
    life, and give-up after 5 deaths in 10 minutes ("down"); `stopWorker()` (L453–462) posts `stop` and terminates after 5 s; `drainRetiring()`
    (L468–481) terminates and waits ≤5 s for `close`; `serial()` lifecycle chain (L490–495); `pause` (L568–605) posts
    `pause`, waits for a `paused` ack ≤5 s, otherwise retires (terminates) it, then drains and throws `GatewayError("OVERLOADED", NOT_QUIESCED)`;
    `resume(swapped)` (L607–628) on `unsafe` → halted, otherwise posts `resume`, or starts one if none ran; `halt` (L630–638) sets `unsafe = true` and stops;
    `stop()` (L640–647) is synchronous and final; `request()` (L546) uses a ref counter, a per-type timeout, and a `pending` Map.
- `apps/gateway/src/exportHost/metrics.ts`: `ExportMetrics { instanceStarted(); fold(status); retain(ids); restarts(total) }` (L19–27);
  `createExportMetrics(registry)` (L49).
- Boot wiring `index.ts` L335–361: `createExportSupervisor({ init: {...}, spawn: spawnExportWorker, readDestinations, timers, now, logger, metrics?, onChange })`;
  `await exportWorker.start()` (L445) runs after `startMaintenance` and before `app.listen` (L456).
- Routes use `ExportWorkerHandle = Pick<ExportSupervisor, "destinationsChanged"|"request"|"state"|"statuses"|"restarts">`
  (`routes/export.ts` L35–38) and `absentExportWorker` (L64–70).

### 7.5 Build scripts (worker entries)
- `scripts/build-npm.ts`: `export const EXPORT_WORKER_ENTRY = "apps/gateway/src/export/worker.ts"` (L80), `EXPORT_WORKER_FILE = "export-worker.js"` (L81);
  `bundle(entry, outfile, version, define = {})` (L83–115); `bundleGateway(dir, version, entry = "apps/gateway/src/index.ts")` (L124–132) bundles
  `gateway.js` with `define: { OMNI_EXPORT_WORKER: JSON.stringify("./export-worker.js") }`, then bundles the worker file. The package `files` list includes
  `EXPORT_WORKER_FILE` (L158).
- `scripts/build-binary.ts`: `const EXPORT_WORKER_ENTRY = "apps/gateway/src/export/worker.ts"` (L5);
  `buildGatewayBinary(outfile, root, entry = …)` (L15–23) calls `buildBinary([entry, EXPORT_WORKER_ENTRY], outfile, root, { OMNI_EXPORT_WORKER: JSON.stringify("./apps/gateway/src/export/worker.ts") })`;
  `buildBinary(entrypoints, outfile, root, define)` (L26–48) runs `Bun.build({ compile, bytecode, minify, define })`.
- Tests: `scripts/test/build-npm.test.ts` L194–209 and `scripts/test/build-binary.test.ts` L68–81 use the probe
  `apps/gateway/test/fixtures/export/workerProbe.ts`. The Dockerfile copies only `scripts/build-binary.ts` (L41) and runs `bun run build:binary`.

---------------------------------------------------------------------------------------------------

## 8. Export worker: records, delivery, body-related occurrences

### 8.1 `apps/gateway/src/export/record.ts` (114 lines)
- `export const RECORD_SCHEMA = "omni.request_log/v1"` (L17). The header comment (L13–15) says "Part 1 carries no `body` field … additive fields stay `v1`".
- `export type RequestRecord = { schema; id; at: string; completedAt: string|null; nodeId: string|null; apiKey:{id;label}; model:{requested;resolved;provider}; credentialId; status; errorCode; attempts; tokens:{input;output;cacheRead;cacheWrite}; costUsd; ttftMs; durationMs; degradations: string[]; rtk:{…}; session:{id;turn;agent}; tags: string[]; metadata: Record<string,string>; requestIds:{client;upstream} }` (L19–50). **It has no `body` field.**
- `export type RecordContext = { keyLabel: string | null; nodeId?: string }` (L57)
- `export function buildRecord(log: RequestLog, ctx: RecordContext): RequestRecord` (L59–100). Called at loop.ts L729 (sendRows), L875 (test), L921 (preview).

### 8.2 `apps/gateway/src/export/loop.ts` (at 9c12a2f7)
- `createExportLoop(deps: LoopDeps): ExportLoop` (L193). `Handles = { reader: ExportReader; state: ExportStateStore; lease: LeaseClient|null; close() }` (L86–91 area).
- `pass(h, rt, signal, renew)` (L535): destination snapshot → claim → per-batch loop; `settled = dbNow - SETTLE_MS` (L634; `SETTLE_MS = 10_000` in `gap.ts` L21);
  `h.reader.exportPage({ after, settledBefore, limit: MAX_BATCH_RECORDS, filter, signal })`; `sendRows(...)`.
- `sendRows(h, rt, epoch, sender, rows, batch, commit)` (L714): `labels = h.reader.keyLabels()`; per row it calls
  `parts.push(sender.part(buildRecord(row, { keyLabel, nodeId })))` (L729); `cutBatches(parts, sender.envelope, sender.limits)`; `deliver(...)`; commits per batch;
  oversized records are dropped with `OVERSIZED_REASON`.
- `runPreview` (L906–922) returns `{type:"previewResult", ok:true, record: buildRecord(row, …)}`.
- `handle(message)` switch: **`case "gatesChanged":` (L1081) "Body export is part 2; the gates mean nothing to metadata records." It returns.**
- `lifecycleStep("pause"|"resume"|"stop")` (L1139 onward): pause runs cancelAll, closeHandles, and then posts `paused`; resume calls `open()`; stop runs cancelAll(STOP_BUDGET_MS 4 s) and closeHandles.
- `ExportReader` (`packages/store/src/exportReader.ts` L30–55) has destinations, destinationWithSecret, settings, keyLabels, exportPage,
  getLog and now. It has **no bodies read**. The SQLite reader is opened `readonly` with `query_only` (L64–94); it is built from `createUsageRepo`, `createConfigRepo`,
  `createKeyRepo` and `createExportDestinationRepo` only.

### 8.3 `apps/gateway/src/export/deliver.ts` (461 lines)
- `export type Sender = { type; url; headers; gzip: boolean; envelope: BatchEnvelope; limits: BatchLimits; part(record: RequestRecord): string; body(parts: readonly string[]): string; signingSecret: string|null; accepted(text, status, sent): DeliveryOutcome }` (L133–148)
- `export type Prepared` (L150), `export type DeliveryOutcome` (L152–156).
- `limitsFor(d)` (L182–185): `{ records: MAX_BATCH_RECORDS, bytes: min(MAX_BATCH_BYTES, d.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES[type]) }`.
  `DEFAULT_MAX_REQUEST_BYTES` is in `packages/control/src/export.ts` L30–34 (ES 90 MiB, webhook 50 MiB, OTLP 4 MiB). `MAX_BATCH_BYTES = 5 MiB`, `MAX_BATCH_RECORDS = 500`
  (`batch.ts` L21–22).
- `export function prepare(d: ExportDestination, secretText: string|null): Prepared` (L196 onward): ES `bulkPart(record, {indexPattern})`, gzip on;
  webhook `webhookPart`/`webhookBody`, gzip off, optional `sign`; OTLP `otlpPart(record, signal)`/`otlpBody`, gzip on.
- `export async function deliver(sender: Sender, parts: readonly string[], deps: DeliverDeps): Promise<DeliveryOutcome>` (L379–461):
  `text = sender.body(parts)` → optional HMAC → optional `Bun.gzipSync` (L392) → `deps.transport(url, {...})` with a 20 s request timeout and 5 s connect timeout.
- Encoders: `encoders/elasticsearch.ts` `bulkPart` L42; `encoders/webhook.ts` `WEBHOOK_ENVELOPE` L13, `webhookPart` L18, `webhookBody` L23;
  `encoders/otlp.ts` `otlpPart` L206, `otlpBody` L211.

### 8.4 All occurrences (non-test source + docs)
- **`gatesChanged`**: `export/protocol.ts` L48, L71; `export/loop.ts` L1081. It is never posted by the main thread (no `post({type:"gatesChanged"…})`
  in src). Tests: `test/export/loop.test.ts` L717.
- **`exportBodiesAllowed`**: `packages/control/src/config.ts` L37, L150, L183; `apps/gateway/src/export/protocol.ts` L35; `apps/gateway/src/index.ts` L343.
  Test fixtures: `workerProbe.ts` etc. Not read inside the worker.
- **`Config.exportBodiesAllowed`**: config.ts L33–37 (doc comment: "body export itself ships in a later release").
- **`include_bodies` / `includeBodies`**: migrations sqlite `022_log_export.sql` L32, postgres `010_log_export.sql`;
  `packages/store/src/exportDestinationRow.ts` L13 (column list), L28, L113; `packages/store/src/sqlite/exportDestinations.ts` L53, L93, L116;
  `packages/store/src/postgres/exportDestinations.ts` L75, L86, L107; `packages/store/src/types.ts` L1953 (`ExportDestination.includeBodies`),
  L1984 (`ExportDestinationInput`), L2005 (`ExportDestinationPatch`); `packages/control/src/export.ts` L352 (summary), L515 (refuses traces
  with bodies on edit); `packages/control/src/copyStore.ts` L152. The CLI `apps/cli/src/commands/export.ts` L262 prints the fixed text "off (body export is available
  in a later release)". The export worker loop **never reads `includeBodies`**.
- **`setDestinationBodies`**: `packages/control/src/export.ts` L550–564:
  `export async function setDestinationBodies(store: Store, id: string, input: unknown): Promise<DestinationSummary>`; `bodiesSchema = z.object({ include: z.boolean() }).strict()` (L334);
  `TRACES_BODIES` (L364); `include: true` throws `bad(TRACES_BODIES)` for OTLP traces and otherwise **`bad("body export is not available yet")`** (L559);
  false calls `update(id, {includeBodies:false})`. Re-exported at control `index.ts` L115. Route: `PUT /api/export/destinations/:id/bodies`
  (`apps/gateway/src/routes/export.ts` L170–175).
- **`body` on RequestRecord**: absent (record.ts L13–15 comment only).
- **`BodyGates` / `bodyLoggingAllowed` in export**: protocol.ts L36, L40; index.ts L344.

---------------------------------------------------------------------------------------------------

## 9. Prometheus metrics

`apps/gateway/src/telemetry/registry.ts` `MetricName` union (L1–23) and `DEFINITIONS` (L53–99):
`omni_requests_total, omni_request_duration_seconds, omni_ttft_seconds, omni_tokens_total, omni_cost_usd_total,
omni_upstream_duration_seconds, omni_inflight, omni_breaker_open, omni_ratelimit_rejected_total, omni_stream_connections,
omni_stream_queued, omni_stream_dropped_total, omni_coord_fallback, omni_coord_faults_total, omni_metrics_series_folded_total,
omni_otlp_spans_dropped_total, omni_export_records_total, omni_export_batches_total, omni_export_lag_seconds,
omni_export_gap_warnings_total, omni_export_worker_restarts_total, omni_build_info`.
**No `omni_bodies_*` and no `omni_export_bodies_*` metric exists.** A new name must be added to both the union and `DEFINITIONS`
(a typed `Record<MetricName,…>`). `omni_export_worker_restarts_total` is declared as a counter but is written with `registry.set(...)` from the supervisor (metrics.ts L84).

---------------------------------------------------------------------------------------------------

## 10. Bun request body size / server creation

- The server is created by Elysia: `app.listen({ port: config.port, hostname: config.host, idleTimeout: 255 })` (`apps/gateway/src/index.ts` L456).
  `app` comes from `createApp(...)` (`app.ts`, root `new Elysia()` around L401). There is **no `maxRequestBodySize`** anywhere in the repo's source.
- Elysia 1.4.30 (`node_modules/.bun/elysia@1.4.30…/dist/universal/server.d.ts` L29–33) documents
  `maxRequestBodySize?: number` with **`@default 1024 * 1024 * 128 // 128MB`** (Bun's default). The `serve?: Partial<Serve>` option is in Elysia config
  (`dist/types.d.ts` L73), and `listen({...})` also accepts the Serve options. Bun runtime is 1.4.4.
- Effective limits today: inference bodies are capped by Bun/Elysia at 128 MB. `POST /api/database/import` streams with its own cap
  `MAX_IMPORT_BYTES = 2 GiB` (`packages/control/src/database.ts` L760) inside `stageUpload` (`routes/database.ts` L340–395). Not verified: whether Bun also applies the
  server's `maxRequestBodySize` to this streamed body (nothing in the repo raises it).
- Per-route idle: the inference routes call `server?.timeout(request, 0)` (proxy.ts L1044/1048/1052).
