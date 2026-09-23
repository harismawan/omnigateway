# RTK Tool-Result Compression Design

## Summary

OmniGateway will add an opt-in, deterministic RTK (Rust Token Killer-inspired) transform for
historical shell tool results. The transform will run once on canonical request IR before dispatch,
reducing repetitive command output without changing provider routing, retry, deadline, or stream
commit behavior.

This feature narrowly amends the original OmniGateway non-goal that prompt content passes through
unmodified except for format translation. The exception is limited to operator-enabled compression
of eligible, non-error historical tool-result text. It does not summarize user messages, assistant
prose, system messages, thinking blocks, tool calls, responses, or arbitrary context.

The MVP uses built-in filters only. It has no custom filters, raw-output retention, learning,
subprocesses, network calls, or model-based compression. It is disabled by default.

## Research Basis

Two gateway implementations informed this design:

- 9Router applies a small JavaScript RTK port to already-recorded tool results before provider
  dispatch. It uses fixed detectors, built-in filters, fail-open behavior, and one global toggle.
- OmniRoute implements a larger TypeScript compression engine with canonical request adaptation,
  tool-call correlation, configurable filters, cache-control protection, preview, trust controls,
  and raw-output recovery.

OmniGateway will take 9Router's bounded MVP scope and OmniRoute's stronger safety properties:
canonical-IR processing, tool-call correlation, known non-shell exclusion, cache-control
preservation, immutable transformation, and structured metrics. OmniGateway will not copy either
project's broad configuration or recovery surfaces in this phase.

RTK here is request transformation, not model routing. Existing `@omni/router` behavior remains
unchanged.

## Goals

- Reduce tokens consumed by large, repetitive shell command results already present in agent
  conversation history.
- Apply one provider-neutral transform to Anthropic and OpenAI client requests.
- Preserve errors, cache breakpoints, non-shell tool data, and all non-tool-result content.
- Keep transformed requests identical across provider failover attempts.
- Provide operator control through persisted settings and dashboard UI.
- Persist aggregate per-request savings metrics without storing prompt or command content.
- Keep transformation deterministic, synchronous, bounded, immutable, and fail-open.

## Non-Goals

- Running or embedding the upstream Rust RTK executable.
- Intercepting shell commands before execution.
- Compressing user, system, assistant, thinking, image, or provider-response content.
- Compressing explicit error tool results.
- Model-based or semantic summarization.
- Custom/project/global filter files or arbitrary regular expressions.
- Raw-output storage or recovery.
- Learned filters, filter suggestions, or discovery APIs.
- Per-model, per-provider, per-key, or per-request configuration.
- Daily RTK aggregate tables or billing changes.
- Exact tokenizer-based savings claims.

## Architecture

### Package boundary

Create a dedicated `@omni/rtk` workspace package. It depends on `@omni/ir` and exposes a pure
transformation API. It must not import process, filesystem, network, database, providers, router,
control, gateway code, timers, or logging.

The package owns:

- tool-use/result correlation;
- shell-origin classification;
- output-family detection;
- built-in filters;
- safety checks;
- immutable request rewriting;
- structured transformation reports.

Keeping this logic outside `@omni/ir` preserves IR as a provider-neutral domain model rather than
mixing it with optional product policy. Keeping it outside the gateway avoids application-layer
filter logic and permits narrow package tests.

### Request flow

The proxy request flow becomes:

```text
authenticate
→ parse client dialect into ChatRequest
→ enforce normalized model allowlist
→ enter dispatch and establish its absolute deadline
→ obtain one routing snapshot, including settings
→ transform canonical tool results once using that snapshot's rtkEnabled
→ resolve and rank candidates
→ send the same transformed request on every attempt
→ persist the RTK report when the request completes
```

Transformation occurs after ingress because both client dialects then share canonical IR. Dispatch
owns it because dispatch already owns the absolute deadline, cancellation, routing snapshot, retry,
and completion-log lifecycle. Transformation runs after one snapshot is obtained and before model
resolution/ranking. It checks cancellation and deadline before and after preprocessing. All routing
and failover attempts use that same snapshot and transformed request. RTK policy does not run in the
pure router or provider adapters.

Failures before dispatch use required zero-value RTK request-log fields. Once dispatch starts, its
request context owns the report and merges it into every success, failure, streaming completion, and
pending-row completion path exactly once.

The transform API is conceptually:

```ts
interface RtkTransformResult {
  request: ChatRequest;
  report: RtkReport;
}

function transformRequest(request: ChatRequest, config: RtkConfig): RtkTransformResult;
```

When disabled or when no block changes, the function returns the original `ChatRequest` reference.
When blocks change, it performs copy-on-write cloning only along changed message/block paths.

### Existing contract amendment

The foundational design's no-transformation rule remains the default. This feature creates one
explicit exception:

> When an operator enables RTK, OmniGateway may deterministically shorten eligible historical,
> non-error shell `ToolResultBlock.content` values according to built-in, versioned filters.

No other request or response content becomes eligible through this amendment.

## Eligibility and Correlation

### Tool correlation

The transformer scans messages in order and indexes earlier `ToolUseBlock` values by ID. For each
later `ToolResultBlock`, it resolves:

- tool name;
- candidate command from tool input;
- whether origin is confirmed shell, confirmed non-shell, or unknown.

Command extraction accepts either a primitive string input or a plain, non-array object with an
own string property. Object keys use fixed precedence: `command`, then `cmd`, then `script`. Empty
strings, inherited properties, boxed strings, arrays, non-plain objects, non-string values, and
nested values are rejected. Extraction returns `string | undefined`; strict optional objects omit
missing values rather than storing `undefined`.

Correlation is conversation-order aware: a result may only correlate with an earlier tool use.
Duplicate tool-use IDs resolve to the nearest preceding matching use, preventing future or stale
calls from supplying provenance.

### Origin policy

Tool names are normalized to lowercase and separators (`-`, `.`, `/`, and whitespace) become `_`.
A closed exact-name allowlist confirms shell origin. Initial entries cover `bash`, `shell`,
`terminal`, `exec`, `run_command`, and `execute_command`, plus exact client-specific aliases proven
by fixtures. Substring matches are forbidden: names such as `execute_sql`, `command_palette`, and
`execute_api_request` remain unknown.

A closed known-non-shell set covers read, edit, write, glob, search, and similar file-oriented tools.
Confirmed non-shell results are never compressed, even when their text resembles build or test
output. Unmatched names remain unknown rather than becoming confirmed shell.

When correlation is unavailable, only high-confidence specialized output detectors may run. This
means MVP scope includes format-inferred compression of unknown-origin tool results; operator
copy must disclose this behavior. Generic deduplication and truncation require confirmed shell
origin.

### Block safety gates

Constants use UTF-16 code units because JavaScript indexes strings that way:

- minimum input: 0 code units (no floor; see below);
- maximum processable input: 1,000,000 code units;
- detection prefix: 4,096 code units and at most 64 lines;
- generic duplicate-log minimum: 20 lines;
- numbered-read truncation minimum: 250 lines;
- smart-truncation minimum: 500 lines;
- maximum accepted transformed output: 250,000 code units.

A tool result is ineligible when any condition holds:

- RTK is disabled;
- `isError === true`;
- block has `cacheControl`;
- origin is confirmed non-shell;
- content exceeds 1,000,000 code units;
- no permitted detector matches.

Inputs over the processing cap remain unchanged; truncation does not bypass the cap.

#### Why there is no minimum input size

The original 500-code-unit floor was carried over from OmniRoute without a stated rationale, and
measurement showed it was redundant with the acceptance guard. Each filter already has its own line
minimum, and every candidate must be strictly shorter than its input to be accepted, so small blocks
are rejected by the filters themselves rather than by a size test. Removing the floor left realistic
short outputs — `git status --short`, a three-row grep, a fourteen-path listing, a twenty-two-line
duplicate log — byte-identical.

One class does change: a block over roughly 32 lines that is still under 500 code units, which means
very short lines. A 242-code-unit, 44-line diff compresses to 207 units, eliding twelve rows under an
omission marker. That is the whole of the trade — about nine tokens against twelve rows the model no
longer sees — and it is the reason the floor is not worth restoring in either direction: it bought
nothing measurable, and it hid nothing dangerous.

The floor's removal does not widen what may be compressed. Origin policy, detector permissions, and
the acceptance guard are unchanged, so a block that was ineligible for any reason other than its size
remains ineligible.

Explicit error and cache-controlled blocks remain byte-identical, including their object identity
when no surrounding change requires cloning.

## Detection and Filters

### Detection

Detection uses explicit correlated command information first, then bounded output inspection. It
never scans more than a fixed prefix for classification. Detector priority is deterministic and
specific formats precede generic formats.

Missing-correlation fallback permits only high-confidence forms:

- Git diff, status, and log;
- grep-style `path:line:text` results;
- path listings;
- recognizable Bun/npm/Cargo/compiler build output;
- recognizable test-runner output.

Confirmed shell results may additionally use duplicate-log collapse, numbered-read truncation, and
generic large-output head/tail truncation.

Exactly one specialized filter may run per tool-result block. Detector priority is:

1. Git diff
2. Git status
3. Git log
4. compiler/build output
5. test output
6. grep output
7. path listing
8. numbered read

First matching permitted detector wins. Specialized filters are terminal except for one bounded
post-pass: consecutive duplicate/blank-line collapse may run after `build-output` or `test-output`.
For confirmed shell output with no specialized match, `deduplicate-log` may run; if it does not
shrink output and line count reaches 500, `smart-truncate` may run against original content.
`numbered-read` is terminal. No specialized output feeds generic truncation.

One accepted filter application equals one `filterHit`. When build/test post-dedup also shrinks
output, it creates a second hit and both IDs appear in order. Rejected or non-shrinking applications
do not count.

### Built-in filter catalog

MVP filter IDs form a closed TypeScript union:

- `git-diff`
- `git-status`
- `git-log`
- `grep`
- `path-list`
- `numbered-read`
- `build-output`
- `test-output`
- `deduplicate-log`
- `smart-truncate`

`build-output` recognizes Bun, npm, Cargo, and common compiler/build output. `test-output` recognizes
Bun test output and common test-runner summaries. Detection may distinguish subfamilies internally,
but telemetry stores only closed filter IDs.

Bun coverage includes:

- `bun test` pass/fail output and named failures;
- `bun run` script/build output;
- `bun build` diagnostics and summaries;
- package installation progress and final summaries;
- Bun stack traces and error diagnostics.

### Preservation rules

Filters preserve format-specific semantic anchors:

- Git file headers, hunk headers, changed-line context, and summaries;
- status categories and representative paths;
- commit headers, subjects, and stat summaries;
- grep filenames, line numbers, representative matches, and omitted counts;
- representative paths grouped without exposing them to telemetry;
- compiler/test errors, warnings, named failures, stack lines, and final summaries;
- first and last regions of oversized generic output;
- deterministic markers describing omitted lines or entries.

Generic truncation runs only over a large line threshold and retains both head and tail regions.
Duplicate collapse affects consecutive identical lines and repeated blank lines; it does not merge
non-consecutive diagnostics.

### Acceptance guard

Every filter runs through one safety wrapper. Transformed output is accepted only when it is:

- a string;
- nonempty;
- strictly shorter than original content;
- within configured hard output bounds;
- produced without exception.

Otherwise original content is retained. Filters receive immutable input and return new strings.

## Configuration and Operator Surface

Add one persisted setting:

```ts
rtkEnabled: boolean;
```

Default is `false`. Control validation accepts only booleans. Store normalization must handle
malformed persisted JSON without enabling RTK or failing a proxy request: only literal
`rtkEnabled === true` enables it; `false`, missing, malformed, and every non-boolean value normalize
to `false`. Existing authenticated settings API reads and writes it; no RTK-specific endpoint is
needed for MVP.

Dashboard Settings page adds one toggle with concise disclosure:

> Compress recognized historical non-error tool results before provider dispatch. Confirmed
> non-shell tools are excluded; unknown-origin results may be compressed only when a built-in
> detector recognizes a high-confidence shell-output format. Compression is deterministic and
> lossy. Disabled by default.

No request header override exists in MVP. No virtual-model or target schema changes are needed.
Dispatch obtains one routing snapshot per request and uses its settings for RTK, deadline, ranking,
and every attempt. A concurrent toggle affects subsequent snapshots, never an in-flight request.

## Telemetry and Persistence

### Structured report

Transformation returns aggregate metrics only:

```ts
interface RtkReport {
  applied: boolean;
  filterHits: number;
  originalCodeUnits: number;
  compressedCodeUnits: number;
  estimatedTokensSaved: number;
  filters: RtkFilterId[];
  skippedInternalErrors: number;
}
```

`filters` contains unique filter IDs in first-application order. Code-unit totals sum only original
and final content for blocks with at least one accepted filter application. Estimated savings equal
`max(0, estimateInputTokens(originalRequest) - estimateInputTokens(transformedRequest))`; they use
the existing provider-neutral estimator and remain advisory.

Per-filter exceptions retain that block and increment `skippedInternalErrors`; accepted changes to
other blocks remain. A top-level exception returns the original request with `applied: false`, zero
hits and code-unit/token counters, an empty filter list, and `skippedInternalErrors: 1`.

### Request-log fields

Add required, non-null request-log properties and matching non-null database columns:

- `rtkApplied`
- `rtkFilterHits`
- `rtkOriginalCodeUnits`
- `rtkCompressedCodeUnits`
- `rtkEstimatedTokensSaved`
- `rtkFilters`

Migration defaults are `false`, `0`, and `[]`, so old rows, pending rows, pre-dispatch failures, and
swept rows have deterministic values without optional-property branching. `rtkFilters` is JSON
validated against the closed filter-ID union on read. Dispatch's request context owns the report and
merges it into every completion path through the existing at-most-once completion flow.

`skippedInternalErrors` is not persisted or logged in MVP because no approved numeric metrics sink
exists. It remains available to tests and future structured metrics work.

Daily usage rollups remain unchanged. Provider-reported usage remains authoritative for billing and
cost accounting; RTK estimates never populate existing input-token usage fields.

Dashboard request details may display RTK applied state, filter hits, character reduction, estimated
token reduction, and filter IDs. It must not display or retain transformed content.

### Privacy boundary

RTK must never persist or log:

- original or compressed prompt content;
- command text;
- tool names or tool-use IDs;
- file paths or matched text;
- arbitrary metadata or regex captures.

MVP adds no RTK operational log fields. Request-log columns provide aggregate observability without
expanding the closed runtime logging boundary. Adding numeric or free-text RTK log fields requires a
separate security review.

## Error Handling and Resource Bounds

RTK is fail-open with respect to compression and fail-safe with respect to content:

- detector/filter exception retains original block;
- top-level transformer exception retains original request;
- unknown or ambiguous output remains unchanged;
- equal or larger output remains unchanged;
- malformed tool input prevents command extraction but does not reject request;
- store normalization treats malformed, missing, and non-boolean persisted RTK values as disabled;
- telemetry persistence follows existing request-log error handling and never changes provider
  retry decisions.

Processing is synchronous and bounded:

- hard per-result UTF-16 code-unit cap;
- bounded detection prefix;
- bounded line and output counts;
- no arbitrary regular expressions from operators or repositories;
- no filesystem, subprocess, network, timers, or tokenizer calls.

Transformation runs once inside dispatch after deadline and snapshot acquisition but before model
resolution and attempts. It does not consume an independent retry budget, change per-target
behavior, or alter pre-commit versus post-commit failover semantics. Cancellation/deadline checks
before and after preprocessing keep the existing absolute deadline authoritative.

## Invariants

For every transformation, the following remain unchanged:

- message count and order;
- message roles;
- content-block count, order, and types;
- tool-result IDs and `isError` values;
- all cache-control values and positions;
- tool-use blocks, IDs, names, and inputs;
- system, text, image, thinking, and redacted-thinking blocks;
- model, tools, tool choice, reasoning, stream, vendor, beta, and other request fields;
- mid-conversation system-message placement;
- Anthropic thinking signatures;
- request identity used by dispatch and usage completion.

Only `content` on an eligible `ToolResultBlock` may differ.

## Testing Strategy

### Package tests

`@omni/rtk` receives focused behavior and property tests covering:

- earlier-tool correlation and nearest-preceding duplicate-ID behavior;
- shell-name recognition and known non-shell exclusion;
- command extraction from supported string/object shapes;
- every detector and filter with representative fixtures;
- Bun test, run, build, install, stack-trace, success, and failure fixtures;
- npm, Cargo, compiler, and common test-runner fixtures;
- explicit error and cache-controlled blocks remaining byte-identical;
- missing-correlation conservative fallback;
- source/prose text that resembles build, test, grep, or path output;
- Unicode, CRLF, malformed inputs, empty content, and hard-size limits;
- strict non-inflation;
- immutable inputs and copy-on-write behavior;
- deterministic output for identical inputs;
- individual-filter and top-level fail-open behavior;
- exact preservation of all noneligible fields and blocks.

### Integration tests

Gateway, store, control, provider, and dashboard tests cover:

- Anthropic and OpenAI ingress reaching equivalent canonical compression behavior;
- streaming and non-streaming requests;
- every failover attempt receiving the same transformed request;
- disabled default preserving current request bytes and behavior;
- persisted settings API round-trip and dashboard toggle;
- request-log migration, write, read, and request-detail rendering;
- no usage-row changes from estimated RTK savings;
- prompt-cache markers, system-message placement, tool translation, and thinking signatures;
- no prompt, command, tool, path, or match content in logs or persistence;
- existing deadline, cancellation, retry, and stream-commit tests remaining green.

### Completion gate

Before implementation completion:

```bash
bun test
bun run --cwd apps/dashboard test
bun run typecheck
bun run lint
```

Focused changed-behavior suites run first. Formatting follows repository Biome rules.

## Rollout

1. Ship setting and transformer disabled by default.
2. Operators opt in through dashboard.
3. Observe structured per-request metrics and false-positive reports.
4. Expand filters only through separately reviewed built-in fixtures and adversarial tests.

Custom filters, raw recovery, preview APIs, per-model policy, and broader prompt compression require
separate designs. They are not implied by this MVP.
