# Custom OpenAI-Compatible Provider Design

## Goal

Let operators connect API-key-authenticated OpenAI-compatible servers at custom origins, route
virtual-model targets to a chosen endpoint, and use either Chat Completions or Responses wire
protocols. Configuration must work through both dashboard and CLI while preserving existing secret,
routing, transport, and stream-commit boundaries.

## Scope

This feature adds one built-in provider identity, `custom`, presented to operators as **OpenAI
Compatible**. Each custom credential embeds endpoint metadata. Targets bind to an endpoint ID so
routing can fail over among multiple API keys for the same endpoint without crossing into another
server.

Included:

- API-key credentials for custom OpenAI-compatible servers
- HTTP and HTTPS server URLs, optionally carrying a base path
- Per-endpoint selection of Chat Completions or Responses protocol
- Dashboard and CLI credential creation
- Custom endpoint selection in virtual-model targets
- Manual model IDs, prices, limits, and capabilities
- Multiple credentials per endpoint for routing and failover

Not included:

- Upstream model discovery
- Endpoint connectivity checks during creation
- OAuth, custom authentication headers, or query-string authentication
- Automatic protocol detection or fallback
- Custom-provider quota probing
- Mutable endpoint metadata
- A separate endpoint-profile persistence entity

## Provider and Endpoint Identity

`ProviderId` gains the closed value `custom`. This keeps provider identity exhaustive across IR,
routing, persistence, dispatch, usage, CLI, and dashboard instead of allowing arbitrary strings.
Operator-defined server identity is represented separately by an endpoint ID.

Each custom API-key credential stores this non-secret `providerData` shape:

```ts
interface CustomProviderData {
  endpointId: string;
  endpointLabel: string;
  origin: string;
  basePath: string; // "" for a bare origin
  protocol: "chat_completions" | "responses";
}
```

The API key remains in the existing encrypted credential secret field. Credential projections may
include endpoint metadata, but never include the API key.

Multiple custom credentials may share an endpoint ID. All credentials sharing an endpoint ID must
have identical normalized endpoint label, origin, base path, and protocol. Credential creation rejects a
conflict rather than allowing configuration drift.

Custom targets add a required endpoint ID:

```ts
interface CustomTarget {
  provider: "custom";
  endpointId: string;
  model: string;
  // Existing target routing, price, limit, and capability fields remain unchanged.
}
```

Built-in Anthropic, OpenAI, and Kimi targets do not gain endpoint binding fields.

## Origin Validation and Request URLs

Operators provide a server URL — an origin, optionally carrying a base path. The base path exists so
reverse-proxied servers routinely served at a subpath (`https://example.com/api`) are expressible; it
is still not an API prefix or full inference endpoint. Accepted values:

- `http://host[:port][/base-path]`
- `https://host[:port][/base-path]`

Validation parses the value as a URL and requires:

- scheme is `http:` or `https:`
- hostname is present
- username and password are absent
- query and fragment are absent

Normalization splits the value into the serialized URL origin and a base path with trailing slashes
removed (`/` collapses to empty). The WHATWG parser has already resolved dot segments, so no further
path rewriting happens; paths stay case-sensitive as given. HTTP remains supported for localhost,
LAN, and self-hosted inference servers. This setting can send prompts and API keys over plaintext
transport, so dashboard and CLI must visibly distinguish HTTP from HTTPS without blocking it.

Rows written before base paths were accepted carry no `basePath` key; readers default it to empty.

The selected protocol determines the request URL. The adapter joins the stored base onto `/v1/<suffix>`
unless the stored base already ends in `/v1` (the OpenAI-SDK habit), which would otherwise double:

- Chat Completions: `<base>/chat/completions`, where `<base>` is `${origin}${basePath}` plus `/v1`
  unless already `/v1`-suffixed
- Responses: same join with `/responses`

A bare-origin row therefore targets `${origin}/v1/chat/completions` exactly as before this rule.
The gateway never probes alternate paths beyond this single deterministic join.

## Control and Store Boundaries

`packages/control` owns endpoint metadata parsing, normalization, validation, and conflict checks.
Gateway handlers and CLI commands adapt their inputs to the same control operation.

Creating a custom credential:

1. Validate provider is `custom` and API key is non-blank.
2. Validate and normalize endpoint ID, label, origin, and protocol.
3. Load existing custom credential projections with the same endpoint ID.
4. Reject the operation if any normalized endpoint metadata differs.
5. Store the new enabled API-key credential with encrypted key and normalized `providerData`.
6. Return a secret-free credential projection.

The existing credential table and JSON `provider_data` column are sufficient. No endpoint table or
migration is required solely for profile storage. Store code continues to expose routing metadata
without decrypting secrets and opens only the selected API key during an inference attempt.

Endpoint metadata is immutable. Credential patch operations continue to change only supported
credential controls such as label, enabled state, tier, and weight; they do not mutate endpoint ID,
endpoint label, origin, or protocol. To change endpoint configuration, an operator creates a new
endpoint ID, adds credentials, retargets models, then deletes old credentials.

Deleting the last credential for an endpoint does not delete or rewrite targets. Such targets remain
valid configuration but produce no routing candidates until a matching credential exists. This
matches existing behavior when a provider has no eligible credentials.

## Routing and Dispatch

The router remains pure. For built-in providers, it keeps matching targets to eligible credentials
by provider. For `custom`, it additionally requires:

```text
target.endpointId == credential.providerData.endpointId
```

This permits tier, weight, health, quota-state, and failover behavior among credentials for one
endpoint while preventing cross-endpoint routing. A model name existing on two servers does not make
the servers interchangeable.

Dispatch continues to select adapters by the closed provider ID. It passes the selected custom
credential's API key and `providerData` to the custom adapter through the existing adapter request.
Retries, deadlines, cancellation, usage recording, pre-commit failover, and post-commit terminal
stream behavior remain dispatch responsibilities.

Pre-commit failover may choose another eligible credential sharing the target endpoint ID. It must
never fail over to a credential for another endpoint. Once output is committed, stream failure stays
terminal as it is for built-in providers.

Concrete unconfigured model resolution does not synthesize custom targets. Operators must create a
saved virtual-model target because endpoint ID, price, limits, and capabilities cannot be inferred
from a bare model name.

## Custom Provider Adapter

`packages/providers` adds a generic OpenAI-compatible adapter. It uses only injected `HttpClient` and
never calls production `fetch` directly.

For every request it sends:

- `Authorization: Bearer <api-key>`
- `Content-Type: application/json`

It always requests an upstream stream. Gateway ingress may still render that canonical event stream
as streaming or non-streaming client output.

The adapter selects one codec from credential protocol metadata:

### Chat Completions

Use a generic OpenAI Chat Completions encoder and SSE decoder. Reusable wire logic may be extracted
from the current Kimi implementation, but the custom path must not send Kimi device headers,
fingerprint data, or Kimi-specific authentication behavior. Upstream reasoning deltas — whichever
of `reasoning`, `reasoning_content`, or `reasoning_details` the server emits — decode into unsigned
canonical thinking events, mirroring what the Responses decoder reports for summaries; a signature
is never claimed over a request this server did not sign.

### Responses

Own a trimmed fork of the OpenAI Responses request encoder and stream decoder, as the boundary rule
requires — no adapter imports another provider's directory. The fork drops everything
OpenAI-specific: no OAuth, no Codex endpoint, no OAuth-specific parameter behavior.

Protocol selection is explicit and stable per endpoint ID. A malformed or unsupported response
fails visibly. The gateway does not retry the same request with the other protocol.

The client's thinking level crosses verbatim on both protocols: an explicit adaptive effort lands
on the wire unchanged (`reasoning_effort` for Chat Completions, `reasoning.effort` for Responses),
including levels the big-two surfaces would clamp, because a custom server answers for its own
model vocabulary. Nothing is fabricated: an absent config and an explicit opt-out stay off the
body, and a token budget, which neither surface can express, is recorded as
`custom:reasoning-budget-dropped` rather than mapped onto an invented effort. An adaptive request
without an effort asks for `medium`. A `vendor.openai` field the client set explicitly keeps
precedence over the derived one.

Anthropic-native tool definitions and `anthropicNative` history blocks continue to exclude
OpenAI-style providers, including `custom`, during routing. Custom target capabilities are
operator-entered claims; the gateway does not validate request-shape support against the selected
model before dispatch.

## Dashboard Flow

The account connection dialog gains an **OpenAI Compatible** path with fields for:

- endpoint ID
- endpoint label
- server URL (origin with optional base path)
- protocol: Chat Completions or Responses
- API key

Submitting the form calls an authenticated admin credential-creation route backed by
`packages/control`. The API key is held only for submission, cleared after completion, and never
returned by the API or retained in query state.

To add another key for an existing endpoint, the dialog allows selection of endpoint metadata found
on existing custom credential projections. It reuses endpoint ID, label, normalized origin, and
protocol while accepting a new API key. The backend still performs the authoritative conflict
check.

The model target editor presents `custom` as **OpenAI Compatible**. Selecting it requires choosing an
endpoint ID grouped and labeled by existing custom credential metadata. Model ID, prices, context
window, output limit, and capabilities remain manually editable through existing target controls.
There is no custom-provider catalog or `/v1/models` discovery.

HTTP origins remain allowed, but the form displays a plaintext-transport warning before submission.
This warning does not expose or persist the API key.

## CLI Flow

CLI supports complete custom credential creation:

```text
omni credentials add-key custom \
  --endpoint-id local-vllm \
  --endpoint-label "Local vLLM" \
  --origin http://localhost:8000 \
  --protocol chat-completions
```

The API key remains a secure prompt and is never accepted in argv. Protocol flags map to canonical
stored values `chat_completions` and `responses`.

When the endpoint ID already exists, CLI may omit endpoint label, origin, and protocol and resolve
them from existing custom credential projections. If complete metadata is supplied, control rejects
any conflict. Missing metadata for a new endpoint produces a clear validation error.

Model JSON accepts `provider: "custom"` with required `endpointId`. Existing CLI model operations
continue to validate through shared control. Pricing, limits, and capabilities remain explicit model
configuration rather than guessed defaults.

## Admin API and Error Handling

Gateway adds an authenticated admin route for API-key credential creation. It applies normal admin
session enforcement and delegates validation and persistence to `packages/control`.

Expected client errors include:

- blank API key
- missing or malformed endpoint ID or label
- unsupported protocol
- malformed origin
- non-HTTP origin
- origin containing credentials, query, or fragment
- endpoint ID conflict with existing normalized metadata
- custom target missing endpoint ID
- custom target referencing an endpoint ID not represented by current custom credentials at editing
  time

Control should distinguish invalid input from endpoint conflict so gateway and CLI can render stable
400- and 409-class outcomes. Runtime absence of matching credentials remains a routing failure, not a
model-validation rewrite.

Upstream HTTP errors, malformed SSE, truncation, and cancellation use existing OpenAI-compatible
client error surfaces and dispatch semantics. Client errors must not expose API keys, arbitrary
headers, credential IDs, internal stacks, or upstream response bodies that can contain sensitive
data. Logs may add closed, validated endpoint ID and endpoint label fields only if `LogFields` is
explicitly extended as a security-reviewed allowlist; arbitrary origin or upstream text must not be
logged.

## Compatibility and Catalog Behavior

`@omni/providers/catalog` remains a browser-safe leaf. It may expose static presentation metadata for
the built-in `custom` provider identity, but it must not import adapters, transport, store code, or
operator endpoint data.

Saved target prices remain authoritative. Custom endpoints have no catalog model entries, inferred
prices, discovered context windows, or inferred capabilities. `/v1/models` continues to expose saved
virtual models filtered by gateway-key policy; it does not proxy custom upstream model listings.

Custom API-key credentials skip OAuth refresh and provider quota polling. Missing quota data means
unknown, not unlimited, consistent with existing runtime rules.

## Testing

### Control and store

- Create custom credentials with normalized endpoint metadata.
- Reject blank secrets and malformed endpoint fields.
- Accept HTTP and HTTPS origins with and without a base path; reject other schemes and forbidden URL
  components.
- Reject duplicate endpoint IDs with conflicting label, origin, or protocol.
- Permit multiple credentials with identical endpoint metadata.
- Encrypt and recover API keys through purpose-specific secret loading.
- Keep API keys out of projections, errors, and logs.

### Router and dispatch

- Match custom targets only to credentials with the same endpoint ID.
- Rank and fail over among multiple keys for one endpoint.
- Never route or fail over across endpoint IDs.
- Preserve built-in provider matching.
- Produce no candidate when matching custom credentials are absent or disabled.
- Cover streaming and non-streaming clients.
- Preserve pre-commit failover and post-commit terminal stream behavior.
- Record usage at most once per request ID.

### Provider adapter

For both Chat Completions and Responses protocols, cover:

- request URL, bearer authorization, and JSON headers
- message and system handling
- tools and tool results
- image inputs where codec supports them
- reasoning or thinking degradation behavior
- canonical output events and usage
- upstream HTTP errors
- malformed, unknown, and truncated SSE events
- client cancellation and deadlines

Tests must confirm custom Chat Completions requests contain no Kimi-only headers and custom Responses
requests contain no OpenAI OAuth/Codex behavior.

### Gateway, CLI, and dashboard

- Enforce admin sessions on credential creation.
- Return stable invalid-input and conflict errors without secrets.
- Prompt for API keys securely in CLI and never place them in argv or output.
- Support complete new endpoint flags and existing endpoint reuse.
- Render accessible dashboard fields, protocol choices, HTTP warning, errors, and success state.
- Clear API-key form state after submission.
- Require endpoint selection for custom targets and preserve manual model fields.
- Re-query visible state after asynchronous creation.

### Regression verification

Before completion, run focused changed-behavior tests followed by:

```bash
bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
```

Anthropic, built-in OpenAI, Kimi, catalog-leaf, and shared proxy error-surface suites must remain
green.
