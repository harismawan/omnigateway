# Qoder Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add account-authenticated Qoder inference and a server-derived model picker without a CLI runtime dependency.

**Architecture:** Provider-local cryptography, OAuth generators and codec describe upstream requests;
the existing host performs HTTP, polling, refresh and dispatch. A versioned encrypted accessToken
bundle contains runtime auth fields and current inference metadata. Public normalized model metadata
is persisted separately and merged by control into the dashboard catalog, without global mutation.

**Tech Stack:** Bun 1.4.4, strict TypeScript, node:crypto, existing HttpClient/codec/OAuth infrastructure.

**Spec:** `docs/superpowers/specs/2026-11-04-qoder-provider-design.md`

## Global Constraints

- Use Bun/TypeScript and built-in `node:crypto`; add no runtime dependencies or WASM.
- All upstream HTTP goes through the existing described-request/HttpClient seams.
- Provider code remains under `packages/providers/src/qoder/`; no Qoder-id branch in core.
- Static catalog contains no invented model IDs, prices or limits. No model-name prefixes.
- Automated tests use synthetic credentials and stub transport, never live provider calls.
- Never store tokens, symmetric keys or encrypted authentication envelopes in `providerData`.
- No database migration, real machine identity, local credential import or binary subprocess.
- Preserve existing user-owned untracked design documents; do not stage unrelated files.

## Review Focus

1. Refreshed secret bundle must drive the immediately retried request even with old providerData (Task 3/4).
2. Reconnecting must retain the same machine identity in authorization URL and saved bundle (Task 2/3).
3. Malformed catalog data, hostile origins and missing prices must not fabricate routing facts (Task 3/5).
4. SSE quota/error/truncation before and after output must not become successful empty completions (Task 4).
5. Account APIs, logs and /api/catalog must never disclose raw token or runtime auth envelope (Task 3/5).

---

### Task 1: Finish protocol facts and implement native protocol helpers

**Files:** Create `packages/providers/src/qoder/{crypto,protocol,endpoint}.ts`;
test `packages/providers/test/qoderProtocol.test.ts` and synthetic fixtures under
`packages/providers/test/fixtures/qoder/`.

**Interfaces:** Export `encodeBody(plain: string): string`, `decodeBody(encoded: string): string`,
`encryptAuth(userJson: string, key: string): {encryptUserInfo: string; key: string}`,
`signAuth(input: {authBase64: string; key: string; date: string; body: string; path: string}): string`,
`trustedInferenceOrigin(value: unknown): string | null`. Protocol types define version-1 secret
bundle and public vendor model record; no store/runtime dependency in types.

- [ ] Inspect `/tmp/opencode/qoder/FINDINGS.md` and public npm CLI 1.1.82; document exact endpoint
  election request/response, model-list response decoding and session defaults. Extract only public
  RSA key and synthetic fixtures. If these facts cannot be established, stop with a named blocker.
- [ ] Write failing tests: `encodeBody("abc") === "MSK#"`, `encodeBody("{}") === "$kwm"`,
  empty/Unicode/padding round trips; fixed synthetic signing vector with no `/algo` or query;
  AES/RSA algorithm checks; allowed exact origins and rejected HTTP/userinfo/ports/host suffixes.
  Encode/decode model-list fixtures using the discovered format, rejecting corrupt data.
- [ ] Run `bun test packages/providers/test/qoderProtocol.test.ts`; confirm missing exports fail.
- [ ] Implement helpers from verified formulas, fixture expected values independent of production helpers.
  Match RSA PKCS#1 v1.5 wrapping, AES-128-CBC IV=key and PKCS#7. Restrict wrapping key to public PEM.
  Keep generic signing input usable by model-list and inference, without exposing secrets in errors.
- [ ] Run focused tests; mutation-check alphabet, swapped thirds, signing path and hostile-origin guard.
- [ ] Commit only Task 1 files after verification, when commits are authorized by the execution workflow.

### Task 2: Pass reconnect identity to device-flow authorization

**Files:** Modify `packages/providers/src/oauthFlow.ts`, `packages/control/src/oauth/{types,pluginFlow}.ts`,
`packages/control/src/connect.ts`; tests `packages/control/test/{connect.test.ts,oauth/pluginFlow.test.ts}`.

**Interfaces:** Extend `DevicePluginFlow.begin` and `DeviceOAuthProvider.begin` input with
`providerData?: Record<string, unknown>`. `createConnectFlows.start()` retains validated reconnect
metadata and passes it to begin; existing flow result/exchange/refresh signatures unchanged.

- [ ] Write failing sentinel-provider tests asserting initial begin has no prior metadata; reconnect
  begin and exchange see the same original synthetic identity; another provider's row is refused
  before authorization. Exercise oauthAdapter forwarding, not only a direct stub call.
- [ ] Run `bun test packages/control/test/connect.test.ts packages/control/test/oauth/pluginFlow.test.ts`.
- [ ] Add optional field and thread validated metadata through host and adapter. Do not put provider
  names or synthetic-identity generation in core; no changes to other flows' behavior.
- [ ] Re-run tests and `bun run typecheck`; mutation-check dropping begin metadata fails the sentinel.
- [ ] Commit verified Task 2 files under the execution workflow.

### Task 3: Qoder device login, refresh, discovery and safe credential bundle

**Files:** Create `packages/providers/src/qoder/{oauth,device,credential,profile,modelCatalog}.ts`;
test `packages/control/test/oauth/qoder.test.ts` and `packages/providers/test/qoderCatalog.test.ts`.

**Interfaces:** Export `qoderOAuthFlow: DevicePluginFlow`, `qoderProfile: ClientProfile`,
`qoderBodyOrder: readonly string[]`, `parseCredential(value: string): QoderCredentialBundle`,
`parseModelCatalog(value: unknown): QoderModel[]`. Bundle version=1 contains raw device token,
runtime auth envelope, trusted inference origin and required model metadata; public catalog
projection contains no token, auth headers, api_key or untrusted model URLs.

- [ ] Write failing generator/adapter tests for PKCE URL/client ID, UUID nonce, machine retention,
  404 pending, one-second polling, five-minute expiry, token/userinfo validation, absolute/relative
  expiry, refresh rotation/omission, 401/403 vs 429/5xx, endpoint/model discovery via stub HTTP.
  Assert stored accessToken parses as the bundle, apiKey/idToken null, providerData contains no secrets.
  Assert refresh returns new bundle origin/model facts while prior providerData stays immutable.
- [ ] Run `bun test packages/control/test/oauth/qoder.test.ts packages/providers/test/qoderCatalog.test.ts`.
- [ ] Implement OAuth with described requests using `getJsonRequest`/`postJsonRequest`; preserve
  identity from pending authorization. Use helper randomState for nonce and synthetic identity;
  create randomized crypto only at login/refresh. Set unknown quota by omitting usage.
  Validate model records and cap public rows/strings; skip disabled records, reject malformed roots;
  only retain a last-good model snapshot for transient refresh discovery failure. Do not swallow
  authentication rejection as a valid empty catalog. Version profile through `OMNI_QODER_CLI_VERSION`.
- [ ] Run focused tests; check bundle through a real in-memory store's `openForInference()` to prove
  no OAuth apiKey-column dependence. Exercise refresh through host CAS and reconnect end to end.
- [ ] Commit verified Task 3 files under the execution workflow.

### Task 4: Encode Qoder chat, decode SSE, register built-in provider

**Files:** Create `packages/providers/src/qoder/{wire,decode,codec,index,descriptor,models}.ts`;
modify `packages/providers/src/{descriptors,registry,profile,body,catalog,builtinOAuth}.ts`;
test `packages/providers/test/qoder.test.ts`, registration literals named in `docs/adding-a-provider.md`,
`apps/gateway/test/routes/qoder.test.ts`; update `packages/dashboard-sdk/src/theme.ts` and its palette tests.

**Interfaces:** Export `qoderCodec: ProviderCodec`, `qoderDescriptor: ProviderDescriptor`,
`QODER_MODELS: ProviderModelCatalogEntry` (models=[], defaultModel="", authTypes=["oauth"]).
Adapter joins codec+descriptor via codecAdapter. `toQoderWire` consumes CodecInput plus parsed bundle;
decoder emits canonical StreamEvents using the host's fail constructor.

- [ ] Write failing tests pinning exact encoded endpoint/header/signature/body, deterministic same-input
  builds, missing/malformed bundle, fresh bundle vs stale providerData, requestStartedAt timestamp,
  session continuity, portable tools and mixed system/history placement. Freeze IR to detect mutation.
  Pin deterministic fallback IDs as UUID-shaped SHA-256-derived values from request content+machineId;
  fallback date uses stored bundle issue time, never a codec clock.
- [ ] Add direct/enveloped split-chunk SSE fixtures: text, reasoning, interleaved tools, usage/cache,
  notifications, DONE, quota, business errors, malformed/truncated streams, usage-only terminal frame.
  Gateway fixtures exercise streaming and collected responses, including failure after first output.
- [ ] Run focused tests; confirm missing adapter/exports fail before implementation.
- [ ] Implement wire, decoder and codec using own provider-local forks where needed. Always ask SSE;
  report unsupported features as degradations; classify errors without leaking body/auth. Use bundle
  model facts, not invented model defaults. Keep generic transport/retry ownership unchanged.
- [ ] Register all five provider tables and OAuth seed; append Qoder before custom display and after muse
  OAuth order; update literal assertions rather than weakening coverage. Add SDK palette variable with
  required published-package version/range updates per repository rules.
- [ ] Run `bun test packages/providers/test packages/control/test/oauth/qoder.test.ts apps/gateway/test/routes/qoder.test.ts`.
  Run leaf browser checks and profile override boot test. Mutation-check URL, tool ID, system placement,
  usage arithmetic and fresh-bundle selection, restoring only mutations made for these checks.
- [ ] Commit verified Task 4 files under the execution workflow.

### Task 5: Surface normalized account catalogs and document verification limits

**Files:** Modify `packages/control/src/catalog.ts`, `apps/gateway/src/routes/admin.ts`,
`apps/dashboard/src/api/{types,queries}.ts`, `apps/dashboard/src/features/models/draft.ts`,
`apps/dashboard/src/features/models/TargetEditor.tsx`; create
`packages/providers/src/accountCatalog.ts`, export from `packages/providers/src/index.ts`;
tests `packages/control/test/catalog.test.ts`, `apps/gateway/test/routes/admin.test.ts`,
`apps/dashboard/test/features/models.test.tsx`;
modify `README.md`, `ARCHITECTURE.md`, create `docs/qoder.md`.

**Interfaces:** Add `PublicModelCatalog` normalized type and `parsePublicModelCatalog(value: unknown)`
in `packages/providers/src/accountCatalog.ts`, exported by providers; Qoder emits this shape as providerData.modelCatalog.
Extend `providerCatalog(report, providers, accounts?)` with optional structural account snapshots;
CatalogModel pricing becomes `ProviderModelPricing | null`, limits partial positive integers.
Dashboard mirrors the wire without importing providers; null prices never overwrite price draft fields.

- [ ] Write failing tests for normalized catalog rows, deduplication/order, conservative account limits,
  no static descriptor mutation, null pricing, absent limits, invalid snapshots and secret-looking extra
  fields projected away. GET /api/catalog loads metadata only (no secret decrypt or upstream call).
  Pin refresh/removal/connect invalidation and ensure manual model entry remains usable with no snapshot.
- [ ] Run focused control/gateway/dashboard tests before implementation.
- [ ] Implement normalized projection and metadata-only store read at request time, preserving static
  defaults and operator-saved targets. Merge by provider generically; preserve static entries by ID,
  sort dynamic IDs, take minimum known positive limit across matching account rows and mark a limit
  unknown if any matching row lacks it. Dynamic pricing null unless explicitly supplied and validated.
  Validate at most 500 models/account, IDs/labels up to 200 printable characters; no arbitrary URL fields.
  Do not make the pure static catalog nullable or mutate registry entries. Update all catalog wire
  consumers/type pins and query invalidation; show "Price unavailable" for null pricing.
- [ ] Document login/setup/model choice, pricing vs subscription credits, unknown quota, freshness,
  profile override, native implementation and UMID/live-verification caveats. Update architectural
  explanation and provider procedure for normalized account catalogs; add CLAUDE invariant only if needed.
- [ ] Run focused suites, `bun run test:all`, `bun run typecheck`, `bun run lint`,
  `bun run check:claims`, `bun run check:dead`. Report skipped Redis/Postgres coverage explicitly.
- [ ] If user supplies test-account access, separately verify actual device login, refresh, model-list,
  text/tool stream and collection. Otherwise explicitly label live compatibility unverified; do not
  install CLI or inspect local credentials. UMID enforcement is a release blocker if observed.
- [ ] Review whole diff, preserve unrelated files, commit verified Task 5 files under execution workflow.

## Plan self-review

- All approved scope mapped to Tasks 1–5; PAT/quota/China/binary execution excluded explicitly.
- Reviewer found three host-boundary issues: encrypted OAuth apiKey unavailable to inference,
  reconnect identity unavailable at begin, and stale metadata after refresh. Bundle-in-accessToken
  plus additive begin metadata resolves these without store or dispatch schema changes.
- Test task ownership matches the five Review Focus inputs above.
- Outstanding protocol facts are an explicit first-task gate, not guessed implementation constants.
- This plan does not claim live provider compatibility or authorize unrelated work.
