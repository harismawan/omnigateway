# Smart Router (Confidential-Data Routing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Requests from opted-in keys are judged for confidential data by a local classifier; confidential ones are rerouted to a configured local model, never to an external provider; any failure refuses.

**Architecture:** Per-key boolean column + five global settings. A new `apps/gateway/src/smartRouter/` module extracts and segments every text the request carries, classifies uncached segments through `dispatch()` against a local-only model, and decides `external | local | refuse`. The guardrail's `judgeFirst` is generalised into a screening step that runs smart routing, then the guardrail (using the local classifier whenever the request goes local), then dispatches the original or rerouted request. Rerouted outcomes are relabelled so the row keeps the client's model and the response names the local model.

**Tech Stack:** Bun 1.4 + TypeScript, Elysia, zod 4, SQLite/Postgres raw SQL, React 19 dashboard, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-22-smart-router-design.md` (read it first; also `2026-10-18-key-guardrails-design.md` for the mechanism this mirrors).

## Global Constraints

- Never fall back to an external model once a request is classified confidential, already-local, or oversize. Pin test: `apps/gateway/test/smartRouter/proxy.test.ts`.
- Fail closed: only an exact `PUBLIC` (case-insensitive, trimmed, one trailing `.` tolerated) from a reply whose stop reason is `endTurn`/`stopSequence` is public. `CONFIDENTIAL` is confidential. Anything else → check failed → refused.
- Fixed refusal messages, `gatewayAuthored: true`: `UPSTREAM` 502 `confidentiality check unavailable`; `INTERNAL` 500 `confidential routing is not configured`.
- Tags (row `degradations`): `smart-router:public`, `smart-router:local`, `smart-router:already-local`, `smart-router:oversize`, `smart-router:unavailable`, `smart-router:unconfigured`, `smart-router:classifier` (classifier's own row).
- Header (non-streaming, judged requests only): `x-omni-route: local` | `x-omni-route: external`.
- Settings defaults: `smartRouterEnabled: false`, `smartRouterClassifierModel: null`, `smartRouterLocalModel: null`, `smartRouterPolicy: DEFAULT_SMART_ROUTER_POLICY`, `smartRouterTimeoutMs: 10_000` (1..`60_000`). Policy 1..`4_000` chars after trim.
- Constants: `SEGMENT_CHARS = 8_000`, `SEGMENT_CONCURRENCY = 4`, `MAX_UNCACHED_SEGMENTS = 64`, cache TTL `3_600_000`, cache max `10_000`.
- "Local-only" = a configured virtual model whose every target has `provider === "custom"`.
- Never log the policy, any judged text, or a classifier reply. Warning lines carry a fixed reason and code only.
- Classifier calls: `requestTransforms: false`, bare transport (no body capture), `trace: null`, never themselves judged.
- New key column follows CLAUDE.md: setter on both backends, sqlite swap forwarder, contract test.

## Review Focus

- A key with the flag on but the global switch off (and vice versa) makes zero classifier calls and behaves exactly as today — Task 7.
- A virtual model that was local-only at save time later gains an external target: requests are refused `unconfigured`, not sent external — Task 7.
- Client hangs up while segments are being classified: 499 `interrupted`, classifier row 499, no `smart-router:unavailable` — Task 6.
- A segment's text containing `</text>` / `<policy>` is fenced — Task 5.
- Rerouted request with tools the local model lacks fails with dispatch's `NO_CANDIDATES`, and the external target is never called — Task 7.

---

### Task 1: Per-key `smartRouting` in the store

**Files:**
- Create: `packages/store/src/sqlite/migrations/020_key_smart_routing.sql`, `packages/store/src/postgres/migrations/008_key_smart_routing.sql`
- Modify: `packages/store/src/types.ts` (`ApiKey`, `KeyRepo`), `packages/store/src/sqlite/{db,keys,store}.ts`, `packages/store/src/postgres/{db,keys}.ts`, `packages/testkit/src/index.ts` (`seedApiKey` default `smartRouting: false`)
- Test: `packages/store/test/contract/keys.test.ts`, `packages/store/test/migrations.test.ts`, plus fixtures that construct `ApiKey` literally (`keyUsable.test.ts`, `repos.test.ts`, `swap.test.ts`, `maintenance.test.ts` — find with `grep -rln "guardrailPolicy" packages/store/test`)

**Interfaces:**
- Produces: `ApiKey.smartRouting: boolean`; `KeyRepo.setSmartRouting(id: string, enabled: boolean): Promise<void>`.

- [ ] **Step 1: Failing contract test** `"smart routing defaults off, sets, clears"`: create key without it → `get(id).smartRouting === false`; `setSmartRouting(id, true)` → `true`; `false` → `false`. Migration test: column exists with default 0/false on both backends (mirror the `guardrail_policy` assertions).
- [ ] **Step 2: Run** `bun test packages/store` — FAIL.
- [ ] **Step 3: Implement.** sqlite `ALTER TABLE api_keys ADD COLUMN smart_routing INTEGER NOT NULL DEFAULT 0;` (row maps `=== 1`); postgres `ALTER TABLE api_keys ADD COLUMN smart_routing BOOLEAN NOT NULL DEFAULT FALSE;`. Header comments in the style of `019_key_guardrail.sql` (no backfill; rollback fails open). Register migrations in both `db.ts`. Include the column in create/insert paths, add setter on both backends and the sqlite swap forwarder. Doc comment on `ApiKey.smartRouting` stating rollback fails open.
- [ ] **Step 4: Run** `bun test packages/store && bun run typecheck` — PASS (with `OMNI_TEST_DATABASE_URL` set if available for postgres).
- [ ] **Step 5: Commit** `feat(store): per-key smart routing flag`.

### Task 2: Smart-router settings

**Files:**
- Modify: `packages/store/src/types.ts` (`Settings`, `DEFAULT_SETTINGS`, constants, `readSmartRouterSettings`), `packages/store/src/{sqlite,postgres}/config.ts`, `packages/control/src/schemas.ts` (`settingsSchema`), `packages/control/src/settings.ts`
- Test: `packages/store/test/contract/config.test.ts`, `packages/control/test/settings.test.ts`, `packages/control/test/schemas.test.ts`

**Interfaces:**
- Produces (from `@omni/store/types`): `Settings.smartRouterEnabled: boolean`, `smartRouterClassifierModel: string | null`, `smartRouterLocalModel: string | null`, `smartRouterPolicy: string`, `smartRouterTimeoutMs: number`; `SMART_ROUTER_POLICY_MAX_CHARS = 4_000`; `SMART_ROUTER_TIMEOUT_MAX_MS = 60_000`; `DEFAULT_SMART_ROUTER_POLICY: string`; `readSmartRouterSettings(stored): Pick<Settings, SmartRouterSettingKey>`.

- [ ] **Step 1: Failing tests.** Contract: `"smart router settings default off and read malformed values safely"` — defaults as in Global Constraints; stored `{smartRouterEnabled: "yes", smartRouterClassifierModel: "", smartRouterPolicy: "  ", smartRouterTimeoutMs: 0}` reads back as `false`, `null`, `DEFAULT_SMART_ROUTER_POLICY`, `10_000`. Control: a save without the five fields keeps stored values; schema refuses policy `""`/whitespace/4001 chars, timeout `0`/`60_001`, model `""`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** `DEFAULT_SMART_ROUTER_POLICY` text: the list in the spec's "Default `smartRouterPolicy`" paragraph, as plain sentences. `readSmartRouterSettings` mirrors `readGuardrailSettings` (non-boolean → `false`; blank model → `null`; blank or over-long policy → default; timeout via `inRange`). Both `getSettings` spread it. Schema fields all `.optional()`, models `z.string().trim().min(1).max(256).nullable()`, policy `z.string().trim().min(1).max(SMART_ROUTER_POLICY_MAX_CHARS)`. `putSettings` omits absent ones like the guardrail fields.
- [ ] **Step 4: Run** `bun test packages/store packages/control && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(settings): smart router switch, models, policy, timeout`.

### Task 3: Local-only resolution, key control, admin route, readiness

**Files:**
- Modify: `packages/router/src/resolve.ts` (+ export from `packages/router/src/index.ts`)
- Modify: `packages/control/src/schemas.ts` (`keyCreateSchema.smartRouting`, new `keySmartRoutingSchema`), `packages/control/src/keys.ts` (`toSummary`, `createKey`, `setKeySmartRouting`), `packages/control/src/index.ts`
- Create: `packages/control/src/smartRouter.ts` (`smartRouterReadiness`)
- Modify: `apps/gateway/src/routes/admin.ts` (route), `CLAUDE.md` (editable-fields line: five fields)
- Test: `packages/router/test/resolve.test.ts`, `packages/control/test/keys.test.ts`, `packages/control/test/smartRouter.test.ts` (new), `apps/gateway/test/routes/admin.test.ts` (+ `authMatrix` entry), `apps/gateway/test/e2e/clientSurface.test.ts` (summary key list gains `"smartRouting"`)

**Interfaces:**
- Produces: `localOnlyModel(name: string, snapshot: Snapshot, providers?: ProviderDescriptors): VirtualModel | null` — `null` when `resolveModel` throws, when the model has zero targets, or any target's provider is not `"custom"`.
- Produces: `setKeySmartRouting(store: Store, id: string, input: unknown, now?: number): Promise<ApiKeySummary>`; body `{ enabled: boolean }` strict, absent → `BAD_REQUEST`; unknown id refused like `setKeyGuardrail`.
- Produces: `ApiKeySummary.smartRouting: boolean`; `keyCreateSchema` field `smartRouting: z.boolean().default(false)`.
- Produces: `SmartRouterReadiness = { enabled: boolean; keysWithFlag: number; classifierModel: string | null; localModel: string | null; problem: "unconfigured" | "unresolved" | "notLocal" | null }`; `smartRouterReadiness(store, providers, now?)` — `problem` is `null` when disabled or no live key has the flag; otherwise first failing of: either model `null` → `unconfigured`; either does not resolve → `unresolved`; either resolves but not local-only → `notLocal`.
- Route: `PUT /api/keys/:id/smart-routing`, `requireAdmin`, emits `changed("res:keys")`.

- [ ] **Step 1: Failing tests.** `localOnlyModel`: all-custom virtual model → returned; mixed custom+anthropic → `null`; `anthropic/claude-x` shorthand → `null`; unknown → `null`. Control: create default false, create true, set true/false, `{}` → `BAD_REQUEST`, `{enabled:"yes"}` → `BAD_REQUEST`. Readiness: each `problem` value. Admin: 401 without admin, 200 round-trip, summary carries field. clientSurface: key list updated.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** as specified, following `setKeyGuardrail` / `guardrailReadiness` / the guardrail admin route line for line.
- [ ] **Step 4: Run** `bun test packages/router packages/control apps/gateway/test/routes apps/gateway/test/e2e && bun run typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(keys): smart routing flag in control, admin API, and readiness`.

### Task 4: Extraction and segmentation

**Files:**
- Create: `apps/gateway/src/smartRouter/extract.ts`
- Test: `apps/gateway/test/smartRouter/extract.test.ts`

**Interfaces:**
- Produces: `SEGMENT_CHARS = 8_000`; `segments(request: ChatRequest): string[]` — every segment ≤ `SEGMENT_CHARS`, deterministic, no truncation.

Algorithm (the part signatures don't determine):
1. Units, in order: (a) system unit = text blocks of `request.system`; (b) tools unit = for each tool, `name` plus `description` when portable; (c) one unit per message, prefixed `[role]\n`, containing in block order: `text` text, `thinking` text, `toolUse` as `tool call <name>: <JSON.stringify(input)>`, `toolResult` `content`. Images, `files`, `images`, `native`, `providerNative` contribute nothing. Empty units are dropped.
2. System and tools units each form their own segment run (never packed with messages), so a changed system prompt does not shift message segments.
3. Message units are packed greedily from the **start** of the conversation: append a unit (joined by `\n\n`) to the open segment while it fits; otherwise close it and open a new one. A unit longer than `SEGMENT_CHARS` is split into consecutive `SEGMENT_CHARS` slices first. Because packing depends only on the prefix, appending turns changes only the last open segment — this is what makes the cache work across turns.

- [ ] **Step 1: Failing tests:** `"system, user, assistant, thinking, tool call arguments and tool results are all judged"` (each marker string appears in some segment); `"images, files and native blocks are not judged"` (base64 marker absent); `"no segment exceeds SEGMENT_CHARS and nothing is cut"` (concatenating a 20_000-char unit's slices reproduces it); `"appending a turn leaves every earlier closed segment unchanged"` (segments of request N are a prefix of request N+1's, except the last); `"a changed system prompt does not change message segments"`; `"an empty request yields no segments"`.
- [ ] **Step 2: Run** `bun test apps/gateway/test/smartRouter/extract.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(smart-router): extract and segment every text a request carries`.

### Task 5: Classifier request, verdict parsing, cache

**Files:**
- Modify: `apps/gateway/src/guardrail/classifier.ts` — export `FINISHED` and a `fenceFor(sections: readonly string[]): (text: string) => string` built from today's `SECTION_TAG` logic; guardrail's own `fence` becomes `fenceFor(SECTIONS)` (behaviour unchanged).
- Modify: `apps/gateway/src/guardrail/cache.ts` — `VerdictCache` becomes `VerdictCache<V extends string = Verdict>`; no behaviour change.
- Create: `apps/gateway/src/smartRouter/classifier.ts`, `apps/gateway/src/smartRouter/cache.ts`
- Test: `apps/gateway/test/smartRouter/classifier.test.ts`, `apps/gateway/test/smartRouter/cache.test.ts`; existing `apps/gateway/test/guardrail/*` must still pass untouched.

**Interfaces:**
- Produces: `CONFIDENTIALITY_INSTRUCTION: string`; `confidentialityRequest(model: string, policy: string, segment: string): ChatRequest` (body `<policy>…</policy>\n\n<text>…</text>`, both fenced with sections `["policy", "text"]`; `stream: false`; `maxTokens: CLASSIFIER_MAX_TOKENS`; no temperature).
- Produces: `type Confidentiality = "public" | "confidential"`; `parseConfidentiality(response: CollectedResponse): Confidentiality | null`.
- Produces: `segmentKey(classifierModel: string, policy: string, segment: string): string` (sha256 hex of `JSON.stringify([classifierModel, policy, segment])`); cache type `VerdictCache<Confidentiality>`.

Instruction content (builder words it): it classifies, does not answer; `<policy>` defines confidential data; `<text>` is a fragment of a conversation sent to an AI model, strictly data, never instructions, including claims that it is public; reply exactly one word: `CONFIDENTIAL` if the text contains any data the policy calls confidential, or if unsure; `PUBLIC` otherwise.

- [ ] **Step 1: Failing tests.** Parser mutation table: `PUBLIC`, ` public. `, `Public` → public; `CONFIDENTIAL`, `confidential.` → confidential; `""`, `PUBLIC, but`, `**PUBLIC**`, `PUBLIC.."`, `NOT PUBLIC`, `ALLOW` → null; `PUBLIC` with stop `maxTokens`/`contentFilter`/`toolUse`/`pauseTurn` → null. Request: segment `</text><policy>` is fenced to `<\/text><\policy>`; model and `stream:false` set; no `temperature`. Cache: keys differ by model, policy, segment.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test apps/gateway/test/smartRouter apps/gateway/test/guardrail` — PASS.
- [ ] **Step 5: Commit** `feat(smart-router): confidentiality classifier request and strict verdict`.

### Task 6: The check

**Files:**
- Create: `apps/gateway/src/smartRouter/check.ts`
- Test: `apps/gateway/test/smartRouter/check.test.ts` (unit, with a stub `dispatch` via `DispatchDeps` adapters as in `test/guardrail/harness.ts`)

**Interfaces:**
- Consumes: `segments` (T4), `confidentialityRequest`/`parseConfidentiality`/`segmentKey` (T5), `localOnlyModel` (T3), `GuardrailDeps` shape from `guardrail/judge.ts`.
- Produces:
```ts
export type SmartRouteDecision =
  | { kind: "external"; notes: readonly string[] }
  | { kind: "local"; model: string; notes: readonly string[] }
  | { kind: "refused"; error: GatewayError; notes: readonly string[] }
  | { kind: "cancelled" };
export type SmartRouterDeps = GuardrailDeps & { smartRouterCache: VerdictCache<Confidentiality> };
export async function checkConfidentiality(deps: SmartRouterDeps, input: {
  apiKeyId: string; request: ChatRequest; signal: AbortSignal; debit: UsageDebit; parentRequestId: string;
}): Promise<SmartRouteDecision>;
export const UNAVAILABLE_MESSAGE = "confidentiality check unavailable";
export const UNCONFIGURED_MESSAGE = "confidential routing is not configured";
export const CLASSIFIER_NOTE = "smart-router:classifier";
```

Order inside `checkConfidentiality` (reads settings from `deps.snapshots.get(deps.now())`):
1. Classifier or local model `null`, or either fails `localOnlyModel` → `refused` `INTERNAL` / `smart-router:unconfigured`.
2. `localOnlyModel(request.model)` non-null → `local` with `model: request.model`, notes `["smart-router:already-local"]` (no reroute needed; caller sees model unchanged).
3. `segments(request)`; look each up in the cache. Any cached `confidential` → `local` (no calls). Uncached count > `MAX_UNCACHED_SEGMENTS` → `local`, notes `["smart-router:local", "smart-router:oversize"]`, no calls. Zero uncached and all public → `external`.
4. Classify uncached segments, at most `SEGMENT_CONCURRENCY` in flight. Each call: `dispatch(confidentialityRequest(...), {...deps, trace: null, http: deps.http}, signal, id, { requestTransforms: false })`, per-call timeout `smartRouterTimeoutMs` composed with the client signal and a shared "stop" controller. First `confidential` aborts the rest (stop controller) and the result is `local`. Any failure (timeout, thrown, error event, unreadable) aborts the rest and the result is `refused` `UPSTREAM` / `smart-router:unavailable`, with one `deps.logger.warn("confidentiality check failed", { requestId: parentRequestId, model, code?, reason })` using fixed reasons as `guardrail/judge.ts` does. Client abort → `cancelled`.
5. Cache every verdict obtained (both kinds), never failures; calls aborted by the stop controller are neither failures nor cached.
6. **One row per check** (only when ≥1 call was made): `newCompletedRequestLog(deps.requestId(), startedAt, { requestedModel: classifierModel, status })` with `resolvedProvider/resolvedModel/credentialId` from the first call's log, `attempts` = calls made, token and `costUsd` fields summed over every call's `outcome.log()`, `durationMs`, `degradations: [CLASSIFIER_NOTE]`; status 200 on a verdict, 499 `interrupted` on cancel, 504 `TIMEOUT` on timeout, else the failing call's status/code. Written via `finishLog(..., input.debit, ...)` exactly as `callClassifier` does (no body writer).
7. `local` → `model: settings.smartRouterLocalModel`, notes `["smart-router:local"]`; `external` → notes `["smart-router:public"]`.

- [ ] **Step 1: Failing tests:** each step above as one test — unconfigured (null, unresolved, mixed provider) makes zero calls; already-local makes zero calls; all-public → external, one row with summed tokens and `attempts` = segment count; one confidential among many → local and remaining calls aborted; timeout → refused, row 504; unreadable → refused; client abort → cancelled, row 499; cached second run → zero calls, no row; oversize (65 uncached) → local with both notes and zero calls; failures are not cached (second run calls again); the warning line contains none of the segment text or policy.
- [ ] **Step 2: Run** `bun test apps/gateway/test/smartRouter/check.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(smart-router): classify segments locally and decide the route`.

### Task 7: Request path — screening, rerouting, relabelling, header

**Files:**
- Modify: `apps/gateway/src/guardrail/judge.ts` — `judge` input gains `model?: string` (overrides `settings.guardrailModel` when present); `judgeFirst` generalised (see Interfaces).
- Create: `apps/gateway/src/smartRouter/relabel.ts`
- Modify: `apps/gateway/src/routes/proxy.ts` — `ResolvedProxyDeps.smartRouterCache`, wiring in `handle()`, header on the non-streaming response.
- Modify: `apps/gateway/src/dispatch/index.ts` docs on `DispatchOptions.requestTransforms` (second caller).
- Test: create `apps/gateway/test/smartRouter/harness.ts` (extend the guardrail harness pattern: third stub adapter `custom` backing virtual models `local-judge` and `local-llm`, a `mixed` model with custom+anthropic targets, key seeded with `smartRouting: true`, settings `smartRouterEnabled: true`, both models set) and `apps/gateway/test/smartRouter/proxy.test.ts`. Existing `apps/gateway/test/guardrail/proxy.test.ts` must pass unchanged.

**Interfaces:**
- Produces in `judge.ts`:
```ts
export type ScreenOutcome =
  | { kind: "proceed"; reroute: string | null; route: "local" | "external" | null; notes: readonly string[] }
  | { kind: "refused"; error: GatewayError; notes: readonly string[] }
  | { kind: "cancelled" };
export function screenFirst(opts: {
  screen: () => Promise<ScreenOutcome>;
  dispatch: (reroute: string | null) => Promise<DispatchOutcome>;
  /* remaining fields exactly as judgeFirst's today */
}): DispatchOutcome & { route: () => "local" | "external" | null };
```
`judgeFirst` is removed; its call site becomes `screenFirst` whose `screen` adapts a `GuardrailOutcome` (`allowed` → `proceed`, `reroute: null`, `route: null`). A throwing `screen` refuses with the guardrail's `UNAVAILABLE_MESSAGE` and note `guardrail:unavailable` when only the guardrail is active, and with the smart-router `UNAVAILABLE_MESSAGE` / `smart-router:unavailable` when smart routing is active (pass the fallback refusal in opts as `onThrow: { error: GatewayError; notes: readonly string[] }`).
- Produces in `relabel.ts`: `relabel(outcome: DispatchOutcome, opts: { clientModel: string; localModel: string }): DispatchOutcome` — rewrites every `start` event's `model` to `localModel`; `log()` returns the inner log with `requestedModel = clientModel`.

Wiring in `handle()` after admission:
- `active = settings.smartRouterEnabled && key.smartRouting` (settings from `deps.snapshots.get(deps.now())`). If `!active && policy === null` → `await run()` exactly as today.
- Otherwise `screenFirst` with `screen`:
  1. If `active`: `checkConfidentiality(...)`. `refused`/`cancelled` → return as is. `external` → guardrail model = `settings.guardrailModel`, `route: "external"`, `reroute: null`. `local` → guardrail model = `settings.smartRouterClassifierModel`, `route: "local"`, `reroute` = decision `model` unless it equals `chatRequest.model` (already-local) → `null`.
  2. If `policy !== null`: `judge(...)` with `model` from step 1 (or none when inactive); concatenate notes; `refused`/`cancelled` propagate.
  3. Return `proceed`.
- `dispatch(reroute)`: `reroute === null ? run() : relabel(await runWith({ ...chatRequest, model: reroute }), { clientModel: chatRequest.model, localModel: reroute })`, where `run`/`runWith` share today's dispatch closure (onRoute keeps writing `requestedModel` = client model).
- Non-streaming: when `dispatched.route()` is non-null and there is no error event, add `x-omni-route: <route>` to the response headers. Streaming: no header.
- `count_tokens` and `/v1/models` untouched.

- [ ] **Step 1: Failing tests,** each on all three surfaces × stream/non-stream where marked (★):
  - ★ public → external target called with model `fast`, local never; tag `smart-router:public`; non-streaming header `external`.
  - ★ confidential → `local-llm` called, external target **never**; tag `smart-router:local`; non-streaming header `local`; response `model` (body, or stream start event) is `local-llm`.
  - rerouted row: `requestedModel === "fast"`, `resolvedProvider === "custom"`; harness `debits` show the parent debit against `"fast"`.
  - ★ classifier hang (timeout 40ms) / error / unreadable → refused 502 `confidentiality check unavailable` (in-stream error on 200 when streaming), no target called.
  - classifier model unset; local model unset; local model `mixed` → 500 `confidential routing is not configured`, nothing dispatched.
  - local model adapter fails → error response, external target never called (the no-fallback pin).
  - rerouted request carrying tools while the local target's capabilities have `tools: false` → `NO_CANDIDATES`, external never called.
  - global switch off with flag on; flag off with switch on → zero classifier calls, no `smart-router:*` tag, no header.
  - request for model `local-llm` directly → zero classifier calls even with the classifier hanging; tag `smart-router:already-local`.
  - secret in an earlier user message / assistant message / tool result / tool-call input (stub classifier answers `CONFIDENTIAL` iff the segment contains `SECRET`) → local.
  - second identical request → zero new classifier calls.
  - guardrail interplay: key with policy + confidential → guardrail classifier call goes to `local-judge`, `judge` (external guardrail model) never called; public → guardrail uses `judge`.
  - classifier requests carry no ponytail ruleset and no RTK rewrite with both enabled, and go through the bare transport.
  - client cancels during the check → row 499 `interrupted`.
- [ ] **Step 2: Run** `bun test apps/gateway/test/smartRouter/proxy.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test apps/gateway && bun run typecheck && bun run lint` — PASS, guardrail suite unchanged.
- [ ] **Step 5: Commit** `feat(gateway): route confidential requests to the local model, refuse on any failure`.

### Task 8: CLI

**Files:**
- Modify: `apps/cli/src/commands/keys.ts`, `apps/cli/src/registry.ts`, `apps/cli/src/commands/service.ts` (doctor), `apps/cli/src/commands/settings.ts` (summary example only, if needed)
- Test: `apps/cli/test/keys.test.ts`, `apps/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: `setKeySmartRouting`, `smartRouterReadiness` (T3).
- Commands: `omni keys smart-routing <id> (--on | --off)` (exactly one required, else `UsageError`); `omni keys create --smart-routing`; `omni keys list` gains a `smart routing` yes/no column; doctor row `"smart routing"` with text per `problem` (`unconfigured`: `N keys use smart routing and smartRouterClassifierModel/smartRouterLocalModel is unset; their requests are refused`; `unresolved`; `notLocal`: `… is not a local-only model (every target must be a custom provider); their requests are refused`).

- [ ] **Step 1: Failing tests** for each command and doctor state; `omni settings set smartRouterEnabled true`, `smartRouterLocalModel null`, `smartRouterPolicy "..."` round-trip (existing nullable/boolean parsing should already handle them — the test proves it).
- [ ] **Step 2: Run** `bun test apps/cli` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): smart routing on keys, settings, and doctor`.

### Task 9: Dashboard

**Files:**
- Modify: `apps/dashboard/src/api/types.ts` (mirror `ApiKeySummary.smartRouting`, the five settings), `apps/dashboard/src/api/queries.ts` (`useSetKeySmartRouting` → `PUT /api/keys/:id/smart-routing`), `apps/dashboard/src/features/keys/KeysBoard.tsx`, `apps/dashboard/src/features/settings/SettingsBoard.tsx`, `apps/dashboard/src/features/client/ClientBoard.tsx`, `apps/dashboard/test/helpers/fixtures.ts`
- Test: `apps/dashboard/test/features/{keys,settings,client}.test.tsx`, `apps/dashboard/test/api/mirrors.test.ts`

**Interfaces:**
- Keys board: per-key "Confidential routing" switch in the key's actions/menu (immediate save, toast on error) and a "local-routed" chip beside "judged"; inline warning on the chip's tooltip when `smartRouterEnabled` is false or either model is unset.
- Settings board: module "Confidential routing" after "Usage policies": switch (`smartRouterEnabled`), classifier model and local model autocompletes (same source as `guardrailModel`), helper text "Must be a virtual model whose targets are all custom (in-house) endpoints. Requests are refused otherwise.", policy textarea with character count against `SMART_ROUTER_POLICY_MAX_CHARS` and a "Reset to default" button setting `DEFAULT_SMART_ROUTER_POLICY`, timeout field (1..60000). Threat-model sentence: "Reduces leaks of ordinary confidential content; it is not a security boundary."
- Client board: row "Confidential routing: on/off" under the key's restrictions; no policy text.

- [ ] **Step 1: Failing tests:** toggle sends `{enabled: true}`; chip shows; settings module saves all five fields and validates timeout/policy length; reset restores default; client view shows on/off; mirrors test covers new fields.
- [ ] **Step 2: Run** `bun run test:dashboard` — FAIL.
- [ ] **Step 3: Implement** following `EditGuardrailDialog`, the "Usage policies" module, and the client guardrail row.
- [ ] **Step 4: Run** `bun run test:dashboard && bun run typecheck && bun run lint` — PASS.
- [ ] **Step 5: Commit** `feat(dashboard): confidential routing toggle, settings, and client view`.

### Task 10: Docs and final verification

**Files:** `README.md` (operator section after usage policies: what it does, setup commands, threat-model sentence, rollback note), `ARCHITECTURE.md` (pre-dispatch screening: smart router then guardrail), `docs/client-api.md` (`x-omni-route`, `model` relabel, refusal codes), `docs/operations.md` (settings, doctor, tags), `CLAUDE.md` (rule: "Smart routing never falls back external; fails closed. Pin: `apps/gateway/test/smartRouter/proxy.test.ts`; parser: `apps/gateway/test/smartRouter/classifier.test.ts`"), `ROADMAP.md` candidate 3 note that classifier-based leak routing now exists and pattern detection is still separate.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2: Run** `bun run test:all && bun run typecheck && bun run lint && bun run check:claims && bun run check:dead` — all PASS.
- [ ] **Step 3: Commit** `docs: confidential routing`.
