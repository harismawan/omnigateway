# OmniGateway Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the headless AI gateway — a Bun + Elysia server that accepts Anthropic- and OpenAI-shaped requests, routes each to the best available upstream OAuth credential, and streams the response back in the client's format.

**Architecture:** Client requests normalize into a canonical IR (`packages/ir`). A pure router ranks candidate (provider, model, credential) triples by tier, health, quota, cost, and latency. Dispatch executes attempts against provider adapters, retrying freely until a commit point — the first content event — after which the response streams through to the client. Storage sits behind repository interfaces with a SQLite implementation.

**Tech Stack:** Bun 1.4, Elysia 1.4, TypeScript strict, Zod 4 for validation, `bun:sqlite` for storage, `bun test` for tests, Biome 2 for lint and format.

**Scope:** This plan covers the gateway and its control API. The React dashboard is a separate plan (`2026-07-31-omnigateway-dashboard.md`) that consumes the control API built here. Every feature in this plan is verifiable via `curl` and `bun test` with no UI.

**Spec:** `docs/superpowers/specs/2026-07-31-omnigateway-design.md`

## Global Constraints

- **Runtime:** Bun 1.4.0 or later. No Node.js compatibility requirement.
- **TypeScript:** `strict: true`. No `any` in committed code; use `unknown` and narrow.
- **Dependency floors:** `elysia@1.4.29`, `zod@4.4.3`, `@biomejs/biome@2.5.6`.
- **Package manager:** `bun`. Workspaces via the root `package.json` `workspaces` field.
- **Module boundaries (enforced by review, see Task 2):**
  - `packages/ir` imports nothing outside itself.
  - `packages/providers` imports only `packages/ir`. Never `store`, never `router`.
  - `apps/gateway/src/router` imports `ir` and `store`. Never `providers`.
  - `apps/gateway/src/dispatch` is the only module importing both `router` and `providers`.
- **Client identification:** The gateway sends `User-Agent: omnigateway/<version>`. It MUST NOT send `X-Stainless-*` headers, `X-App`, or any pinned third-party CLI version string. Only protocol-required headers (`anthropic-version`, `anthropic-beta`, `originator`, `chatgpt-account-id`, `X-Msh-*`) are sent. This is a spec requirement, not a style preference — see "Client identification" in the spec.
- **Secrets:** No credential value, token, prompt, or response body is ever written to a log line or a test fixture. Fixtures use synthetic tokens of the form `test-token-<n>`.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). One commit per task minimum, at the step marked Commit.
- **Test command:** `bun test` from the repo root runs everything. Individual files: `bun test <path>`.

---

## File Structure

```
omnigateway/
  package.json                       workspace root
  biome.json
  tsconfig.base.json
  packages/
    ir/
      package.json
      src/
        index.ts                     re-exports
        request.ts                   ChatRequest, Message, ContentBlock, ToolDef
        stream.ts                    StreamEvent, deltas, ErrorCode
        errors.ts                    GatewayError classes, ErrorCode enum
        validate.ts                  boundary invariants
      test/
        validate.test.ts
    store/
      package.json
      src/
        index.ts
        types.ts                     domain types + repo interfaces
        encryption.ts                AES-256-GCM field encryption
        sqlite/
          db.ts                      connection, WAL, migration runner
          migrations/001_init.sql
          credentials.ts             CredentialRepo impl
          config.ts                  ConfigRepo impl
          keys.ts                    KeyRepo impl
          usage.ts                   UsageRepo impl
      test/
        encryption.test.ts
        credentials.test.ts
        migrations.test.ts
    providers/
      package.json
      src/
        index.ts
        types.ts                     ProviderAdapter interface
        sse.ts                       shared SSE line parser
        anthropic/
          adapter.ts
          toWire.ts                  IR -> Anthropic body
          fromWire.ts                Anthropic SSE -> StreamEvent
          errors.ts                  status/body -> ErrorCode
        openai/
          adapter.ts
          toWire.ts
          fromWire.ts
          errors.ts
        kimi/
          adapter.ts                 reuses anthropic wire, own base URL + headers
      test/
        fixtures/                    recorded SSE transcripts
        anthropic.test.ts
        openai.test.ts
        kimi.test.ts
  apps/
    gateway/
      package.json
      src/
        index.ts                     entrypoint, CLI flags, boot sequence
        config.ts                    env parsing, encryption key check
        ingress/
          anthropic.ts               POST /v1/messages -> ChatRequest
          openai.ts                  POST /v1/chat/completions -> ChatRequest
          schemas.ts                 Zod schemas for both wire formats
        egress/
          anthropic.ts               StreamEvent -> Anthropic SSE / JSON
          openai.ts                  StreamEvent -> OpenAI SSE / JSON
        router/
          index.ts                   rank()
          resolve.ts                 virtual model + alias resolution
          filters.ts                 hard exclusions
          score.ts                   scoring terms
          snapshot.ts                Snapshot type + in-memory store
          breaker.ts                 circuit breaker state machine
        dispatch/
          index.ts                   retry loop, commit point
          attempt.ts                 single attempt lifecycle
          classify.ts                error -> ErrorCode + snapshot effect
        credentials/
          oauth/
            types.ts                 OAuthProvider interface
            pkce.ts                  verifier/challenge helpers
            anthropic.ts
            openai.ts
            kimi.ts
            pending.ts               server-held pending handle store
          refresh.ts                 proactive refresh + per-credential mutex
        control/
          auth.ts                    admin session middleware
          credentials.ts             /admin/credentials routes
          models.ts                  /admin/models routes
          keys.ts                    /admin/keys routes
          usage.ts                   /admin/usage routes
          stream.ts                  /admin/stream websocket
        middleware/
          apiKey.ts                  gateway API key verification
        logging.ts                   structured stdout logger
      test/
        ingress.test.ts
        egress.test.ts
        router.test.ts
        dispatch.test.ts
        oauth.test.ts
        e2e/
          stub-upstream.ts
          gateway.e2e.test.ts
```

---

## Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `biome.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`
- Create: `packages/ir/package.json`, `packages/ir/tsconfig.json`, `packages/ir/src/index.ts`
- Test: `packages/ir/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `bun test`; the `@omni/ir` workspace name resolvable by later packages.

- [ ] **Step 1: Create the workspace root**

`package.json`:

```json
{
  "name": "omnigateway",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "bun test",
    "lint": "biome check .",
    "fmt": "biome format --write .",
    "typecheck": "tsc -b --pretty false"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.6",
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "lib": ["ESNext"]
  }
}
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.6/schema.json",
  "files": { "includes": ["**/*.ts", "**/*.tsx", "**/*.json"] },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noExplicitAny": "error" },
      "correctness": { "noUnusedImports": "error" }
    }
  }
}
```

`.gitignore`:

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
.env
.env.local
```

`.env.example`:

```
# Required. 32 random bytes, base64.
# Generate: bun -e "console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))"
STORAGE_ENCRYPTION_KEY=

# Optional, defaults shown.
OMNI_HOST=127.0.0.1
OMNI_PORT=8787
OMNI_DB_PATH=./omnigateway.db
OMNI_LOG_LEVEL=info
```

- [ ] **Step 2: Create the ir package skeleton**

`packages/ir/package.json`:

```json
{
  "name": "@omni/ir",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "exports": { ".": "./src/index.ts" }
}
```

`packages/ir/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "test"]
}
```

`packages/ir/src/index.ts`:

```ts
export const IR_VERSION = 1;
```

- [ ] **Step 3: Write a smoke test**

`packages/ir/test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";
import { IR_VERSION } from "../src/index.ts";

test("workspace resolves the ir package", () => {
  expect(IR_VERSION).toBe(1);
});
```

- [ ] **Step 4: Install and verify**

Run: `bun install && bun test`
Expected: 1 pass, 0 fail.

Run: `bun run typecheck`
Expected: exit 0, no output.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold bun workspace with ir package"
```

---

## Task 2: IR request types and boundary validation

**Files:**
- Create: `packages/ir/src/request.ts`, `packages/ir/src/errors.ts`, `packages/ir/src/validate.ts`
- Modify: `packages/ir/src/index.ts`
- Test: `packages/ir/test/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatRequest`, `Message`, `ContentBlock`, `ToolDef`, `ToolChoice`, `ProviderId`, `ErrorCode`, `GatewayError`, `RETRYABLE`, `HTTP_STATUS`, and `validate(req: ChatRequest): ChatRequest`. Nearly every later task depends on these names.

- [ ] **Step 1: Write the failing test**

`packages/ir/test/validate.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ChatRequest } from "../src/request.ts";
import { validate } from "../src/validate.ts";

const base = (messages: ChatRequest["messages"]): ChatRequest => ({
  model: "m",
  messages,
  stream: false,
});

test("drops toolResult blocks with no matching toolUse", () => {
  const out = validate(
    base([
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "ghost", content: [{ type: "text", text: "x" }] },
          { type: "text", text: "keep me" },
        ],
      },
    ]),
  );
  expect(out.messages[0]?.content).toEqual([{ type: "text", text: "keep me" }]);
});

test("keeps toolResult blocks whose toolUse appeared earlier", () => {
  const out = validate(
    base([
      { role: "assistant", content: [{ type: "toolUse", id: "t1", name: "f", input: {} }] },
      {
        role: "user",
        content: [{ type: "toolResult", toolUseId: "t1", content: [{ type: "text", text: "ok" }] }],
      },
    ]),
  );
  expect(out.messages[1]?.content).toHaveLength(1);
});

test("synthesizes ids for toolUse blocks that lack them", () => {
  const out = validate(
    base([{ role: "assistant", content: [{ type: "toolUse", id: "", name: "f", input: {} }] }]),
  );
  const block = out.messages[0]?.content[0];
  expect(block?.type).toBe("toolUse");
  expect(block?.type === "toolUse" && block.id.length > 0).toBe(true);
});

test("merges adjacent messages that share a role", () => {
  const out = validate(
    base([
      { role: "user", content: [{ type: "text", text: "a" }] },
      { role: "user", content: [{ type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "c" }] },
    ]),
  );
  expect(out.messages).toHaveLength(2);
  expect(out.messages[0]?.content).toHaveLength(2);
});

test("drops messages left empty after filtering", () => {
  const out = validate(
    base([
      { role: "user", content: [{ type: "toolResult", toolUseId: "ghost", content: [] }] },
      { role: "user", content: [{ type: "text", text: "real" }] },
    ]),
  );
  expect(out.messages).toHaveLength(1);
  expect(out.messages[0]?.content).toEqual([{ type: "text", text: "real" }]);
});

test("does not mutate the input request", () => {
  const input = base([
    { role: "user", content: [{ type: "text", text: "a" }] },
    { role: "user", content: [{ type: "text", text: "b" }] },
  ]);
  validate(input);
  expect(input.messages).toHaveLength(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/ir/test/validate.test.ts`
Expected: FAIL — cannot resolve `../src/validate.ts`.

- [ ] **Step 3: Write the request types**

`packages/ir/src/request.ts`:

```ts
export type ProviderId = "anthropic" | "openai" | "kimi";

export type TextBlock = { type: "text"; text: string; cacheBreakpoint?: boolean };
export type ImageBlock = { type: "image"; mediaType: string; data: string };
export type ThinkingBlock = { type: "thinking"; text: string; signature?: string };
export type ToolUseBlock = { type: "toolUse"; id: string; name: string; input: unknown };
export type ToolResultBlock = {
  type: "toolResult";
  toolUseId: string;
  content: ContentBlock[];
  isError?: boolean;
};

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export type Message = { role: "user" | "assistant"; content: ContentBlock[] };

export type ToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type ToolChoice = "auto" | "none" | "required" | { name: string };

export type ReasoningConfig = { effort: "low" | "medium" | "high"; budgetTokens?: number };

export type ChatRequest = {
  model: string;
  system?: ContentBlock[];
  messages: Message[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  stream: boolean;
  reasoning?: ReasoningConfig;
  vendor?: Partial<Record<ProviderId, Record<string, unknown>>>;
};
```

- [ ] **Step 4: Write the error types**

`packages/ir/src/errors.ts`:

```ts
export type ErrorCode =
  | "RATE_LIMIT"
  | "QUOTA_EXHAUSTED"
  | "AUTH_FAILED"
  | "UPSTREAM_5XX"
  | "TIMEOUT"
  | "CAPABILITY_MISMATCH"
  | "BAD_REQUEST"
  | "CONTENT_FILTER"
  | "NO_CANDIDATES"
  | "ALL_CANDIDATES_FAILED"
  | "INTERNAL";

/** Whether dispatch should advance to the next candidate. */
export const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = {
  RATE_LIMIT: true,
  QUOTA_EXHAUSTED: true,
  AUTH_FAILED: true,
  UPSTREAM_5XX: true,
  TIMEOUT: true,
  CAPABILITY_MISMATCH: true,
  BAD_REQUEST: false,
  CONTENT_FILTER: false,
  NO_CANDIDATES: false,
  ALL_CANDIDATES_FAILED: false,
  INTERNAL: false,
};

/** HTTP status the client sees. */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  RATE_LIMIT: 429,
  QUOTA_EXHAUSTED: 429,
  AUTH_FAILED: 502,
  UPSTREAM_5XX: 502,
  TIMEOUT: 504,
  CAPABILITY_MISMATCH: 400,
  BAD_REQUEST: 400,
  CONTENT_FILTER: 400,
  NO_CANDIDATES: 503,
  ALL_CANDIDATES_FAILED: 503,
  INTERNAL: 500,
};

export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  /** Seconds, when the upstream sent a Retry-After header. */
  readonly retryAfterSec: number | undefined;

  constructor(code: ErrorCode, message: string, opts?: { retryAfterSec?: number; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "GatewayError";
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.status = HTTP_STATUS[code];
    this.retryAfterSec = opts?.retryAfterSec;
  }
}
```

- [ ] **Step 5: Write the validator**

`packages/ir/src/validate.ts`:

```ts
import type { ChatRequest, ContentBlock, Message } from "./request.ts";

/**
 * Enforces the IR boundary invariants once, at ingress, so no downstream module
 * has to defend against malformed tool sequences. Returns a new request.
 */
export function validate(req: ChatRequest): ChatRequest {
  const seenToolUseIds = new Set<string>();
  const cleaned: Message[] = [];

  for (const message of req.messages) {
    const content: ContentBlock[] = [];

    for (const block of message.content) {
      if (block.type === "toolUse") {
        const id = block.id.length > 0 ? block.id : `tu_${crypto.randomUUID()}`;
        seenToolUseIds.add(id);
        content.push({ ...block, id });
        continue;
      }
      // Orphaned tool results make providers reject the whole request.
      if (block.type === "toolResult" && !seenToolUseIds.has(block.toolUseId)) continue;
      content.push(block);
    }

    if (content.length === 0) continue;

    const prev = cleaned.at(-1);
    if (prev && prev.role === message.role) {
      prev.content = [...prev.content, ...content];
    } else {
      cleaned.push({ role: message.role, content });
    }
  }

  return { ...req, messages: cleaned };
}
```

- [ ] **Step 6: Export from the package index**

`packages/ir/src/index.ts`:

```ts
export const IR_VERSION = 1;

export * from "./request.ts";
export * from "./errors.ts";
export * from "./validate.ts";
```

- [ ] **Step 7: Run the tests**

Run: `bun test packages/ir`
Expected: 7 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add packages/ir
git commit -m "feat(ir): add request types and boundary validation"
```

---

## Task 3: IR stream events and collector

**Files:**
- Create: `packages/ir/src/stream.ts`
- Modify: `packages/ir/src/index.ts`
- Test: `packages/ir/test/stream.test.ts`

**Interfaces:**
- Consumes: `ContentBlock` (Task 2), `ErrorCode` (Task 2).
- Produces: `StreamEvent`, `Delta`, `ContentBlockStart`, `StopReason`, `Usage`, `CollectedResponse`, `collect(events): CollectedResponse`. Adapters emit `StreamEvent`; egress consumes it; dispatch uses `collect` for non-streaming requests.

- [ ] **Step 1: Write the failing test**

`packages/ir/test/stream.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { StreamEvent } from "../src/stream.ts";
import { collect } from "../src/stream.ts";

test("collect assembles text deltas into one block", () => {
  const events: StreamEvent[] = [
    { type: "start", id: "msg_1", model: "claude-opus-4" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "lo" } },
    { type: "blockEnd", index: 0 },
    { type: "usage", input: 10, output: 2 },
    { type: "end", stopReason: "stop" },
  ];
  const r = collect(events);
  expect(r.content).toEqual([{ type: "text", text: "Hello" }]);
  expect(r.stopReason).toBe("stop");
  expect(r.usage).toEqual({ input: 10, output: 2 });
  expect(r.id).toBe("msg_1");
  expect(r.model).toBe("claude-opus-4");
});

test("collect assembles json deltas into toolUse input", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "toolUse", id: "t1", name: "get" } },
    { type: "blockDelta", index: 0, delta: { type: "json", partial: '{"a":' } },
    { type: "blockDelta", index: 0, delta: { type: "json", partial: "1}" } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "toolUse" },
  ]);
  expect(r.content).toEqual([{ type: "toolUse", id: "t1", name: "get", input: { a: 1 } }]);
});

test("collect preserves thinking text and signature", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "thinking" } },
    { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hmm" } },
    { type: "blockDelta", index: 0, delta: { type: "signature", signature: "sig123" } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "stop" },
  ]);
  expect(r.content).toEqual([{ type: "thinking", text: "hmm", signature: "sig123" }]);
});

test("collect orders blocks by index, not arrival", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockStart", index: 1, block: { type: "text" } },
    { type: "blockDelta", index: 1, delta: { type: "text", text: "second" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text: "first" } },
    { type: "end", stopReason: "stop" },
  ]);
  expect(r.content).toEqual([
    { type: "text", text: "first" },
    { type: "text", text: "second" },
  ]);
});

test("collect tolerates truncated tool json", () => {
  const r = collect([
    { type: "start", id: "m", model: "x" },
    { type: "blockStart", index: 0, block: { type: "toolUse", id: "t1", name: "get" } },
    { type: "blockDelta", index: 0, delta: { type: "json", partial: "{not json" } },
    { type: "end", stopReason: "toolUse" },
  ]);
  expect(r.content).toEqual([{ type: "toolUse", id: "t1", name: "get", input: {} }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/ir/test/stream.test.ts`
Expected: FAIL — cannot resolve `../src/stream.ts`.

- [ ] **Step 3: Write the stream types and collector**

`packages/ir/src/stream.ts`:

```ts
import type { ErrorCode } from "./errors.ts";
import type { ContentBlock } from "./request.ts";

export type StopReason = "stop" | "maxTokens" | "toolUse" | "stopSequence";

export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export type ContentBlockStart =
  | { type: "text" }
  | { type: "thinking" }
  | { type: "toolUse"; id: string; name: string };

export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "signature"; signature: string }
  | { type: "json"; partial: string };

export type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "blockStart"; index: number; block: ContentBlockStart }
  | { type: "blockDelta"; index: number; delta: Delta }
  | { type: "blockEnd"; index: number }
  | { type: "usage"; input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | { type: "end"; stopReason: StopReason }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };

export type CollectedResponse = {
  id: string;
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
};

type Accum =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "toolUse"; id: string; name: string; json: string };

/**
 * Folds a canonical event stream into a single response. The gateway always
 * streams from the upstream, so non-streaming client requests collapse here
 * rather than taking a separate code path.
 */
export function collect(events: Iterable<StreamEvent>): CollectedResponse {
  let id = "";
  let model = "";
  let stopReason: StopReason = "stop";
  let usage: Usage = { input: 0, output: 0 };
  const blocks = new Map<number, Accum>();

  for (const ev of events) {
    switch (ev.type) {
      case "start":
        id = ev.id;
        model = ev.model;
        break;
      case "blockStart":
        blocks.set(
          ev.index,
          ev.block.type === "toolUse"
            ? { kind: "toolUse", id: ev.block.id, name: ev.block.name, json: "" }
            : ev.block.type === "thinking"
              ? { kind: "thinking", text: "" }
              : { kind: "text", text: "" },
        );
        break;
      case "blockDelta": {
        const acc = blocks.get(ev.index);
        if (!acc) break;
        if (ev.delta.type === "text" && acc.kind === "text") acc.text += ev.delta.text;
        else if (ev.delta.type === "thinking" && acc.kind === "thinking") acc.text += ev.delta.text;
        else if (ev.delta.type === "signature" && acc.kind === "thinking")
          acc.signature = ev.delta.signature;
        else if (ev.delta.type === "json" && acc.kind === "toolUse") acc.json += ev.delta.partial;
        break;
      }
      case "usage":
        usage = {
          input: ev.input,
          output: ev.output,
          ...(ev.cacheRead === undefined ? {} : { cacheRead: ev.cacheRead }),
          ...(ev.cacheWrite === undefined ? {} : { cacheWrite: ev.cacheWrite }),
        };
        break;
      case "end":
        stopReason = ev.stopReason;
        break;
      default:
        break;
    }
  }

  const content: ContentBlock[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]): ContentBlock => {
      if (acc.kind === "text") return { type: "text", text: acc.text };
      if (acc.kind === "thinking")
        return {
          type: "thinking",
          text: acc.text,
          ...(acc.signature === undefined ? {} : { signature: acc.signature }),
        };
      return { type: "toolUse", id: acc.id, name: acc.name, input: parseJson(acc.json) };
    });

  return { id, model, content, stopReason, usage };
}

/** Tool arguments arrive in fragments; a truncated stream must not throw. */
function parseJson(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Export from the index**

Append to `packages/ir/src/index.ts`:

```ts
export * from "./stream.ts";
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/ir`
Expected: 12 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/ir
git commit -m "feat(ir): add canonical stream events and collector"
```

---

## Task 4: Field encryption

**Files:**
- Create: `packages/store/package.json`, `packages/store/tsconfig.json`, `packages/store/src/encryption.ts`
- Test: `packages/store/test/encryption.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `deriveKey(secret: string): Promise<CryptoKey>`, `encrypt(key: CryptoKey, plaintext: string): Promise<string>`, `decrypt(key: CryptoKey, value: string): Promise<string>`, `isEncrypted(value: string): boolean`. Task 6 applies these to credential token columns.

- [ ] **Step 1: Write the failing test**

`packages/store/test/encryption.test.ts`:

```ts
import { expect, test } from "bun:test";
import { decrypt, deriveKey, encrypt, isEncrypted } from "../src/encryption.ts";

const SECRET = "test-secret-not-a-real-key-0123456789";

test("round-trips a value", async () => {
  const key = await deriveKey(SECRET);
  expect(await decrypt(key, await encrypt(key, "test-token-1"))).toBe("test-token-1");
});

test("ciphertext carries the versioned prefix and hides the plaintext", async () => {
  const key = await deriveKey(SECRET);
  const ct = await encrypt(key, "test-token-2");
  expect(ct.startsWith("enc:v1:")).toBe(true);
  expect(ct).not.toContain("test-token-2");
  expect(ct.split(":")).toHaveLength(5);
});

test("encrypting the same plaintext twice yields different ciphertext", async () => {
  const key = await deriveKey(SECRET);
  expect(await encrypt(key, "same")).not.toBe(await encrypt(key, "same"));
});

test("decrypting with the wrong key throws", async () => {
  const a = await deriveKey(SECRET);
  const b = await deriveKey("a-completely-different-secret-value");
  const ct = await encrypt(a, "value");
  expect(decrypt(b, ct)).rejects.toThrow();
});

test("a tampered auth tag is rejected", async () => {
  const key = await deriveKey(SECRET);
  const parts = (await encrypt(key, "value")).split(":");
  parts[4] = parts[4] === "00".repeat(16) ? "11".repeat(16) : "00".repeat(16);
  expect(decrypt(key, parts.join(":"))).rejects.toThrow();
});

test("malformed ciphertext is rejected", async () => {
  const key = await deriveKey(SECRET);
  expect(decrypt(key, "not-ciphertext")).rejects.toThrow("malformed ciphertext");
});

test("isEncrypted distinguishes ciphertext from plaintext", async () => {
  const key = await deriveKey(SECRET);
  expect(isEncrypted(await encrypt(key, "x"))).toBe(true);
  expect(isEncrypted("sk-plain-value")).toBe(false);
  expect(isEncrypted("")).toBe(false);
});

test("round-trips empty and multi-byte values", async () => {
  const key = await deriveKey(SECRET);
  expect(await decrypt(key, await encrypt(key, ""))).toBe("");
  expect(await decrypt(key, await encrypt(key, "日本語 🎉"))).toBe("日本語 🎉");
});
```

- [ ] **Step 2: Create the package, then run the test to see it fail**

`packages/store/package.json`:

```json
{
  "name": "@omni/store",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@omni/ir": "workspace:*" }
}
```

`packages/store/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "test"]
}
```

Run: `bun install && bun test packages/store/test/encryption.test.ts`
Expected: FAIL — cannot resolve `../src/encryption.ts`.

- [ ] **Step 3: Implement encryption**

`packages/store/src/encryption.ts`:

```ts
const PREFIX = "enc:v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KDF_SALT = new TextEncoder().encode("omnigateway-field-encryption-v1");

/**
 * Derives the AES-256-GCM field key from the operator's secret.
 *
 * PBKDF2 rather than scrypt because WebCrypto provides it natively. The input
 * is a high-entropy generated secret rather than a chosen password, so the
 * iteration count is defence in depth, not the primary barrier.
 */
export async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: KDF_SALT, iterations: 210_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Returns `enc:v1:<iv-hex>:<ciphertext-hex>:<tag-hex>`. */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  return [PREFIX, hex(iv), hex(body), hex(tag)].join(":");
}

export async function decrypt(key: CryptoKey, value: string): Promise<string> {
  const parts = value.split(":");
  const [scheme, version, ivHex, bodyHex, tagHex] = parts;
  if (parts.length !== 5 || scheme !== "enc" || version !== "v1" || !ivHex || !tagHex) {
    throw new Error("malformed ciphertext");
  }
  const sealed = new Uint8Array([...unhex(bodyHex ?? ""), ...unhex(tagHex)]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unhex(ivHex), tagLength: TAG_BYTES * 8 },
    key,
    sealed,
  );
  return new TextDecoder().decode(plain);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/store/test/encryption.test.ts`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/store
git commit -m "feat(store): add AES-256-GCM field encryption"
```

---

## Task 5: Domain types, repository interfaces, and schema

**Files:**
- Create: `packages/store/src/types.ts`, `packages/store/src/sqlite/migrations/001_init.sql`, `packages/store/src/sqlite/db.ts`, `packages/store/src/index.ts`
- Test: `packages/store/test/migrations.test.ts`

**Interfaces:**
- Consumes: `ProviderId` (Task 2).
- Produces: `Credential`, `CredentialHealth`, `BreakerState`, `QuotaWindow`, `VirtualModel`, `Target`, `ApiKey`, `RequestLog`, `Store`, `CredentialRepo`, `ConfigRepo`, `KeyRepo`, `UsageRepo`, and `openDb(path: string): Database`. Tasks 6, 7, 13, 14, 16, 18, 19 all consume these.

- [ ] **Step 1: Write the failing test**

`packages/store/test/migrations.test.ts`:

```ts
import { expect, test } from "bun:test";
import { openDb } from "../src/sqlite/db.ts";

type TableRow = { name: string };

test("openDb applies migrations and records them", () => {
  const db = openDb(":memory:");
  const tables = db
    .query<TableRow, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);

  for (const t of [
    "api_keys",
    "credential_health",
    "credentials",
    "migrations",
    "quota_windows",
    "request_logs",
    "settings",
    "virtual_models",
  ]) {
    expect(tables).toContain(t);
  }

  const applied = db.query<{ id: number }, []>("SELECT id FROM migrations").all();
  expect(applied).toHaveLength(1);
  db.close();
});

test("openDb is idempotent across reopen", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  openDb(path).close();
  const db = openDb(path);
  expect(db.query<{ id: number }, []>("SELECT id FROM migrations").all()).toHaveLength(1);
  db.close();
});

test("WAL mode is enabled", () => {
  const path = `/tmp/omni-test-${crypto.randomUUID()}.db`;
  const db = openDb(path);
  const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
  expect(mode?.journal_mode).toBe("wal");
  db.close();
});

test("foreign keys cascade from credentials to health", () => {
  const db = openDb(":memory:");
  db.run(
    `INSERT INTO credentials (id, provider, label, auth_type, enabled, tier, weight, created_at, updated_at)
     VALUES ('c1', 'anthropic', 'test', 'oauth', 1, 1, 1.0, 0, 0)`,
  );
  db.run("INSERT INTO credential_health (credential_id, model, breaker_state) VALUES ('c1','m','closed')");
  db.run("DELETE FROM credentials WHERE id = 'c1'");
  const left = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM credential_health").get();
  expect(left?.n).toBe(0);
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/store/test/migrations.test.ts`
Expected: FAIL — cannot resolve `../src/sqlite/db.ts`.

- [ ] **Step 3: Write the domain types and repository interfaces**

`packages/store/src/types.ts`:

```ts
import type { ProviderId } from "@omni/ir";

export type BreakerState = "closed" | "open" | "halfOpen";
export type AuthType = "oauth" | "apiKey";
export type WindowType = "fiveHour" | "daily" | "weekly";

export type Credential = {
  id: string;
  provider: ProviderId;
  label: string;
  authType: AuthType;
  enabled: boolean;
  tier: number;
  weight: number;
  /** Milliseconds since epoch, or null when the token does not expire. */
  expiresAt: number | null;
  accountEmail: string | null;
  /** Provider-specific durable state, e.g. Kimi device identity, Codex workspace id. */
  providerData: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/** Secret material, resolved separately so ranking never decrypts. */
export type CredentialSecrets = {
  accessToken: string | null;
  refreshToken: string | null;
  apiKey: string | null;
  idToken: string | null;
};

/**
 * A credential plus a thunk for its secrets. The router reads only the
 * metadata; dispatch calls `secrets()` on the single winning candidate, so
 * ranking N candidates costs one decryption rather than N.
 */
export type CredentialView = Credential & { secrets: () => Promise<CredentialSecrets> };

export type CredentialHealth = {
  credentialId: string;
  model: string;
  breakerState: BreakerState;
  consecutiveFailures: number;
  openedAt: number | null;
  rateLimitedUntil: number | null;
  ewmaTtftMs: number | null;
  lastUsedAt: number | null;
};

export type QuotaWindow = {
  credentialId: string;
  windowType: WindowType;
  startsAt: number;
  used: number;
  /** Null means the operator configured no limit; the quota filter never excludes. */
  limit: number | null;
};

export type Target = {
  provider: ProviderId;
  model: string;
  tier: number;
  weight: number;
  costPerMTok: { input: number; output: number; cacheRead?: number };
  capabilities: { tools: boolean; images: boolean; reasoning: boolean };
};

export type Strategy = "score" | "priority" | "roundRobin" | "weighted";

export type VirtualModel = {
  id: string;
  targets: Target[];
  strategy: Strategy;
  /** True when this row was generated from an alias for a concrete model name. */
  isAlias: boolean;
};

export type ApiKey = {
  id: string;
  label: string;
  /** First 12 chars of the key, for display. Never the full key. */
  prefix: string;
  hash: string;
  modelAllowlist: string[] | null;
  rateLimitPerMin: number | null;
  createdAt: number;
  revokedAt: number | null;
};

export type RequestLog = {
  id: string;
  at: number;
  apiKeyId: string | null;
  requestedModel: string;
  resolvedProvider: ProviderId | null;
  resolvedModel: string | null;
  credentialId: string | null;
  attempts: number;
  status: number;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ttftMs: number | null;
  durationMs: number;
  costUsd: number;
  /** Capability degradations applied, e.g. ["droppedThinking"]. */
  degradations: string[];
};

export type ScoringWeights = {
  tier: number;
  health: number;
  quota: number;
  cost: number;
  latency: number;
  recency: number;
};

export type Settings = {
  weights: ScoringWeights;
  maxAttempts: number;
  requestDeadlineMs: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  logRetentionDays: number;
};

export interface CredentialRepo {
  list(): Promise<CredentialView[]>;
  get(id: string): Promise<CredentialView | null>;
  create(input: Omit<Credential, "createdAt" | "updatedAt"> & CredentialSecrets): Promise<Credential>;
  update(id: string, patch: Partial<Credential>): Promise<void>;
  updateSecrets(id: string, secrets: Partial<CredentialSecrets>, expiresAt: number | null): Promise<void>;
  remove(id: string): Promise<void>;
  listHealth(): Promise<CredentialHealth[]>;
  saveHealth(rows: CredentialHealth[]): Promise<void>;
  listQuota(): Promise<QuotaWindow[]>;
  saveQuota(rows: QuotaWindow[]): Promise<void>;
}

export interface ConfigRepo {
  listModels(): Promise<VirtualModel[]>;
  putModel(model: VirtualModel): Promise<void>;
  removeModel(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  putSettings(patch: Partial<Settings>): Promise<Settings>;
  getAdminPasswordHash(): Promise<string | null>;
  setAdminPasswordHash(hash: string): Promise<void>;
}

export interface KeyRepo {
  list(): Promise<ApiKey[]>;
  findByHash(hash: string): Promise<ApiKey | null>;
  create(input: Omit<ApiKey, "createdAt" | "revokedAt">): Promise<ApiKey>;
  revoke(id: string): Promise<void>;
}

export type UsageQuery = {
  since: number;
  until?: number;
  groupBy: "credential" | "model" | "apiKey" | "hour";
};

export type UsageBucket = {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errors: number;
};

export interface UsageRepo {
  append(log: RequestLog): Promise<void>;
  recent(limit: number): Promise<RequestLog[]>;
  aggregate(q: UsageQuery): Promise<UsageBucket[]>;
  prune(olderThan: number): Promise<number>;
}

export type Store = {
  credentials: CredentialRepo;
  config: ConfigRepo;
  keys: KeyRepo;
  usage: UsageRepo;
  close(): void;
};

export const DEFAULT_SETTINGS: Settings = {
  weights: { tier: 10, health: 3, quota: 2, cost: 1, latency: 1, recency: 0.5 },
  maxAttempts: 3,
  requestDeadlineMs: 120_000,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
  logRetentionDays: 30,
};
```

- [ ] **Step 4: Write the schema**

`packages/store/src/sqlite/migrations/001_init.sql`:

```sql
CREATE TABLE credentials (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  label          TEXT NOT NULL,
  auth_type      TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  tier           INTEGER NOT NULL DEFAULT 1,
  weight         REAL NOT NULL DEFAULT 1.0,
  expires_at     INTEGER,
  account_email  TEXT,
  provider_data  TEXT NOT NULL DEFAULT '{}',
  access_token   TEXT,
  refresh_token  TEXT,
  api_key        TEXT,
  id_token       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_credentials_provider ON credentials (provider, enabled);

CREATE TABLE credential_health (
  credential_id        TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  model                TEXT NOT NULL,
  breaker_state        TEXT NOT NULL DEFAULT 'closed',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  opened_at            INTEGER,
  rate_limited_until   INTEGER,
  ewma_ttft_ms         REAL,
  last_used_at         INTEGER,
  PRIMARY KEY (credential_id, model)
);

CREATE TABLE quota_windows (
  credential_id TEXT NOT NULL REFERENCES credentials (id) ON DELETE CASCADE,
  window_type   TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  used          INTEGER NOT NULL DEFAULT 0,
  limit_value   INTEGER,
  PRIMARY KEY (credential_id, window_type)
);

CREATE TABLE virtual_models (
  id        TEXT PRIMARY KEY,
  targets   TEXT NOT NULL,
  strategy  TEXT NOT NULL DEFAULT 'score',
  is_alias  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  prefix             TEXT NOT NULL,
  hash               TEXT NOT NULL UNIQUE,
  model_allowlist    TEXT,
  rate_limit_per_min INTEGER,
  created_at         INTEGER NOT NULL,
  revoked_at         INTEGER
);
CREATE INDEX idx_api_keys_hash ON api_keys (hash);

CREATE TABLE request_logs (
  id                 TEXT PRIMARY KEY,
  at                 INTEGER NOT NULL,
  api_key_id         TEXT,
  requested_model    TEXT NOT NULL,
  resolved_provider  TEXT,
  resolved_model     TEXT,
  credential_id      TEXT,
  attempts           INTEGER NOT NULL DEFAULT 1,
  status             INTEGER NOT NULL,
  error_code         TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  ttft_ms            INTEGER,
  duration_ms        INTEGER NOT NULL,
  cost_usd           REAL NOT NULL DEFAULT 0,
  degradations       TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_request_logs_at ON request_logs (at DESC);
CREATE INDEX idx_request_logs_cred ON request_logs (credential_id, at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 5: Write the migration runner**

`packages/store/src/sqlite/db.ts`:

```ts
import { Database } from "bun:sqlite";
import init001 from "./migrations/001_init.sql" with { type: "text" };

const MIGRATIONS: ReadonlyArray<{ id: number; sql: string }> = [{ id: 1, sql: init001 }];

/**
 * Opens the database, enables WAL and foreign keys, and applies any migrations
 * not yet recorded. Safe to call on an existing database.
 */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");

  const done = new Set(
    db.query<{ id: number }, []>("SELECT id FROM migrations").all().map((r) => r.id),
  );

  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.run(m.sql);
      db.run("INSERT INTO migrations (id, applied_at) VALUES (?, ?)", [m.id, Date.now()]);
    })();
  }

  return db;
}
```

Note: `with { type: "text" }` is Bun's import attribute for reading a file as a
string at build time. It keeps the SQL in a real `.sql` file (syntax
highlighting, diffable) while still bundling.

- [ ] **Step 6: Write the package index**

`packages/store/src/index.ts`:

```ts
export * from "./types.ts";
export * from "./encryption.ts";
export { openDb } from "./sqlite/db.ts";
```

- [ ] **Step 7: Run the tests**

Run: `bun test packages/store`
Expected: 12 pass (8 encryption + 4 migrations), 0 fail.

- [ ] **Step 8: Commit**

```bash
git add packages/store
git commit -m "feat(store): add domain types, repo interfaces, and schema"
```

---

## Task 6: SQLite credential repository

**Files:**
- Create: `packages/store/src/sqlite/credentials.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/test/credentials.test.ts`

**Interfaces:**
- Consumes: `CredentialRepo`, `CredentialView`, `CredentialSecrets`, `CredentialHealth`, `QuotaWindow` (Task 5); `encrypt`, `decrypt` (Task 4); `openDb` (Task 5).
- Produces: `createCredentialRepo(db: Database, key: CryptoKey): CredentialRepo`.

- [ ] **Step 1: Write the failing test**

`packages/store/test/credentials.test.ts`:

```ts
import { expect, test } from "bun:test";
import { deriveKey } from "../src/encryption.ts";
import { createCredentialRepo } from "../src/sqlite/credentials.ts";
import { openDb } from "../src/sqlite/db.ts";

async function setup() {
  const db = openDb(":memory:");
  const repo = createCredentialRepo(db, await deriveKey("test-secret-value-for-unit-tests"));
  return { db, repo };
}

const input = {
  id: "c1",
  provider: "anthropic" as const,
  label: "personal",
  authType: "oauth" as const,
  enabled: true,
  tier: 1,
  weight: 1,
  expiresAt: 1000,
  accountEmail: "a@example.com",
  providerData: { deviceId: "d1" },
  accessToken: "test-token-1",
  refreshToken: "test-token-2",
  apiKey: null,
  idToken: null,
};

test("create then get round-trips metadata", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  const got = await repo.get("c1");
  expect(got?.label).toBe("personal");
  expect(got?.provider).toBe("anthropic");
  expect(got?.providerData).toEqual({ deviceId: "d1" });
  expect(got?.enabled).toBe(true);
  db.close();
});

test("tokens are encrypted at rest but decrypt through the thunk", async () => {
  const { repo, db } = await setup();
  await repo.create(input);

  const raw = db
    .query<{ access_token: string }, []>("SELECT access_token FROM credentials WHERE id='c1'")
    .get();
  expect(raw?.access_token.startsWith("enc:v1:")).toBe(true);
  expect(raw?.access_token).not.toContain("test-token-1");

  const secrets = await (await repo.get("c1"))?.secrets();
  expect(secrets?.accessToken).toBe("test-token-1");
  expect(secrets?.refreshToken).toBe("test-token-2");
  expect(secrets?.apiKey).toBeNull();
  db.close();
});

test("list returns metadata without decrypting", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.create({ ...input, id: "c2", label: "work" });
  const all = await repo.list();
  expect(all).toHaveLength(2);
  expect(all.map((c) => c.label).sort()).toEqual(["personal", "work"]);
  db.close();
});

test("update patches only the given fields", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.update("c1", { tier: 2, enabled: false });
  const got = await repo.get("c1");
  expect(got?.tier).toBe(2);
  expect(got?.enabled).toBe(false);
  expect(got?.label).toBe("personal");
  db.close();
});

test("updateSecrets replaces tokens and expiry", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.updateSecrets("c1", { accessToken: "test-token-9" }, 5000);
  const got = await repo.get("c1");
  expect(got?.expiresAt).toBe(5000);
  const secrets = await got?.secrets();
  expect(secrets?.accessToken).toBe("test-token-9");
  expect(secrets?.refreshToken).toBe("test-token-2");
  db.close();
});

test("health and quota rows round-trip", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.saveHealth([
    {
      credentialId: "c1",
      model: "claude-opus-4",
      breakerState: "open",
      consecutiveFailures: 3,
      openedAt: 111,
      rateLimitedUntil: 222,
      ewmaTtftMs: 350,
      lastUsedAt: 333,
    },
  ]);
  const health = await repo.listHealth();
  expect(health[0]?.breakerState).toBe("open");
  expect(health[0]?.ewmaTtftMs).toBe(350);

  await repo.saveQuota([
    { credentialId: "c1", windowType: "fiveHour", startsAt: 10, used: 5, limit: 100 },
  ]);
  const quota = await repo.listQuota();
  expect(quota[0]?.used).toBe(5);
  expect(quota[0]?.limit).toBe(100);
  db.close();
});

test("saveHealth upserts rather than duplicating", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  const row = {
    credentialId: "c1",
    model: "m",
    breakerState: "closed" as const,
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
  };
  await repo.saveHealth([row]);
  await repo.saveHealth([{ ...row, consecutiveFailures: 2 }]);
  const health = await repo.listHealth();
  expect(health).toHaveLength(1);
  expect(health[0]?.consecutiveFailures).toBe(2);
  db.close();
});

test("remove deletes the credential", async () => {
  const { repo, db } = await setup();
  await repo.create(input);
  await repo.remove("c1");
  expect(await repo.get("c1")).toBeNull();
  db.close();
});

test("get returns null for an unknown id", async () => {
  const { repo, db } = await setup();
  expect(await repo.get("nope")).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/store/test/credentials.test.ts`
Expected: FAIL — cannot resolve `../src/sqlite/credentials.ts`.

- [ ] **Step 3: Implement the repository**

`packages/store/src/sqlite/credentials.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { ProviderId } from "@omni/ir";
import { decrypt, encrypt } from "../encryption.ts";
import type {
  AuthType,
  BreakerState,
  Credential,
  CredentialHealth,
  CredentialRepo,
  CredentialSecrets,
  CredentialView,
  QuotaWindow,
  WindowType,
} from "../types.ts";

type Row = {
  id: string;
  provider: string;
  label: string;
  auth_type: string;
  enabled: number;
  tier: number;
  weight: number;
  expires_at: number | null;
  account_email: string | null;
  provider_data: string;
  access_token: string | null;
  refresh_token: string | null;
  api_key: string | null;
  id_token: string | null;
  created_at: number;
  updated_at: number;
};

export function createCredentialRepo(db: Database, key: CryptoKey): CredentialRepo {
  /** Decrypts lazily, so ranking N candidates costs zero decryptions. */
  const view = (row: Row): CredentialView => ({
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    authType: row.auth_type as AuthType,
    enabled: row.enabled === 1,
    tier: row.tier,
    weight: row.weight,
    expiresAt: row.expires_at,
    accountEmail: row.account_email,
    providerData: JSON.parse(row.provider_data) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    secrets: async (): Promise<CredentialSecrets> => ({
      accessToken: await open(row.access_token),
      refreshToken: await open(row.refresh_token),
      apiKey: await open(row.api_key),
      idToken: await open(row.id_token),
    }),
  });

  const open = async (v: string | null): Promise<string | null> =>
    v === null ? null : decrypt(key, v);
  const seal = async (v: string | null | undefined): Promise<string | null> =>
    v === null || v === undefined ? null : encrypt(key, v);

  return {
    async list() {
      return db.query<Row, []>("SELECT * FROM credentials ORDER BY tier, label").all().map(view);
    },

    async get(id) {
      const row = db.query<Row, [string]>("SELECT * FROM credentials WHERE id = ?").get(id);
      return row ? view(row) : null;
    },

    async create(input) {
      const now = Date.now();
      db.run(
        `INSERT INTO credentials
           (id, provider, label, auth_type, enabled, tier, weight, expires_at, account_email,
            provider_data, access_token, refresh_token, api_key, id_token, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.id,
          input.provider,
          input.label,
          input.authType,
          input.enabled ? 1 : 0,
          input.tier,
          input.weight,
          input.expiresAt,
          input.accountEmail,
          JSON.stringify(input.providerData),
          await seal(input.accessToken),
          await seal(input.refreshToken),
          await seal(input.apiKey),
          await seal(input.idToken),
          now,
          now,
        ],
      );
      const { accessToken, refreshToken, apiKey, idToken, ...meta } = input;
      return { ...meta, createdAt: now, updatedAt: now } satisfies Credential;
    },

    async update(id, patch) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      const put = (col: string, v: string | number | null) => {
        sets.push(`${col} = ?`);
        vals.push(v);
      };
      if (patch.label !== undefined) put("label", patch.label);
      if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
      if (patch.tier !== undefined) put("tier", patch.tier);
      if (patch.weight !== undefined) put("weight", patch.weight);
      if (patch.expiresAt !== undefined) put("expires_at", patch.expiresAt);
      if (patch.accountEmail !== undefined) put("account_email", patch.accountEmail);
      if (patch.providerData !== undefined)
        put("provider_data", JSON.stringify(patch.providerData));
      if (sets.length === 0) return;
      put("updated_at", Date.now());
      db.run(`UPDATE credentials SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
    },

    async updateSecrets(id, secrets, expiresAt) {
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      if (secrets.accessToken !== undefined) {
        sets.push("access_token = ?");
        vals.push(await seal(secrets.accessToken));
      }
      if (secrets.refreshToken !== undefined) {
        sets.push("refresh_token = ?");
        vals.push(await seal(secrets.refreshToken));
      }
      if (secrets.apiKey !== undefined) {
        sets.push("api_key = ?");
        vals.push(await seal(secrets.apiKey));
      }
      if (secrets.idToken !== undefined) {
        sets.push("id_token = ?");
        vals.push(await seal(secrets.idToken));
      }
      sets.push("expires_at = ?", "updated_at = ?");
      vals.push(expiresAt, Date.now());
      db.run(`UPDATE credentials SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
    },

    async remove(id) {
      db.run("DELETE FROM credentials WHERE id = ?", [id]);
    },

    async listHealth() {
      type H = {
        credential_id: string;
        model: string;
        breaker_state: string;
        consecutive_failures: number;
        opened_at: number | null;
        rate_limited_until: number | null;
        ewma_ttft_ms: number | null;
        last_used_at: number | null;
      };
      return db
        .query<H, []>("SELECT * FROM credential_health")
        .all()
        .map((r) => ({
          credentialId: r.credential_id,
          model: r.model,
          breakerState: r.breaker_state as BreakerState,
          consecutiveFailures: r.consecutive_failures,
          openedAt: r.opened_at,
          rateLimitedUntil: r.rate_limited_until,
          ewmaTtftMs: r.ewma_ttft_ms,
          lastUsedAt: r.last_used_at,
        }));
    },

    async saveHealth(rows: CredentialHealth[]) {
      const stmt = db.prepare(
        `INSERT INTO credential_health
           (credential_id, model, breaker_state, consecutive_failures, opened_at,
            rate_limited_until, ewma_ttft_ms, last_used_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (credential_id, model) DO UPDATE SET
           breaker_state = excluded.breaker_state,
           consecutive_failures = excluded.consecutive_failures,
           opened_at = excluded.opened_at,
           rate_limited_until = excluded.rate_limited_until,
           ewma_ttft_ms = excluded.ewma_ttft_ms,
           last_used_at = excluded.last_used_at`,
      );
      db.transaction(() => {
        for (const r of rows) {
          stmt.run(
            r.credentialId,
            r.model,
            r.breakerState,
            r.consecutiveFailures,
            r.openedAt,
            r.rateLimitedUntil,
            r.ewmaTtftMs,
            r.lastUsedAt,
          );
        }
      })();
    },

    async listQuota() {
      type Q = {
        credential_id: string;
        window_type: string;
        starts_at: number;
        used: number;
        limit_value: number | null;
      };
      return db
        .query<Q, []>("SELECT * FROM quota_windows")
        .all()
        .map((r) => ({
          credentialId: r.credential_id,
          windowType: r.window_type as WindowType,
          startsAt: r.starts_at,
          used: r.used,
          limit: r.limit_value,
        }));
    },

    async saveQuota(rows: QuotaWindow[]) {
      const stmt = db.prepare(
        `INSERT INTO quota_windows (credential_id, window_type, starts_at, used, limit_value)
         VALUES (?,?,?,?,?)
         ON CONFLICT (credential_id, window_type) DO UPDATE SET
           starts_at = excluded.starts_at,
           used = excluded.used,
           limit_value = excluded.limit_value`,
      );
      db.transaction(() => {
        for (const r of rows) {
          stmt.run(r.credentialId, r.windowType, r.startsAt, r.used, r.limit);
        }
      })();
    },
  };
}
```

- [ ] **Step 4: Export it**

Add to `packages/store/src/index.ts`:

```ts
export { createCredentialRepo } from "./sqlite/credentials.ts";
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/store`
Expected: 21 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add packages/store
git commit -m "feat(store): add sqlite credential repository with lazy decryption"
```

---
