# Qoder provider

## Approved intent

Add Qoder as a built-in provider, based on the public Qoder CLI, without requiring
the CLI binary at runtime. The user approved account login, a server-derived model
catalog, text/tool streaming, tests and documentation. Both existing client surfaces
and non-streaming collection continue to use the normal dispatch pipeline.

## Scope and constraints

- Initial authentication: Qoder global browser device flow with PKCE and token refresh.
- No PAT, service-account, China-region, voice, image generation or autonomous CLI tools.
- Use Bun/TypeScript and built-in `node:crypto`; add no runtime dependencies or WASM.
- All upstream HTTP goes through the existing described-request/HttpClient seams.
- Provider code remains under `packages/providers/src/qoder/`; no Qoder-id branch in core.
- Static catalog contains no invented model IDs, prices or limits. No model-name prefixes.
- Quota visibility stays unknown until a quota response is understood; omit `usage` initially.
- Do not read local Qoder credentials, hostname or machine identity. Mint a synthetic identity
  at connect time and retain it across refresh/reconnect.
- Automated tests use synthetic credentials and stub transport, never live provider calls.
- Never store tokens, symmetric keys or encrypted authentication envelopes in `providerData`:
  it is exposed by credential APIs. Use encrypted credential secret columns.

## Evidence and confidence

Reconnaissance used public npm `@qoder-ai/qodercli` **1.1.82**. Extracted the embedded
298606-byte auth WASM solely for local protocol experiments; do not vendor the bundle.
106 input comparisons confirmed a native JS body encoder and MD5 signature against WASM.
An instrumented, in-memory test-key replacement confirmed AES-128-CBC (IV equals key,
PKCS#7) and RSA PKCS#1 v1.5 wrapping. These are compatibility requirements, not a new
cryptographic design. Only the public wrapping key belongs in production source.

### Additional static protocol checks

The response decoder is the inverse body encoding above, including UTF-8; the CLI
falls back to parsing the original plaintext on decoder failure. A synthetic
`assistant` catalog fixture is checked independently against the original WASM.
Model-list auth signing excludes `/algo` and query; GET has an empty signing body.
The decoded root is an object keyed by scene, with `assistant` the normal default.

Endpoint discovery uses GET `/algo/api/v5/service/region/endpoints`, raw bearer,
`x-gw-user-id` and machine-identity headers; V5 `inferNodes` contain `{url,type}`.
On HTTP 401/403 the CLI falls back to GET `/algo/api/v3/service/region/endpoints`;
V3 `inferNodes` are URL strings. The fallback is anonymous: `Appcode: cosy`, UTC
`Date`, and `Signature = md5("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&" + Date)`.
This is a public client constant, not an account secret. The MD5 input was captured
from instrumented WASM using synthetic identity. No endpoint is trusted merely
because it appears in either response. Session type defaults to `qodercli` and
task ID to `common` for this integration's supported global account flow.

Live login, refresh, model listing and inference are **not verified**. Endpoint selection,
model-list response decoding, and server enforcement of UMID remain implementation gates.
Do not claim a working live provider from mocked tests. If authenticated requests demand
an unavailable UMID token, report the blocker; do not invent a successful fallback or launch
the CLI behind the scenes. Research scripts currently live in `/tmp/opencode/qoder/`;
durable fixtures must be self-contained, synthetic, and copied into the tests.

## Authentication

Website `https://qoder.com`, OpenAPI `https://openapi.qoder.sh`.
Authorize at `/device/selectAccounts` with `challenge`, `challenge_method=S256`, UUID
`nonce`, synthetic `machine_id`, production public client ID
`e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb` and optional machine token only when legitimately available.
Poll GET `/api/v1/deviceToken/poll?nonce=...&verifier=...&challenge_method=S256`.
404 means pending; one-second interval; five-minute provider deadline enforced from
pending metadata even though the host's generic flow TTL is longer.

Use existing `DevicePluginFlow` and helpers; keep PKCE verifier and nonce in PendingFlow.
`begin` creates the actual flow URL. Add optional `providerData` to the generic host/flow
`begin` input and thread only the validated same-provider reconnect metadata from connect
through oauthAdapter. Other flows ignore the additive field. `start` is side-effect-free and remains compatible
with the host's device-flow lifecycle. Derive UUID-format nonce from helper-provided random
state, not from a clock. Persist synthetic identity in providerData; retain it on reconnect.

Successful poll returns `token`, `user_id`, `user_name`, optional `refresh_token` and
absolute/relative expiry fields. Fetch `/api/v1/userinfo` using the token to obtain account
email and organization metadata. Required identity/token fields must be validated.
POST `/api/v1/deviceToken/refresh` with `refresh_token` and stable `machine_id`; read
`device_token`, rotation and expiries. Retain old refresh token when rotation is omitted.
Only real credential repudiation is AUTH; 429 and server/network failures are transient.

Create runtime auth user JSON from `uid`, `security_oauth_token`, optional organization
metadata and data policy. Encrypt it using a fresh 16-character random hex AES key;
RSA-wrap that key with the client's public key. Persist `{encryptUserInfo,key}` serialized
along with raw device token and validated inference origin in encrypted `secrets.accessToken`
(a versioned JSON credential bundle); keep `secrets.apiKey` null and persist refresh token
in `secrets.refreshToken`. The Qoder codec parses the accessToken bundle, not a bearer token.
This respects the store's OAuth-only accessToken inference boundary without widening it.
Rebuild the bundle on refresh, including newly selected origin and model metadata needed
to encode that same attempt, so dispatch's pre-refresh providerData snapshot cannot cause
an origin/model mismatch. This makes
the synchronous codec deterministic and avoids randomized RSA encryption on every build.
`providerData` holds only account metadata, synthetic identity and validated model metadata.

## Inference

Model-list/endpoint discovery at connect and refresh resolves a trusted inference origin.
Accept HTTPS exact Qoder inference origins only (initial candidates `api1.qoder.sh`,
`api2.qoder.sh`, `api3.qoder.sh`); reject userinfo, arbitrary ports, path/query/hash or hostile
suffixes. Discovery shapes must be established from CLI code before implementing the parser.
No HTTP in codec.buildRequest. Persist validated origin and inference model metadata in
the encrypted bundle, and only normalized public catalog metadata in providerData. The
bundle is authoritative for inference, not a potentially pre-refresh metadata snapshot.

POST `/algo/api/v2/service/pro/sse/agent_chat_generation` with query
`FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`.
The encoded JSON envelope carries request/chat/session identifiers, stream true,
`chat_task: FREE_INPUT`, `is_reply: true`, `is_retry: false`, `source: 1`, `version: "3"`,
`agent_id: agent_common`, `aliyun_user_type: ""`, chat_context, session_type qodercli,
task_id common, system, messages, tools, parameters and model_config.
Map IR history without moving mid-conversation system turns. Preserve portable tool
IDs/names/results, reasoning and usage. Report unsupported cache/file/schema features
using Qoder-namespaced degradations rather than silently dropping them. Fork other
providers' encoders/decoders locally where useful, never import their directories.

Body encoding: standard UTF-8 base64 with alphabet
`_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!`, padding `$`;
swap first and last floor(encoded-length / 3) characters, keeping middle unchanged.
Authorization is `Bearer COSY.<base64 auth JSON>.<MD5 hex>`; hash newline-joined
base64 auth JSON, wrapped key, Unix timestamp seconds, encoded body and path
`/api/v2/service/pro/sse/agent_chat_generation` (no `/algo` or query).
Auth JSON fields: version v1, UUID requestId, info encryptUserInfo, cosyVersion, ideVersion "".
Use requestStartedAt and requestId supplied to codec; deterministic documented fallbacks
when absent, with no clock/randomness in buildRequest. CLI profile version override
`OMNI_QODER_CLI_VERSION`, default `1.1.82`; mark profile constructed from shipped code,
not captured network traffic. No real device headers or hostname.

Decode direct OpenAI-like SSE and `{statusCodeValue,body}` envelopes. Handle DONE,
notification records and NOT_EXCEED_QUOTA as control frames. EXCEED_QUOTA must not be
treated as success; map to an existing retryable quota/rate error. Reject malformed JSON,
business-error payloads and truncated streams visibly. Keep usage uncached/cache-read
arithmetic disjoint. Tests pin error behavior before and after first output.

## Account-derived catalog (builder's integration choice)

The repository has only static provider catalogs. Add one narrow, provider-neutral
convention: `providerData.modelCatalog` contains normalized **public model metadata**.
Qoder's OAuth module owns vendor parsing. Core only validates and merges normalized rows;
no provider hooks with HTTP, global registry mutation, migration or new scheduler.

Read server models at login/refresh, not on inference or on GET /api/catalog. Preserve a
last-good snapshot on a transient catalog failure during refresh. A failed first listing
must not silently fabricate models: report listing unavailable and keep manual model entry
possible. A valid empty catalog is distinct from a malformed response.

`/api/catalog` merges snapshots at request time into existing provider entries. Deduplicate
by id, deterministic ordering, conservative limits across accounts; retain static entries
where present. Unknown pricing is `null` on the control/dashboard wire, not zero; limits
contain only known positive figures. Dynamic values cannot overwrite saved target prices
or limits. Dashboard picker exposes server model names and leaves operator price inputs
alone for null pricing; refresh catalog after connect, refresh and removal using existing
credential-change invalidation. Account-specific availability does not expand routing:
operators can pin an account using the existing mechanism. No capability/price invention.

## Registration, documentation and verification

Register descriptor/adapter/profile/body order/static empty catalog/OAuth flow; append
Qoder before custom for display and after muse in OAuth seed order. Set OAuth-only auth
types, label Qoder, empty prefixes, tools/images/reasoning capabilities per CLI wire support.
Use a readable Qoder purple in both themes; exact palette values are a builder choice.
Update SDK palette and affected literal coverage assertions, with published-package version
rules respected. No database migration is needed.

Document connect/setup, manually configured targets, dynamic catalog freshness, unpriced
credit billing, unknown quota, version override, unverified-live status and UMID limitation.
Run focused tests plus CI commands: `bun run test:all`, `bun run typecheck`, `bun run lint`,
`bun run check:claims`, `bun run check:dead`; report unavailable Redis/Postgres coverage.
Mutation-check URL, signing path, token rotation, system placement and tool correlation.

## Remaining builder decisions

Exact file-local helper decomposition, presentation hue, fixture arrangement and safe
catalog row caps are builder decisions. Transport-protocol facts are not guesses: finish
the outstanding static analysis or report the blocker before representing them as supported.
