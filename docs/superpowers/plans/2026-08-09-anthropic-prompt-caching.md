# Fix Anthropic Prompt Caching

## Context

OmniGateway currently strips nested Anthropic `cache_control` markers during ingress and never restores them on upstream encoding. Claude Code normally places explicit breakpoints on stable system, tool, and conversation blocks. Without those markers, Anthropic reports both cache counters as zero, repeated prompt prefixes count as uncached input, and input-token rate limits drain quickly.

Internal usage decoding, dispatch logging, SQLite persistence, aggregation, and dashboard display already support cache read/write counters. A second bug exists at the client boundary: Anthropic-compatible streaming and buffered responses omit those counters even when upstream reports them.

Requested reference implementations confirm expected pattern:

- CLIProxyAPI copies nested `cache_control` objects, preserves block-level precedence, and optionally injects breakpoints only when none exist.
- OmniRoute detects and preserves markers on system, message, and tool blocks.
- Both perform OAuth billing/CCH mutation and signing after cache metadata handling, so OmniGateway's signing mechanism is not primary cause.

Goal: preserve caller-supplied Anthropic caching intent end-to-end and expose cache usage in Anthropic-compatible responses. Do not add automatic cache breakpoint injection; that is separate product policy.

## Confirmed Root Cause

### Marker loss

- `apps/gateway/src/ingress/anthropic.ts:13` defines text blocks with only `type` and `text`; Zod strips nested `cache_control`.
- `apps/gateway/src/ingress/anthropic.ts:63-100` omits `cache_control` from system blocks and tool definitions.
- `apps/gateway/src/ingress/anthropic.ts:132-153`, `223-245` convert parsed content to IR without cache metadata.
- `packages/ir/src/request.ts:3` contains unused `cacheBreakpoint?: boolean`; repository search found no readers or writers.
- `packages/ir/src/request.ts:43-47` gives `ToolDef` no cache metadata.
- `packages/providers/src/anthropic/wire.ts:23-43`, `76-108` renders content, system blocks, and tools without `cache_control`.
- Top-level `cache_control` happens to survive via vendor passthrough (`apps/gateway/src/ingress/anthropic.ts:258-259`, `packages/providers/src/anthropic/wire.ts:134-136`), but Claude Code relies on nested explicit breakpoints.

### Usage response omission

- `packages/providers/src/anthropic/decode.ts:70-75` correctly reads `cache_read_input_tokens` and `cache_creation_input_tokens` from upstream `message_start`.
- `packages/providers/src/anthropic/decode.ts:133-139` correctly emits them in canonical `Usage`.
- `apps/gateway/src/dispatch/index.ts:245-251` correctly records them.
- `packages/store/src/sqlite/usage.ts:170-188`, `259-288` correctly persists and aggregates them.
- `apps/gateway/src/routes/proxy.ts:245-248` correctly includes them in structured completion logs.
- `apps/gateway/src/egress/anthropic.ts:102-110` emits only `input_tokens` and `output_tokens` in streaming `message_delta`.
- `apps/gateway/src/egress/anthropic.ts:144-147` emits only those two fields in buffered responses.

### Rate-limit effect

For most current Anthropic models, input-token rate-limit usage is:

```text
input_tokens + cache_creation_input_tokens
```

`cache_read_input_tokens` does not consume ITPM. Stripped breakpoints prevent cache creation and later reads, so repeated system prompts, tools, and history are charged against input rate limits each request.

## Reference Evidence

### CLIProxyAPI

- `internal/translator/common/cache_control.go:12-21`: copies full `cache_control` object, including TTL.
- `internal/translator/common/cache_control.go:27-66`: message-level control targets last content block; existing block-level control wins.
- `internal/runtime/executor/claude_executor_execute.go:113-125`: optional auto-injection only when marker count is zero; enforces four-marker limit and TTL ordering.
- `internal/runtime/executor/claude_executor_cloaking.go:851-874`: auto-marks last eligible tool, last system block, and prior conversation history.
- `internal/runtime/executor/claude_signing.go:59-132`: prepends unmarked billing block and signs final body.

### OmniRoute

- `open-sse/translator/helpers/claudeHelper.ts:299-356`: detects nested controls across system, messages, and tools.
- `open-sse/translator/helpers/claudeHelper.ts:359-407`: preserves marked requests.
- `open-sse/translator/helpers/claudeHelper.ts:703-718`: preserves tool markers.
- `open-sse/executors/base.ts:1092-1119`, `1280-1295`: prepends billing content and signs after OAuth body mutation.

## Recommended Implementation

### 1. Add precise cache-control IR type

Modify `packages/ir/src/request.ts`:

- Replace dead boolean `cacheBreakpoint?: boolean` with named value type:

```ts
export type CacheControl = {
  type: "ephemeral";
  ttl?: "5m" | "1h";
};
```

- Add `cacheControl?: CacheControl` to every canonical block shape that current Anthropic ingress accepts and Anthropic can cache:
  - `TextBlock`
  - `ImageBlock`
  - `ToolUseBlock`
  - `ToolResultBlock`
- Do not add it to `ThinkingBlock`; Anthropic does not allow direct cache markers on thinking blocks.
- Add `cacheControl?: CacheControl` to `ToolDef`.

Reason for modeling more than text: Anthropic supports breakpoints on cacheable user content, tool-use blocks, tool results, images/documents, and tools. Restricting fix to text would still silently lose valid caller intent. Existing `ContentBlock` union can carry optional metadata without provider-specific imports.

Use exact optional-property construction (`...(value === undefined ? {} : { cacheControl: value })`) to satisfy `exactOptionalPropertyTypes`.

### 2. Preserve nested controls at Anthropic ingress

Modify `apps/gateway/src/ingress/anthropic.ts`:

- Add reusable Zod schema for `{ type: "ephemeral", ttl?: "5m" | "1h" }`.
- Add optional `cache_control` to cacheable content schemas: text, image, tool-use, tool-result.
- Keep thinking schema unchanged.
- Add optional `cache_control` to tool definitions.
- Map wire `cache_control` to IR `cacheControl` in `toIrBlock`, top-level system conversion, and tool conversion.
- Preserve current flattening of tool-result content and all existing request behavior.
- Leave top-level automatic `cache_control` in vendor passthrough; do not add it to `KNOWN` unless separately modeled. Existing behavior already forwards it unchanged.

Validation choice: accept only supported shapes (`ephemeral`, optional `5m`/`1h`) rather than unconstrained metadata. Invalid input should continue producing normal `BAD_REQUEST` through `parseOrThrow`.

### 3. Re-emit controls on Anthropic wire

Modify `packages/providers/src/anthropic/wire.ts`:

- Add one helper translating `cacheControl` to wire `cache_control` while omitting absent TTL.
- Extend `encodeBlock` for text, image, tool-use, and tool-result blocks.
- Preserve cache metadata when mapping `req.system` blocks.
- Preserve cache metadata on tool definitions.
- Keep thinking blocks unmarked.
- Keep OAuth identity prefix unmarked. Caller breakpoint stays attached to original block after prefix insertion, matching reference implementations.
- Keep vendor passthrough last and keep current OAuth signing flow unchanged.

Mid-conversation `role: "system"` currently flattens content blocks to a string in `encodeSystemTurn`. That conversion cannot preserve block-level metadata. Preserve existing documented string contract unless tests demonstrate Anthropic accepts marked block arrays for this special feature; scope fix to ordinary system prompt and regular message blocks. If ingress accepts a marker on a mid-conversation system block, either reject it explicitly or record degradation rather than silently discarding it. Preferred minimal behavior: do not accept cache controls on `role: "system"` content until wire support is verified.

### 4. Return cache usage to Anthropic clients

Modify `apps/gateway/src/egress/anthropic.ts`:

- Streaming `message_delta.usage` should include:
  - `input_tokens`
  - `output_tokens`
  - `cache_read_input_tokens`
  - `cache_creation_input_tokens`
- Buffered response `usage` should include same four fields.
- Keep `message_start` zero-valued because canonical IR receives usage only on terminal `end`. For shape consistency, include zero cache fields there as well.
- Do not recompute `input_tokens`; Anthropic semantics define it as uncached input after final breakpoint. Decoder already preserves upstream value correctly.

## TDD Sequence

Follow strict red-green order. Production change that makes each test pass must be named before writing test.

### RED 1: ingress preservation

Add focused tests to `apps/gateway/test/ingress/anthropic.test.ts` proving:

1. System text block with `cache_control: { type: "ephemeral", ttl: "1h" }` becomes IR `cacheControl` with TTL.
2. Message cacheable blocks preserve controls. Cover text plus one non-text block (tool result or image) to prove shared model.
3. Tool definition preserves its control.
4. Invalid type or TTL returns `BAD_REQUEST`.

Run:

```bash
bun test apps/gateway/test/ingress/anthropic.test.ts
```

Confirm failures show missing `cacheControl`, not test setup errors.

### GREEN 1

Implement IR type and ingress mapping only. Re-run focused ingress test until green.

### RED 2: upstream wire preservation

Add tests to `packages/providers/test/anthropic.test.ts` proving:

1. System marker and 1h TTL render exactly.
2. Message marker renders on same block.
3. Tool marker renders exactly.
4. OAuth identity/billing prefix does not remove or relocate caller marker from original system block.

Run:

```bash
bun test packages/providers/test/anthropic.test.ts
```

Confirm expected missing `cache_control` failures.

### GREEN 2

Implement wire helper and mappings. Re-run provider test until green.

### RED 3: client usage propagation

Change test fixture in `apps/gateway/test/egress/anthropic.test.ts` to nonzero cache values and assert all four Anthropic usage fields in:

1. Streaming terminal `message_delta`.
2. Buffered response.
3. Streaming `message_start` zero usage shape, if cache zeros are added there.

Run:

```bash
bun test apps/gateway/test/egress/anthropic.test.ts
```

Confirm failures show omitted fields.

### GREEN 3

Add cache usage fields to egress. Re-run focused test until green.

### Existing decoder coverage

Strengthen `packages/providers/test/anthropic.test.ts` existing decoder test (`message_start` currently supplies only `input_tokens`) with nonzero upstream cache counters and assert canonical values. This should pass before production edits, proving decoder/storage side is not root cause. If changed as characterization test, record that it passed immediately and do not treat it as TDD proof for new behavior.

## Critical Files

Production:

- `packages/ir/src/request.ts`
- `apps/gateway/src/ingress/anthropic.ts`
- `packages/providers/src/anthropic/wire.ts`
- `apps/gateway/src/egress/anthropic.ts`

Tests:

- `apps/gateway/test/ingress/anthropic.test.ts`
- `packages/providers/test/anthropic.test.ts`
- `apps/gateway/test/egress/anthropic.test.ts`

Potential compile-only fallout:

- Other provider encoders switch over `ContentBlock`; optional fields should not require changes.
- Fixtures using `TextBlock`/`ToolDef` remain valid because new properties are optional.

## Non-goals

- No automatic breakpoint injection.
- No cache-key generation.
- No changes to rate-limit breaker or quota poller.
- No changes to CCH signing, billing block generation, or OAuth beta merging.
- No dashboard changes; dashboard already displays stored cache counters.
- No unconstrained vendor metadata in IR.

## Verification

Run focused tests after each TDD cycle, then required repository checks:

```bash
bun test apps/gateway/test/ingress/anthropic.test.ts
bun test packages/providers/test/anthropic.test.ts
bun test apps/gateway/test/egress/anthropic.test.ts
bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
```

If formatting changes are needed:

```bash
bun run fmt
```

Then rerun affected focused tests, typecheck, and lint.

End-to-end behavior to verify with stubbed upstream test if existing proxy fixtures allow body inspection:

1. Send Anthropic request containing stable system/tool/message controls.
2. Assert captured upstream body retains exact controls and TTLs after OAuth system/billing mutation.
3. Feed upstream SSE `message_start` with nonzero cache read/write counts.
4. Assert request log stores same values.
5. Assert Anthropic client receives same values in streaming and buffered response shapes.

Expected fixed behavior:

```text
first eligible request: cache_creation_input_tokens > 0
matching follow-up:      cache_read_input_tokens > 0
repeated cached prefix:  excluded from ITPM on most current models
```
