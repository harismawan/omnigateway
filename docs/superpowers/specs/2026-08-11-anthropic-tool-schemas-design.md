# Anthropic Tool Schemas Design

## Status

Approved on 2026-08-11.

## Problem

OmniGateway currently models every `POST /v1/messages` tool as a portable custom function with a
required `input_schema`. Anthropic-defined tools use fixed, versioned schemas and usually omit
`input_schema`. A valid WebSearch declaration therefore fails at ingress with:

```text
tools.0.input_schema: Invalid input: expected record, received undefined
```

Current decoding also recognizes only custom `tool_use` blocks. Anthropic server-tool use and result
blocks can disappear instead of surviving streaming, non-streaming collection, and history replay.

## Goals

- Accept every current Anthropic Messages API tool family and documented legacy wire version.
- Preserve exact tool versions, options, ordering, cache control, and beta headers.
- Preserve Anthropic server-tool blocks through ingress, provider transport, egress, and replay.
- Reject OpenAI and Kimi targets for Anthropic-native tools before dispatch.
- Keep existing portable custom-tool behavior unchanged.
- Surface unknown upstream block and event types instead of silently discarding them.

## Non-goals

- Emulate Anthropic-hosted tools on another provider.
- Drop unsupported tools and continue with degraded semantics.
- Execute Anthropic-defined client tools inside OmniGateway. Their caller remains responsible for
  Bash, text editor, computer-use, and memory tool execution.
- Add live-provider tests.
- Automatically add missing beta headers on behalf of clients.

## Supported tool families

OmniGateway will recognize these conceptual families:

1. Custom tools
2. Web search
3. Web fetch
4. Code execution
5. Bash
6. Text editor
7. Computer use
8. Memory
9. Regex tool search
10. BM25 tool search
11. Advisor
12. MCP connector toolset

Current versions and documented legacy versions present in Anthropic's stable or beta Messages API
unions are accepted. Version strings remain unchanged; the gateway never upgrades a caller's tool
version implicitly.

Recognized legacy forms include `bash_20241022`, `computer_20241022`,
`text_editor_20241022`, `text_editor_20250429`, and `code_execution_20250522`. They are accepted for
wire compatibility but are not recommended in operator documentation.

## Tool definition model

`ChatRequest.tools` becomes a discriminated union:

```ts
type ToolDef = CustomToolDef | AnthropicToolDef;
```

### Portable custom tools

`CustomToolDef` retains existing provider-neutral semantics:

- name
- optional description
- full JSON Schema input object
- optional cache control
- custom-tool options supported by Anthropic where they do not alter portability

Untagged custom definitions and `type: "custom"` definitions normalize to the same variant. Their
existing translation to Anthropic, OpenAI, and Kimi remains intact.

### Anthropic-defined tools

`AnthropicToolDef` identifies:

- `provider: "anthropic"`
- tool family
- exact versioned `type`
- fixed `name`
- family-specific configuration
- legal common definition properties

Family-specific types provide enough structure for validation and routing. Wire fields are preserved
without normalizing dated versions or changing defaults.

Common properties are accepted only where Anthropic permits them:

- `cache_control`
- `strict`
- `defer_loading`
- `allowed_callers`
- `input_examples`
- `eager_input_streaming`

`mcp_toolset` has its narrower property set. Version-specific options such as
`response_inclusion`, `use_cache`, `enable_zoom`, and text-editor `max_characters` are restricted to
versions that support them.

## Ingress validation

Anthropic ingress validates:

- known family and exact supported version
- fixed `type` and `name` pairing
- required family fields
- legal common properties
- version-specific fields
- mutually exclusive domain allow/block lists
- complete custom `input_schema` objects
- MCP toolset references against top-level `mcp_servers`
- deferred-tool constraints that can be checked from one request

Unknown tool types and unknown fields within recognized versioned definitions return precise
`400 BAD_REQUEST` paths. The gateway does not accept arbitrary dated prefixes because that could
forward unsupported semantics while advertising compatibility.

Required beta names remain client-owned and flow through existing `anthropic-beta` forwarding. A
missing beta opt-in is not synthesized by the gateway.

## Anthropic content blocks

Request/history IR gains an Anthropic-owned typed content variant for documented native blocks,
including:

- `server_tool_use`
- web-search results
- web-fetch results
- code-execution results
- tool-search results and references
- advisor results
- MCP server-tool use and results
- associated file or container result blocks required by documented tools

Each recognized discriminator has boundary validation. Nested provider payloads remain structurally
intact so citations, errors, file references, caller metadata, and continuation state survive.

These blocks are not generic custom `toolUse` or `toolResult` blocks. They do not enter custom-tool
ID correlation, orphan removal, cross-provider translation, or RTK compression.

## Routing and capabilities

Request requirements distinguish:

- portable custom-function tools
- Anthropic-native tools or Anthropic-native history

Targets advertise Anthropic-native tool support separately from generic custom-tool support. Any
request containing an `AnthropicToolDef` or Anthropic-native history block excludes OpenAI and Kimi
candidates. If a pool has no compatible target, routing fails before provider dispatch.

Unsupported Anthropic tools are never dropped, approximated, or discovered only during late adapter
encoding.

## Anthropic provider encoding

The Anthropic wire encoder:

- keeps current custom-tool encoding unchanged
- emits Anthropic-defined tools with their exact version and options
- preserves tool-array ordering
- preserves cache-control placement and TTL
- emits Anthropic-native history blocks without converting them to portable function calls
- keeps top-level MCP server configuration and beta fields through Anthropic vendor passthrough

Provider wire formats remain in `packages/providers`; provider-specific shapes do not leak into the
router or other adapters beyond typed capability requirements.

## Anthropic provider decoding

The decoder recognizes documented native content-block starts, deltas, stops, and result payloads.
Canonical stream events preserve each native block until Anthropic egress reconstructs it.

`pause_turn` becomes a distinct canonical stop reason. It is not mapped to `endTurn` or `toolUse`.
Clients can append the assistant response to history and resend it without a synthetic `Continue`
message.

Unknown Anthropic content blocks or SSE event types produce an explicit upstream protocol error.
They must not disappear silently or emit unmatched block-end events.

Server-tool failures remain successful HTTP responses containing tool-result error objects, matching
Anthropic behavior. They are not converted into gateway transport failures.

## Client egress

Anthropic streaming egress emits original native block types and deltas. Non-streaming collection
returns the same block structures in the final `content` array. Replay through Anthropic ingress
retains those structures.

OpenAI client egress needs no Anthropic-native representation because router compatibility prevents
an Anthropic-native request from selecting an OpenAI or Kimi target. Existing portable custom-tool
translation remains unchanged.

## RTK behavior

RTK continues to inspect and rewrite only generic successful textual custom-tool results. It ignores
all Anthropic-native server and client-tool blocks. This prevents compression from corrupting
provider-owned result structures, citations, continuation state, or signatures.

## Error behavior

Gateway returns `400 BAD_REQUEST` for:

- malformed tool definitions
- invalid fixed name/type pairs
- missing required version fields
- illegal version-specific fields
- invalid MCP toolset/server references
- malformed native history blocks

When no pool target supports Anthropic-native tools, the normal routing failure identifies the
unsupported requirement without exposing provider credentials, credential IDs, or internal target
IDs.

Upstream server-tool result errors remain content blocks under HTTP 200.

## Testing

All tests use synthetic requests, synthetic SSE, in-memory stores, and stub `HttpClient`; no live
provider calls.

Table-driven coverage includes:

1. Valid ingress parsing for all twelve families and supported versions.
2. Invalid required fields, illegal fields, and fixed name/type pairs.
3. Exact Anthropic wire encoding.
4. Streaming decode and Anthropic egress.
5. Non-streaming collection and round-trip.
6. History replay.
7. `pause_turn` continuation.
8. Server-tool result error objects.
9. MCP cross-field validation.
10. Router exclusion of OpenAI and Kimi targets.
11. Existing custom tools still route and translate across providers.
12. RTK never rewrites Anthropic-native results.
13. Unknown block and event types fail visibly.
14. Beta-header preservation.
15. Cache-control and tool-order preservation.

Focused tests are added at each stable boundary: ingress, IR validation, router filters, Anthropic
wire encoding/decoding, client egress, RTK, and end-to-end round trips.

## Documentation

Update detailed compatibility documentation with supported Anthropic-native tools and their
Anthropic-target-only routing rule. Update operator-facing README only where users need to understand
that custom tools remain portable while Anthropic-defined tools require an Anthropic target.

## Completion criteria

- Claude Code WebSearch requests pass ingress and execute against Anthropic targets.
- Every supported tool family and version has request-schema coverage.
- Documented server-tool responses survive streaming, non-streaming output, and replay.
- Incompatible provider targets are rejected before dispatch.
- Existing custom-tool behavior and tests remain green.
- Focused tests, full core tests, dashboard tests, typecheck, and lint pass.
