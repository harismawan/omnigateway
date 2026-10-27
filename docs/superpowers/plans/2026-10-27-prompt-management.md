# Prompt Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver versioned, globally/per-key assigned system-prompt additions with ponytail compatibility, safe request injection, and operator/client administration surfaces.

**Architecture:** Keep injection and effective-list resolution in pure `@omni/prompts`; persist user prompts behind both `Store` implementations and cache active texts in the routing snapshot. Control owns validation/admin operations; transports and UI consume those contracts. Transactional store writes arbitrate alias reconciliation, version numbers, caps, and assignment/deletion races.

**Tech Stack:** Bun 1.4.4, strict TypeScript, Bun SQLite/Postgres SQL, Elysia, Zod, React/TanStack Router/Query, styled-components; existing Bun and happy-dom tests.

**Spec:** `docs/superpowers/specs/2026-10-24-prompt-management-design.md`, including its explicitly controller-authored 2026-10-27 clarifications.

## Global Constraints

- Append only; no prepend, replace, variables, model-specific assignment, version-pinned assignment, or prompt-fetch application API.
- Built-ins: `ponytail-lite`, `ponytail-full`, `ponytail-ultra`, pinned `v4.9.0`; read-only, always active, duplicable without marker semantics.
- IDs `[a-z0-9-]{1,40}`; user IDs cannot start `ponytail-`; name 1..80, description ≤500, note ≤200 characters.
- At most 50 user prompts, 100 retained versions/prompt, 5 IDs/global list, 5 IDs/key list; at most one built-in/list.
- Text `trimEnd()` only, nonblank, 1..16,000 UTF-16 code units afterward; appended block ≤32,000 including `\n\n` separators after dedupe; drop overflowing suffix.
- `Settings.prompts = []`; key defaults `{ ids: [], inheritGlobal: true }`. Effective global-then-key order, first-ID dedupe, key built-in wins, missing/inactive entries skipped with constant note.
- Never add prompt text/free-form IDs to `LogFields` or classifier requests. Preserve cache-marker count/TTL and frozen inputs; no forced auto-cache.
- New migrations are SQLite `024_prompts.sql`, Postgres `013_prompts.sql`; both tables trigger PG config-version changes; SQLite swap forwarders must include every method.
- Library/console reads reader/admin only; mutations admin only. Client sees only own effective names/texts and scoped logs, never library/history.
- Actual route `_app.prompts.tsx`, menu after Keys/before Usage. Both global controls move out of Settings; unrelated Settings saves retain their fetched assignments.
- Execute with `omnigateway/gpt-6.1-sol#high` implementers and independent reviewers. Commit each reviewed unit; no push without operator authorization. Branch `feat/prompt-management` starts at `94315ca8`, stacked on `feat/log-export-bodies` (#278).

## Review Focus

- Simultaneous saves, rollback/pruning, and assignment/deletion from sibling stores must preserve unique versions/active pointers and never create a deletion race (Tasks 2–3).
- Old or stale whole-settings objects must not erase an omitted list or reconcile aliases outside the locked stored value (Task 3).
- Corrupt persisted JSON, invalid IDs, inactive drafts, and expired/revoked key assignments must degrade predictably while still blocking assigned-prompt deletion (Tasks 2–3).
- Injection followed by model/adapter/store failure must retain actually applied IDs; screening must never see operator text and failover must reuse bytes (Task 4).
- Prompt edits during an open client/console session must refresh only authorized policy data; historical links must not substitute current text (Tasks 5, 7–8).

## File boundaries and dependency order

1. `packages/prompts/src/{catalog,index,resolve}.ts`: leaf vocabulary/normalizers, injection/reporting, effective resolution; `packages/ponytail/src/index.ts`: public text export only.
2. `packages/store/src/{types,promptRow}.ts`, `{sqlite,postgres}/prompts.ts`: common data contract, tolerant row reading, transactional user library. Backend config/keys/usage files persist assignments/log IDs.
3. `packages/control/src/{prompts,schemas,settings,keys}.ts`: validated administration and safe projections. Alias algorithm stays in `store/src/types.ts`.
4. `packages/router/src/{types,snapshot}.ts`, gateway dispatch/proxy/logging: cached active map, one resolution, injection lifecycle.
5. Gateway `routes/prompts.ts`, admin/client/stream registration: guarded HTTP and invalidations.
6. Shared log query/export/projection and gateway export encoders: IDs survive every existing explicit serializer.
7. Dashboard `features/prompts/`: library/editor/history and global/per-key summaries; shared assignment selector owns ordered IDs UI.
8. Dashboard Keys/Settings/Logs/Client: integrations, not a second library implementation.
9. CLI `commands/prompts.ts`: calls control directly; injected file/stdin effects.
10. Control backend-copy, store snapshot tests, README/architecture/invariant docs: lifecycle and rollout.

Execute 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Each task is an independently reviewable behavior slice, not a parallel-agent instruction. Update concrete fixtures affected by required fields within the task introducing that field; never weaken production types to satisfy fixtures.

### Behavioral assertion pins

Use these concrete assertions inside the named task's failing tests, alongside the scenario matrix in each task. Variables refer to that test's arranged fixtures/result, not additional public interfaces.

| Task | Test | Required assertion |
|---|---|---|
| 1 | separator budget | `expect(result.report.applied.map(p => p.id)).toEqual(["a", "b"]); expect(result.report.skipped).toEqual([{ id: "c", reason: "over-budget" }]);` |
| 2 | prune keeps active | `expect(detail.versions).toHaveLength(100); expect(detail.activeVersion).toBe(1); expect(detail.versions.some(v => v.version === 2)).toBe(false);` |
| 3 | old-client omitted list | `expect(saved.prompts).toEqual(["team", "ponytail-full"]); expect(saved.ponytailMode).toBe("full");` |
| 4 | throw after injection | `expect(completed.prompts).toEqual(["team@3"]); expect(completed.status).toBe(500);` |
| 5 | holder cannot enumerate | `expect(libraryResponse.status).toBe(401); expect(summary.effectivePrompts.map(p => p.id)).toEqual(["team"]);` |
| 6 | exact boundary | `expect(page.logs.map(log => log.id).sort()).toEqual(["team-v1", "team-v11"]);` |
| 7 | missing history | `expect(screen.getByText("Version unavailable")).toBeTruthy(); expect(screen.queryByDisplayValue(currentText)).toBeNull();` |
| 8 | unrelated settings save | `expect(settingsRequest.prompts).toEqual(["team", "ponytail-full"]);` |
| 9 | draft command | `expect((await store.prompts.get("team"))?.activeVersion).toBeNull();` |
| 10 | exact copy | `expect(copied.versions).toEqual(sourceDetail.versions); expect(copied.activeVersion).toBe(1);` |

## Shared contracts (names are binding across tasks)

`packages/prompts/src/catalog.ts` is a side-effect-free leaf (no store/router import):

```ts
export const MAX_USER_PROMPTS = 50;
export const MAX_PROMPT_VERSIONS = 100;
export const MAX_ASSIGNED_PROMPTS = 5;
export const MAX_PROMPT_TEXT_CHARS = 16_000;
export const MAX_APPENDED_PROMPT_CHARS = 32_000;
export const PROMPT_MISSING_NOTE = "prompt:missing";
export type PromptAssignment = { ids: string[]; inheritGlobal: boolean };
export function isPromptId(value: unknown): value is string; // existing built-ins or valid user slug
export function readPromptIds(value: unknown): string[]; // tolerant stored-value normalization
export function readPromptAssignment(value: unknown): PromptAssignment;
```

`packages/prompts/src/index.ts` exports `ResolvedPrompt`, `PromptsReport`, `injectPrompts`, `promptNotes`, `builtinPrompts`, and resolver exports. `ResolvedPrompt` matches the spec; `skipped.reason` includes `over-budget`. `builtinPrompts(): readonly ResolvedPrompt[]` uses public `rulesetFor`, shared marker, literal version `v4.9.0`.

```ts
export type PromptResolution = {
  prompts: readonly ResolvedPrompt[];
  notes: readonly string[];
};
export function resolvePrompts(
  globalIds: readonly string[],
  assignment: PromptAssignment,
  active: ReadonlyMap<string, ResolvedPrompt>, // includes built-ins
): PromptResolution;
```

`packages/store/src/types.ts` re-exports `PromptAssignment` from the leaf; no store import of injection. Define:

```ts
export type Prompt = {
  id: string; name: string; description: string | null; activeVersion: number | null;
  createdAt: number; updatedAt: number;
};
export type PromptVersion = {
  promptId: string; version: number; text: string; note: string | null; createdAt: number;
};
export type PromptDetail = Prompt & { versions: PromptVersion[] }; // newest first
export type ActivePrompt = Prompt & { version: number; text: string };
export type PromptAssignments = { global: boolean; keyIds: string[] };
export type PromptCreate = {
  id: string; name: string; description: string | null;
  text: string; note: string | null; activate: boolean;
};
export type PromptSave = { text: string; note: string | null; activate: boolean };
export interface PromptRepo {
  list(): Promise<Prompt[]>;
  get(id: string): Promise<PromptDetail | null>;
  listActive(): Promise<ActivePrompt[]>;
  assignments(id: string): Promise<PromptAssignments>;
  create(input: PromptCreate): Promise<PromptDetail>;
  update(id: string, input: { name: string; description: string | null }): Promise<Prompt>;
  saveVersion(id: string, input: PromptSave): Promise<PromptVersion>;
  activate(id: string, version: number): Promise<Prompt>;
  remove(id: string): Promise<void>;
  importRow(row: PromptDetail): Promise<void>; // exact retained history, not normal save
}
```

Add `Store.prompts`, `Settings.prompts: string[]`, `ApiKey.prompts: PromptAssignment`, `KeyRepo.setPrompts(id: string, prompts: PromptAssignment): Promise<void>`, `RequestLog.prompts: string[]` (`id@version`, not text), `RequestLogQuery.promptId?: string | undefined`. Preserve `ApiKeyInput` backwards compatibility by making its new `prompts` input optional, normalized at creation; returned keys always carry it. Store mutation failures use `PromptStoreError extends Error` with `kind: "missing" | "exists" | "limit" | "assigned" | "version-missing"` and optional `assignments?: PromptAssignments`; control maps to existing `GatewayError` codes (missing/version-missing `BAD_REQUEST`, conflicts/caps `CONFLICT`). Under the management lock, assignment writers reject newly added references to missing user prompts (drafts are valid); unchanged restored dangling IDs may remain. Existence is a transactional repository check, not a Zod schema rule. This makes a deletion-winning race refuse the new assignment, while an assignment-winning race refuses deletion.

### Task 1: Pure prompt catalog, resolver, and injection

**Files:** Create `packages/prompts/package.json`, `packages/prompts/src/catalog.ts`, `packages/prompts/src/index.ts`, `packages/prompts/src/resolve.ts`, `packages/prompts/test/{catalog,resolve,inject,imports}.test.ts`. Modify `packages/ponytail/src/index.ts`, workspace consumers' `package.json` as needed, `bun.lock`.

**Interfaces:** Produce all pure contracts above; keep existing `injectPonytail` public/behavior unchanged. `promptNotes(report: PromptsReport): readonly string[]` emits only the spec's constants, including legacy built-in applied/dedupe notes.

- [ ] **RED tests:** `empty retains identity`; `joins survivors into one block`; `dedupes marker in system turn but not user turn`; `full-text dedupe and repeated injection`; `leading whitespace retained`; `budget includes separator and drops suffix after dedupe`; `only final cache marker moves with identical TTL`; `earlier marker stays`; `no survivor means no marker move`; `notes cannot quote IDs/text`. Assert `16_000 + 2 + 15_998 === 32_000` fits and a following prompt does not; an overflowing middle survivor drops a later small survivor too. Deep-freeze requests, messages, blocks, and resolved prompts. Resolver asserts inherit off, first occurrence order, key ponytail wins, inactive/missing note once, corrupt lists/bad IDs/defaults/first built-in; import guard forbids I/O/store/router imports.
- [ ] **Run RED:** `bun test packages/prompts/test` → new imports/functions fail before implementation.
- [ ] **GREEN:** Implement exports/contracts and constants; scan system text blocks and system-role history only; compare trimmed full text for dedupe but append saved text unchanged. Include already accepted survivors in dedupe checks so two identical custom texts do not double-inject. Budget the deduped ordered survivors, mark dropped suffix `over-budget`, then move cache marker once. Normalize stored wrong containers/defaults, valid array entries first-ID/first-built-in and first 5; invalid reserved ponytail IDs are invalid. Build null-safe maps, never object-property ID lookup.
- [ ] **Run GREEN:** `bun test packages/prompts/test packages/ponytail/test` → PASS. `bun install` updates workspace lock once; no fetched rulesets/new runtime libraries.
- [ ] **Review/commit gate:** inspect pure dependency boundary; controller-approved commit `feat: add pure managed prompt transforms`.

### Task 2: Transactional library and assignment persistence on both backends

**Files:** Create `packages/store/src/{promptRow,promptAssignments}.ts`, `packages/store/src/sqlite/prompts.ts`, `packages/store/src/postgres/{prompts,promptLock}.ts`, migrations `packages/store/src/sqlite/migrations/024_prompts.sql`, `packages/store/src/postgres/migrations/013_prompts.sql`, `packages/store/test/contract/prompts.test.ts`. Modify `packages/store/src/{types,index}.ts`, `packages/store/src/sqlite/{store,config,keys,usage}.ts`, `packages/store/src/postgres/{store,config,keys,usage}.ts`, `packages/store/test/contract/harness.ts`, `packages/store/test/contract/{keys,usage}.test.ts`, impacted fixtures/package manifests.

**Interfaces:** Produce store contracts above and `{ type: "promptsChanged" }` in `RoutingChange`. `promptAssignments` reads normalized explicit lists from raw settings/all key rows, not effective inheritance. `lockPromptManagement(conn: Conn): Promise<void>` in PG uses `pg_advisory_xact_lock(hashtext($1))` with fixed namespace `omni:prompt-management`; acquire before any row/config-version lock. Assignment normalization comes from Task 1; no text injection import.

- [ ] **RED tests (use `forEachStore`, `fresh`, `sibling`, `exec`, `logRow`):** create/metadata/draft/active/history/rollback; version INSERT immutability; 101 saves prune oldest nonactive while retaining active v1; numbers remain monotone after pruning; two sibling saves get distinct consecutive numbers; concurrent activate/prune never leaves dangling active pointer; cap 50 with concurrent creates at 49; assigned draft deletion refuses and names global/key IDs including expired/revoked keys; concurrent delete vs global assignment, key create, import, and setter never leaves a newly dangling assignment to a deleted existing prompt. Test unchanged restored dangling assignments remain writable, but newly adding a missing ID refuses under the lock. Key null/bad JSON defaults, first built-in/invalid IDs normalization; log `prompts` append/begin/route/finish/read/scan/export-reader round-trip. Retained forwarder reference works after SQLite reopen.
- [ ] **Run RED:** `bun test packages/store/test/contract/prompts.test.ts packages/store/test/contract/keys.test.ts` → missing repo/column assertions fail. Run again with `OMNI_TEST_DATABASE_URL` naming a disposable test DB; harness drops its public schema. Do not claim PG coverage if skipped.
- [ ] **GREEN schema:** two user tables, composite version PK, cascading parent delete, nullable active pointer checked by transactional code (avoid circular FK), key nullable TEXT JSON, logs TEXT NOT NULL DEFAULT `'[]'`. Add PG `bump_config_version` triggers on both new tables. Preserve existing migrations. Initialize new log/key/settings defaults and explicit SQL read/write columns on both backends and export-reader projections.
- [ ] **GREEN writes:** each SQLite mutation uses synchronous `.immediate`; each PG prompt mutation and global/key assignment writer (config settings, key create/import/setPrompts) takes management lock first. Create checks count and inserts v1 atomically. Save locks parent, INSERTs `MAX(version)+1`, optionally activates, prunes oldest nonactive to 100, updates timestamp in one transaction. Activate verifies retained version. Delete rechecks normalized references in its transaction and refuses with structured assignment data. Metadata updates/imports use the same lock ordering. Emit after commit, never on rollback; add SQLite stable forwarding methods and PG factory wiring. Only `listActive` joins active version text; `list` has no history/text.
- [ ] **Run GREEN:** `bun test packages/store/test/contract/prompts.test.ts packages/store/test/contract/keys.test.ts packages/store/test/contract/usage.test.ts` → PASS for both named backends, no deadlock/timeouts. Use coordinated transaction barriers for PG races where needed, not sleeps; raw SQLite second-connection transactions cover lock exclusion since its repo calls are synchronous.
- [ ] **Review/commit gate:** verify every assignment writer takes the same lock before triggers can lock config version; `feat: persist managed prompts on both stores`.

### Task 3: Atomic ponytail alias and validated control operations

**Files:** Create `packages/control/src/prompts.ts`, `packages/control/test/prompts.test.ts`, `packages/store/test/contract/promptSettings.test.ts`. Modify `packages/store/src/types.ts` (`mergeSettings` and shared read helpers), both `config.ts`, `packages/control/src/{schemas,settings,keys,index}.ts`, `packages/control/test/{settings,keys}.test.ts`.

**Interfaces:** Control exports `listPrompts(store: Store): Promise<PromptLibraryEntry[]>`, `readPrompt(store: Store, id: string): Promise<PromptView>`, `createPrompt(store: Store, input: unknown): Promise<PromptView>`, `updatePrompt(store: Store, id: string, input: unknown): Promise<PromptView>`, `savePromptVersion(store: Store, id: string, input: unknown): Promise<PromptVersion>`, `activatePromptVersion(store: Store, id: string, input: unknown): Promise<PromptView>`, `duplicatePrompt(store: Store, sourceId: string, input: unknown): Promise<PromptView>`, `removePrompt(store: Store, id: string): Promise<void>`, `setKeyPrompts(store: Store, id: string, input: unknown): Promise<void>`.

`PromptLibraryEntry = { id: string; name: string; description: string | null; builtin: boolean; activeVersion: number | string | null; estimatedTokens: number; assignments: PromptAssignments }`; `PromptView = PromptLibraryEntry & { versions: Array<{ version: number | string; text: string; note: string | null; createdAt: number | null }> }`. Built-ins merge here, not as rows; versions are newest first. Shared schemas: `promptIdsSchema`, `keyPromptsSchema`, `promptCreateSchema`, `promptMetadataSchema`, `promptSaveSchema`, `promptActivateSchema`, `promptDuplicateSchema`.

- [ ] **RED tests:** legacy absent `prompts` + full upgrades on read without a write; present empty/malformed list never resurrects ponytail. Truth table for only prompts changed, only mode changed, both changed (list wins), neither changed; mode replacement retains built-in position/removes for off/appends when absent. Old-client omitted prompts preserve user IDs. Stale full-object API/CLI-shaped writes compare to locked latest stored values, not a prior control read. Concurrent first settings writes and existing-row writes keep aliases consistent and existing retention-marker behavior. Validate reserved slug, unknown builtin, duplicate/multiple built-ins, >5 IDs, nonboolean inherit, extra properties, whitespace-only text, post-trimEnd length; preserve leading spaces. Builtin mutation rejects; duplicate active chooses active text not newer draft, never-active chooses latest, built-in copy has no marker property. Counts include all explicit refs; effective inheritance is not counted.
- [ ] **Run RED:** `bun test packages/control/test/prompts.test.ts packages/control/test/settings.test.ts packages/store/test/contract/promptSettings.test.ts` → behavior assertions fail.
- [ ] **GREEN alias:** add shared `readPromptSettings(stored: { prompts?: unknown; ponytailMode?: unknown }): Pick<Settings, "prompts" | "ponytailMode">` to store types and use after raw parsing on both backends. Keep `mergeSettings(current: Settings, patch: Partial<Settings>, now: number): Settings`; detect actual supplied fields, structural array equality, and changed values relative to locked current. Reconcile in that helper only, preserving retention/weights. `settingsSchema.prompts` optional with no default; control builds absent-vs-present patch exactly like guardrail optional fields.
- [ ] **GREEN control:** strict Zod validation with create/save `activate` default true; optional description/note normalized to null; metadata PUT replaces name/description. Transform text via `trimEnd`, reject `text.trim() === ""`. Store rechecks transactional rules; control maps `PromptStoreError`, never read/check/write deletion. Built-ins fixed labels `Ponytail Lite/Full/Ultra`, description identifies pinned ruleset, null timestamp, readonly version `v4.9.0`. Token estimates use `estimateInputTokens` on a minimal system-only request. Format validation is strict; missing newly assigned IDs are the store's locked check, not a control preflight.
- [ ] **Run GREEN:** previous command plus `bun test packages/control/test/keys.test.ts packages/store/test/contract/prompts.test.ts` → PASS, both backends for store tests.
- [ ] **Review/commit gate:** no control-side alias merge or race-prone preflight-only caps; `feat: expose prompt control and ponytail alias`.

### Task 4: Snapshot-based resolution and failure-safe request injection

**Files:** Modify `packages/router/src/{types,snapshot}.ts`, `apps/gateway/src/dispatch/index.ts`, `apps/gateway/src/routes/proxy.ts`, `apps/gateway/src/logging.ts`, `apps/gateway/test/dispatch/{dispatch,snapshotCache}.test.ts`, `apps/gateway/test/routes/proxy.test.ts`, `apps/gateway/test/guardrail/proxy.test.ts`, `apps/gateway/test/smartRouter/proxy.test.ts`. Create `apps/gateway/test/routes/promptsProxy.test.ts`; update required snapshot fixtures.

**Interfaces:** Add `Snapshot.prompts: ReadonlyMap<string, ActivePrompt>` (user active rows, names retained). Snapshot builder calls `store.prompts.listActive()` once alongside existing reads; pure resolver map combines these rows with `builtinPrompts()` at proxy resolution. Add `DispatchOptions.prompts?: readonly ResolvedPrompt[]`, `promptResolutionNotes?: readonly string[]`; absent means empty, never another settings-only injection. Add optional synchronous `DispatchDeps.onPrompts?: (state: { prompts: readonly string[]; notes: readonly string[] }) => void`, called immediately after the transform stage, before model resolution. Preserve existing `onRoute` signature.

- [ ] **RED tests:** all 3 inference surfaces × streaming/nonstreaming apply global/key effective list; count_tokens equals estimate of identically injected IR; key opt-out/key ponytail precedence; failover receives identical system bytes after an activation between attempts. Snapshot reload sees active edit, metadata edit and version prune; spy `get`/history to throw during inference and prove no library/history request read. Classifier `requestTransforms:false` defeats even a supplied list/notes; screening input excludes unique operator-text sentinel; local reroute then receives it. Dedupe/budget logged IDs contain only `report.applied`. After injection, unknown model/no candidates, adapter setup throw before outcome return, stream failure, and cancellation retain applied IDs; pre-injection auth/screen refusal has `[]`. First pending row already has applied IDs.
- [ ] **Run RED:** `bun test apps/gateway/test/routes/promptsProxy.test.ts apps/gateway/test/dispatch/snapshotCache.test.ts` → missing snapshot/options/injection assertions fail.
- [ ] **GREEN:** after authentication/admission capture one prompt snapshot and resolve once from its global IDs, authenticated key assignment and active map. Freeze/copy the resolution and reuse across run/reroute; count_tokens uses same helper/resolver/injector, not a second algorithm. Screening continues to receive original client IR. In dispatch replace ponytail call after RTK/before resolveModel with injector; false transforms skips prompts and resolver notes entirely. Assign `log.prompts = report.applied.map(({id,version}) => \`${id}@${version}\`)`, union constant notes, then notify `onPrompts` before any later throw. No prompt resolution inside attempt loop or hidden direct-dispatch fallback; adapt direct-dispatch test callers to pass explicit resolved lists.
- [ ] **GREEN lifecycle:** proxy keeps per-request last-applied state initialized empty; `onPrompts` snapshots ID/notes arrays synchronously. Copy it into first `newPendingRequestLog` before `beginLog`; later `routeLog` only updates target. Terminal catch uses outcome log if available, otherwise fills its fallback completed log from saved injection state; screen/auth failure leaves empty. Streaming completion remains once-only; no extra usage debit. Log defaults include `prompts: []`.
- [ ] **Run GREEN:** `bun test apps/gateway/test/routes/promptsProxy.test.ts apps/gateway/test/dispatch apps/gateway/test/guardrail apps/gateway/test/smartRouter` → PASS including retained ponytail alias gateway coverage. `bun test packages/router/test` → PASS.
- [ ] **Review/commit gate:** no request-path history reads, operator text never enters screening, callback cannot turn false transforms back on; `feat: apply snapshot prompts to inference requests`.

### Task 5: Guarded API, scoped client summary, and routing/policy freshness

**Files:** Create `apps/gateway/src/routes/prompts.ts`, `apps/gateway/test/routes/prompts.test.ts`. Modify `apps/gateway/src/{app,routes/admin,routes/client,routes/stream}.ts`, `packages/control/src/{keys,index}.ts`, `apps/gateway/test/routes/{authMatrix,clientLogShape}.test.ts`, `apps/gateway/test/e2e/clientSurface.test.ts`, `apps/gateway/test/cluster/sharedCoord.test.ts`, `apps/gateway/test/stream/authorised.test.ts`.

**Interfaces:** `PromptRouteDeps = { store: Store; admin: AdminAuth; broadcaster?: Invalidator; logger?: Logger }`; `promptsRoutes(deps: PromptRouteDeps)` follows `exportRoutes` and registers all spec endpoints. `OwnKeySummary = ApiKeySummary & { effectivePrompts: Array<{ id: string; name: string; version: number | string; text: string }> }`; change `readOwnKey(...): Promise<OwnKeySummary>`, not the shared listKeys projection. Read own key first, then current settings/listActive; select only effective IDs and names, no descriptions/history/assignment counts. Keep `dayOffsetMinutes` as existing additive summary field.

- [ ] **RED tests:** every library GET permits viewer/admin and refuses client/machine/anonymous; all writes admin-only, strict bodies, conflict names, missing retained version. Key create/set and settings global update invalidate library counts. Own summary inherits/opts out/overrides with names+texts only, cannot request another key or library. After edit, activation or assignment change an already-open holder refreshes own summary without receiving another key ID/text; two nodes update active injection via routing fanout. Add raw SQL external edit of each new PG table to prove version triggers, independently of local emits.
- [ ] **Run RED:** `bun test apps/gateway/test/routes/prompts.test.ts apps/gateway/test/e2e/clientSurface.test.ts apps/gateway/test/cluster/sharedCoord.test.ts` → route/auth/freshness assertions fail (Redis/PG skips are not evidence).
- [ ] **GREEN:** handlers only authenticate/parse/delegate/render. Prompt mutations call existing `changed("res:prompts")` pattern; settings/key assignment changes also invalidate prompts counts, and prompt activation/name changes invalidate own-summary data. Store emits `promptsChanged`; app routing pubsub treats it as configuration invalidation, remote-node filtered as today. Keep console `res:prompts` reader-only. For client freshness choose bounded polling of own summary (10s, including while LIVE), not broadened library-topic access; this is an allowed privacy-preserving implementation of the clarification. No invalidation payload contains IDs/text.
- [ ] **Run GREEN:** previous command plus `bun test apps/gateway/test/routes/authMatrix.test.ts apps/gateway/test/stream` → PASS with disposable Postgres and Valkey configured for cross-node cases. Control tests assert listKeys did not gain other keys' effective texts.
- [ ] **Review/commit gate:** readers cannot mutate; clients cannot enumerate global library; `feat: add prompt API and own policy summary`.

### Task 6: Exact prompt filters and all observability projections

**Files:** Modify `packages/store/src/{logPage,exportReader}.ts`, both backend `usage.ts` if needed, `packages/control/src/{logs,clientLog}.ts`, `apps/gateway/src/routes/{admin,client}.ts`, `apps/gateway/src/export/record.ts`, `apps/gateway/src/export/encoders/otlp.ts`; create `packages/store/test/contract/promptLogFilter.test.ts`; modify `packages/store/test/contract/exportReader.test.ts`, `packages/control/test/{logPage,clientLog}.test.ts`, `apps/gateway/test/export/{record,otlp}.test.ts`, associated `apps/gateway/test/export/fixtures/*` explicit golden records.

**Interfaces:** `LogFilterInput.prompt?: string | undefined` maps validated full ID to `RequestLogQuery.promptId`; same HTTP `prompt` on console/client downloads/pages. `ClientLog.prompts: string[]`; `RequestRecord.prompts: string[]` additive to `omni.request_log/v1`; OTLP attribute `omni.prompts` is a string array of applied IDs. Add `prompts` to `EXPORT_COLUMNS`; CSV uses existing array JSON encoding, JSONL preserves array.

- [ ] **RED tests:** rows `team@1`, `team-extra@2`, `other-team@3`, `team@11` prove filter `team` matches first/fourth only across paging/export/own scope. Missing/invalid IDs refused at API; persisted malformed log JSON reads `[]`. Assert record, webhook/elasticsearch passthrough, OTLP log/trace attributes, CSV header/cell, JSONL, client projection all carry applied IDs exactly, never texts; empty `[]` round-trips. Golden record assertions must require field rather than accept arbitrary objects.
- [ ] **Run RED:** `bun test packages/control/test/logPage.test.ts packages/control/test/clientLog.test.ts apps/gateway/test/export/record.test.ts apps/gateway/test/export/otlp.test.ts packages/store/test/contract/promptLogFilter.test.ts` → missing filter/projection assertions fail.
- [ ] **GREEN:** shared SQL predicate uses case-sensitive `instr`/`strpos` on quoted-prefix `JSON.stringify(id + "@").slice(0, -1)`, including opening quote and `@` boundary; validated slugs contain neither quotes nor `@`. Parameter bind, no LIKE substring collision. Add filter to explicit handler picks, schema/query conversion, export field lists and export-reader SELECT/row parser. Preserve `readsNothing` before `scopeKey` and current client redaction. Export encoders use copied ID arrays and constant attribute name.
- [ ] **Run GREEN:** previous command plus `bun test packages/store/test/contract/exportReader.test.ts packages/control/test/export.test.ts apps/gateway/test/export` → PASS; update golden documents deliberately, not broad snapshot acceptance.
- [ ] **Review/commit gate:** inspect every explicit serializer, not just store type spread; `feat: expose applied prompts in logs and exports`.

### Task 7: Dedicated Prompt Management console page

**Files:** Create `apps/dashboard/src/routes/_app.prompts.tsx`, `apps/dashboard/src/features/prompts/{PromptsBoard,PromptEditor,PromptAssignments,PromptSelector,PromptVersionDiff}.tsx`, `apps/dashboard/test/features/prompts.test.tsx`. Modify `apps/dashboard/src/{api/types,api/client,api/queries,session/invalidation}.ts`, `apps/dashboard/src/components/RailNav.tsx`, generated `apps/dashboard/src/routeTree.gen.ts`; rail-order assertions live in the new prompts feature suite.

**Interfaces:** Mirror Task 3 wire types locally, including `PromptAssignment`; do not import control/providers/prompts implementation into dashboard. Query keys `prompts: ["prompts"]`, `prompt(id): ["prompts", id]`; hooks `usePrompts`, `usePrompt(id)`, mutation hooks named for each Task 3 operation; `res:prompts` invalidates prefix. Route search `{ id?: string; version?: string }` selects exact historical version including `v4.9.0`. Shared `PromptSelector({ value: string[], onChange: (ids: string[]) => void, library: PromptLibraryEntry[], disabled?: boolean })` provides ordered add/remove/up/down, five-ID and one-built-in constraints.

- [ ] **RED tests (happy-dom/fetchStub/renderWithRouter):** menu after Keys before Usage and reader navigation; builtins first/badge/readonly/Duplicate; new save-and-activate vs draft; metadata save; version rollback; char/tokens counts; explicit global/key assignment counts and inactive draft delete reason; error keeps draft. Global list and moved ponytail alias synchronize both directions. Readonly per-key table lists nondefault assignments with effective preview and edit-key link. Missing/pruned requested version displays `Version unavailable` and never today's text. Library/detail invalidation refetches both. Reader has no enabled mutation affordance.
- [ ] **Run RED:** `bun run --cwd apps/dashboard test test/features/prompts.test.tsx` → missing route/visible controls fail.
- [ ] **GREEN:** build three stacked areas Library, Editor/history, Assignments; use styled-components and existing fields/dialogs/accessibility primitives. `PromptVersionDiff` renders line-level added/removed text against preceding retained version (label missing predecessor when pruned), no new diff dependency. Mutation response/refetch selects newly saved exact version. Use server estimates; unsaved estimate may call permitted pure IR estimator. Global saves fetch/current settings plus changed field, leaving alias reconciliation to server; no optimistic dual-alias stale overwrite. Generated route tree through existing dashboard build tooling, not manual alternate routing.
- [ ] **Run GREEN:** previous command; `bun run build:dashboard` → PASS and `/prompts` generated under authenticated `_app`; `bun run --cwd apps/dashboard test test/imports.test.ts` → PASS.
- [ ] **Review/commit gate:** historical unavailable state cannot silently select active; `feat: add Prompt Management console page`.

### Task 8: Key editor, Settings preservation, own-policy display, and log chips

**Files:** Create `apps/dashboard/src/features/keys/EditPromptsDialog.tsx`, `apps/dashboard/src/features/prompts/AppliedPromptChips.tsx`. Modify `apps/dashboard/src/routes/_app.keys.tsx`, `apps/dashboard/src/features/keys/{KeysBoard,MintKeyDialog}.tsx`, `apps/dashboard/src/features/settings/SettingsBoard.tsx`, `apps/dashboard/src/features/logs/{RequestTable,LogFilterBar}.tsx`, `apps/dashboard/src/features/client/ClientBoard.tsx`, `apps/dashboard/src/api/{types,queries,client}.ts`; tests `apps/dashboard/test/features/{keys,settings,logs,client}.test.tsx`, `apps/dashboard/test/features/logTerms.test.ts`, `apps/dashboard/test/session/invalidation.test.ts`.

**Interfaces:** `EditPromptsDialog` consumes whole `{ ids, inheritGlobal }`, Task 7 selector, and effective preview derived from fetched global IDs+key IDs/library active flags with the resolver's tested semantics mirrored as UI-only display (no request policy authority). `AppliedPromptChips({ prompts: string[], operator: boolean })`: operator links to `/prompts?id=<id>&version=<version>`; client renders inert text chips. Expose key-dialog search target `editPrompts?: string` on actual `_app.keys.tsx` route and update `KeysBoard` to open matching dialog.

- [ ] **RED tests:** key mint/set carries both fields; ordered list, inherit off, duplicate ID/pony precedence preview, whole replacement clearing; deep link opens proper key dialog. Settings shows only exact relocation link, no prompt inputs, and unrelated save preserves nonempty fetched `prompts` array/mirrored mode. Logs parse/serialize `prompt:team` to `prompt` query/filter, applied chips deep-link exact version for operator only. Client own names/texts render read-only, log chips never navigate console, no catalog/library fetch (use `makeQueryClient({catalog: false})`). Client summary re-polls at 10s under LIVE, policy changes appear without other-key data. Disabled viewer controls remain disabled in shared selector/dialog.
- [ ] **Run RED:** `bun run --cwd apps/dashboard test test/features/keys.test.tsx test/features/settings.test.tsx test/features/logs.test.tsx test/features/client.test.tsx` → visible contract/payload assertions fail.
- [ ] **GREEN:** move ponytail control entirely to Task 7 page; Settings draft/serialize must retain fetched `prompts` even though no input renders it. Share selector/chips instead of another library fetch in client. Add summary wire type `effectivePrompts`, retain raw key assignment as own config, and polling independent of socket cadence. Add prompt term to both `TERMS` and `TERM_FIELDS`, search serialization/API picks/download filters; clients' scoped filters still cannot set key identity.
- [ ] **Run GREEN:** previous command plus `bun run --cwd apps/dashboard test test/session/invalidation.test.ts` → PASS; operator/client projection assertions explicitly differ.
- [ ] **Review/commit gate:** client has no console link or usePrompts call; `feat: integrate prompt policy across dashboard`.

### Task 9: Local CLI prompt administration

**Files:** Create `apps/cli/src/commands/prompts.ts`, `apps/cli/test/prompts.test.ts`. Modify `apps/cli/src/{registry,command,run}.ts`, `apps/cli/src/commands/{keys,settings}.ts`, `apps/cli/test/{keys,commands}.test.ts`, CLI test harness fixtures as needed; existing settings command assertions live in `commands.test.ts`.

**Interfaces:** register `omni prompts list`, `show <id> [--version n]`, `create <id> --name <name> [--file <path>|--file -] [--draft]`, `save <id> [--file <path>|--file -] [--note <note>] [--draft]`, `activate <id> <version>`, `duplicate <source> <id> [--name <name>]`, `remove <id>`; absent `--file` reads stdin. `keys prompts <id> --ids a,b [--no-global]`; empty `--ids ''` clears. `settings set prompts a,b` supports empty list. Extend injected `CommandEnv` with `promptInput: { readFile(path: string): Promise<string>; readStdin(): Promise<string> }`; runtime alone uses Bun.file/Bun.stdin, tests inject.

- [ ] **RED tests:** file/stdin exact leading whitespace survives and trailing trimmed by control; drafts/activate/rollback/show exact version; builtins list/show/duplicate but mutation refuses; default duplicate name from source unless supplied; omitted assignment `--ids` refuses, `--no-global` changes inherit, empty clears; stale settings whole object preserves assignments/alias; failures never echo prompt text, IDs/counts visible, `--json` structured; no HTTP or process spawn. Never wait on TTY stdin without an explanatory error.
- [ ] **Run RED:** `bun test apps/cli/test/prompts.test.ts apps/cli/test/keys.test.ts apps/cli/test/commands.test.ts` → registry/behavior assertions fail.
- [ ] **GREEN:** all commands call Task 3 control, not `/api/*` or SQL. Validate version as positive decimal integer (builtin show accepts `v4.9.0`); default duplicate name source name. Runtime checks interactive stdin and reports `provide --file or pipe prompt text`; injected input preserves indentation. Map CLI flags to whole key body; settings resubmits existing object changing `prompts` only. Add command help and ensure existing `ponytailMode` setting remains accepted.
- [ ] **Run GREEN:** previous command → PASS; `bun apps/cli/src/index.ts prompts --help` → documented commands, no DB/provider access for help.
- [ ] **Review/commit gate:** prompt body never in argv/logs/error echo; `feat: add local prompt management commands`.

### Task 10: Snapshot/backend-copy integrity, rollout documentation, full verification

**Files:** Modify `packages/control/src/copyStore.ts`, `packages/control/test/copyStore.test.ts`, `packages/store/test/contract/maintenance.test.ts`, `packages/control/test/database.test.ts`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-08-29-ponytail-prompt-injection-design.md`. Test snapshot swaps through `apps/gateway/test/routes/database.test.ts`; no production change to `REQUIRED_TABLES` in `packages/store/src/sqlite/maintenance.ts`.

**Interfaces:** extend `CopyCounts` with `prompts: number`, `promptVersions: number`. Task 2 `PromptRepo.importRow(row: PromptDetail)` inserts every retained original number/text/note/timestamp and active pointer atomically with no renumbering or pruning, refusing duplicate parent/invalid pointer/over-cap data. This internal import is not an HTTP endpoint.

- [ ] **RED tests:** SQLite snapshot/restore retains assignments, draft+active history and log IDs; pre-feature snapshot accepted then migrations add empty prompt tables; held forwarders survive restored handle. Backend copy of noncontiguous retained versions `1, 4..102` with active v1 preserves numbers/timestamps exactly, next save is v103, all assignments arrive after library import. A target containing only a user prompt refuses before any write. Both SQLite→PG and PG→SQLite copied datasets preserve fields where disposable PG exists. Slug delete/recreate succeeds; log's pruned/deleted target unavailable without using active text (UI Task 7 regression retained).
- [ ] **Run RED:** `bun test packages/control/test/copyStore.test.ts packages/store/test/contract/maintenance.test.ts apps/gateway/test/routes/database.test.ts` → prompt history/counts/empty-target assertions fail.
- [ ] **GREEN:** preflight target user library with existing checks, fetch/validate source retained detail, import library **before** `config.putSettings` and `keys.importRow`; never rebuild via save/activate. Preserve log IDs through existing append/copy. SQLite snapshots already contain tables; old snapshots must remain accepted, so leave REQUIRED_TABLES unchanged. Include builtin-independent user-table counts only.
- [ ] **Docs:** README explains creation/assignment/draft/rollback, limits/cache cost, key visibility, non-sandbox behavior, **do not put confidential material in a managed prompt**, upgrade ponytail alias and fail-open rollback for user/per-key prompts, history retention/unavailable/slug-reuse limitation. Architecture documents pure stage/snapshot/locking/invalidation and export IDs. CLAUDE adds package boundary, reserved prefix, sixth editable key field and durable alias-lock invariant with tests. Ponytail spec History points here; do not rewrite earlier operator decisions as new approval.
- [ ] **Run GREEN focused:** previous command plus `bun test packages/store/test/contract/prompts.test.ts packages/store/test/contract/promptSettings.test.ts packages/control/test/prompts.test.ts apps/gateway/test/routes/promptsProxy.test.ts` → PASS on both backends. Confirm intended test DB/Redis variables before destructive harness use.
- [ ] **Full execution gate (separate commands):** `bun install --frozen-lockfile`; `bun run test:all`; `bun run typecheck`; `bun run lint`; `bun run check:claims`; `bun run check:dead`; `bun run build:dashboard`. Require exit 0, no new warnings/skipped mandatory PG/Redis coverage, and no unintended lockfile or generated output changes. Record actual environment and blockers rather than claiming skips passed.
- [ ] **Review/commit gate:** controller whole-branch review after focused task reviews; `feat: preserve prompt history across database moves`. Do not push without explicit authorization.

## Plan self-review / execution notes

- Coverage: pure package (1), both stores/races (2), alias/admin semantics (3), dispatch/count_tokens/screening/log failure state (4), auth/cluster/client privacy (5), every log/export projection/filter (6), dedicated page/version history (7), Keys/Settings/client/log integrations (8), CLI (9), snapshots/copy/docs/rollout (10).
- Type consistency: library repositories contain users only; snapshot carries named active user rows; resolver accepts structural `ResolvedPrompt` map including built-ins; API history uses numeric/string versions and distinguishes library summaries from own-key summaries. Only IDs enter request logs; missing notes remain separate from injection report.
- Focused inspection verified existing `forEachStore`/sibling/exec harness, store `mergeSettings` under locks, hand-written SQLite forwarders, `buildSnapshot`, proxy first-route/catch lifecycle, explicit record/CSV/client serializers, and `_app.*` routing convention. New test names above are deliberate new assertions; follow existing nearby helpers, not live provider calls.
- Current-tree paths above were checked; preserve the narrow existing harness patterns rather than starting a fresh exhaustive remap.
- Operational prerequisite: disposable Postgres and Valkey for mandatory concurrency/cross-node verification. If unavailable, report verification blocker; no product-design question blocks implementation. Historical `id@version` has no incarnation identity after slug reuse; the documented limitation must remain explicit, not "fixed" by expanding scope.
