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
  /**
   * Derived at read time, never written. Lets the router decide whether an
   * expired credential can be revived without decrypting anything.
   */
  hasRefreshToken: boolean;
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
  create(
    input: Omit<Credential, "createdAt" | "updatedAt" | "hasRefreshToken"> & CredentialSecrets,
  ): Promise<Credential>;
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
    hasRefreshToken: row.refresh_token !== null,
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

## Task 7: Config, key, and usage repositories

**Files:**
- Create: `packages/store/src/sqlite/config.ts`, `packages/store/src/sqlite/keys.ts`, `packages/store/src/sqlite/usage.ts`, `packages/store/src/sqlite/store.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/test/repos.test.ts`

**Interfaces:**
- Consumes: `ConfigRepo`, `KeyRepo`, `UsageRepo`, `Store`, `DEFAULT_SETTINGS` (Task 5).
- Produces: `createStore(opts: { path: string; encryptionKey: CryptoKey }): Promise<Store>` — the single entry point every consumer uses. Also `hashApiKey(raw: string): Promise<string>` and `generateApiKey(): string`.

- [ ] **Step 1: Write the failing test**

`packages/store/test/repos.test.ts`:

```ts
import { expect, test } from "bun:test";
import { deriveKey } from "../src/encryption.ts";
import { generateApiKey, hashApiKey } from "../src/sqlite/keys.ts";
import { createStore } from "../src/sqlite/store.ts";
import type { Store } from "../src/types.ts";

async function store(): Promise<Store> {
  return createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
}

test("settings return defaults then persist patches", async () => {
  const s = await store();
  const defaults = await s.config.getSettings();
  expect(defaults.maxAttempts).toBe(3);
  expect(defaults.weights.tier).toBe(10);

  const patched = await s.config.putSettings({ maxAttempts: 5 });
  expect(patched.maxAttempts).toBe(5);
  expect(patched.weights.tier).toBe(10);
  expect((await s.config.getSettings()).maxAttempts).toBe(5);
  s.close();
});

test("virtual models round-trip with nested targets", async () => {
  const s = await store();
  await s.config.putModel({
    id: "fast",
    strategy: "score",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  const models = await s.config.listModels();
  expect(models).toHaveLength(1);
  expect(models[0]?.targets[0]?.model).toBe("claude-opus-4");
  expect(models[0]?.targets[0]?.capabilities.tools).toBe(true);
  s.close();
});

test("putModel replaces an existing model rather than duplicating", async () => {
  const s = await store();
  const model = { id: "fast", strategy: "score" as const, isAlias: false, targets: [] };
  await s.config.putModel(model);
  await s.config.putModel({ ...model, strategy: "priority" });
  const models = await s.config.listModels();
  expect(models).toHaveLength(1);
  expect(models[0]?.strategy).toBe("priority");
  s.close();
});

test("admin password hash round-trips and starts null", async () => {
  const s = await store();
  expect(await s.config.getAdminPasswordHash()).toBeNull();
  await s.config.setAdminPasswordHash("hash-value");
  expect(await s.config.getAdminPasswordHash()).toBe("hash-value");
  s.close();
});

test("api keys are found by hash and never store the raw value", async () => {
  const s = await store();
  const raw = generateApiKey();
  expect(raw.startsWith("sk-omni-")).toBe(true);

  const hash = await hashApiKey(raw);
  await s.keys.create({
    id: "k1",
    label: "laptop",
    prefix: raw.slice(0, 12),
    hash,
    modelAllowlist: ["fast"],
    rateLimitPerMin: 60,
  });

  const found = await s.keys.findByHash(hash);
  expect(found?.label).toBe("laptop");
  expect(found?.modelAllowlist).toEqual(["fast"]);
  expect(JSON.stringify(found)).not.toContain(raw);
  s.close();
});

test("revoked keys are still listed but marked revoked", async () => {
  const s = await store();
  const hash = await hashApiKey(generateApiKey());
  await s.keys.create({
    id: "k1",
    label: "l",
    prefix: "sk-omni-abcd",
    hash,
    modelAllowlist: null,
    rateLimitPerMin: null,
  });
  await s.keys.revoke("k1");
  const found = await s.keys.findByHash(hash);
  expect(found?.revokedAt).not.toBeNull();
  expect(await s.keys.list()).toHaveLength(1);
  s.close();
});

test("hashApiKey is deterministic and differs per input", async () => {
  const a = generateApiKey();
  const b = generateApiKey();
  expect(await hashApiKey(a)).toBe(await hashApiKey(a));
  expect(await hashApiKey(a)).not.toBe(await hashApiKey(b));
});

test("usage appends, lists recent, and aggregates by model", async () => {
  const s = await store();
  const log = {
    id: "r1",
    at: 1000,
    apiKeyId: "k1",
    requestedModel: "fast",
    resolvedProvider: "anthropic" as const,
    resolvedModel: "claude-opus-4",
    credentialId: "c1",
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: 300,
    durationMs: 1200,
    costUsd: 0.005,
    degradations: [],
  };
  await s.usage.append(log);
  await s.usage.append({ ...log, id: "r2", at: 2000, status: 429, errorCode: "RATE_LIMIT" });

  const recent = await s.usage.recent(10);
  expect(recent).toHaveLength(2);
  expect(recent[0]?.id).toBe("r2");
  expect(recent[0]?.degradations).toEqual([]);

  const byModel = await s.usage.aggregate({ since: 0, groupBy: "model" });
  expect(byModel[0]?.key).toBe("claude-opus-4");
  expect(byModel[0]?.requests).toBe(2);
  expect(byModel[0]?.inputTokens).toBe(200);
  expect(byModel[0]?.errors).toBe(1);
  s.close();
});

test("prune removes logs older than the cutoff", async () => {
  const s = await store();
  const base = {
    apiKeyId: null,
    requestedModel: "m",
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 1,
    status: 200,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 1,
    costUsd: 0,
    degradations: [],
  };
  await s.usage.append({ ...base, id: "old", at: 100 });
  await s.usage.append({ ...base, id: "new", at: 9000 });
  expect(await s.usage.prune(5000)).toBe(1);
  expect(await s.usage.recent(10)).toHaveLength(1);
  s.close();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/store/test/repos.test.ts`
Expected: FAIL — cannot resolve `../src/sqlite/store.ts`.

- [ ] **Step 3: Implement the config repository**

`packages/store/src/sqlite/config.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { ConfigRepo, Settings, Strategy, Target, VirtualModel } from "../types.ts";
import { DEFAULT_SETTINGS } from "../types.ts";

const SETTINGS_KEY = "settings";
const ADMIN_HASH_KEY = "adminPasswordHash";

export function createConfigRepo(db: Database): ConfigRepo {
  const readRaw = (key: string): string | null =>
    db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)
      ?.value ?? null;

  const writeRaw = (key: string, value: string): void => {
    db.run(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [key, value],
    );
  };

  return {
    async listModels() {
      type R = { id: string; targets: string; strategy: string; is_alias: number };
      return db
        .query<R, []>("SELECT * FROM virtual_models ORDER BY id")
        .all()
        .map((r) => ({
          id: r.id,
          targets: JSON.parse(r.targets) as Target[],
          strategy: r.strategy as Strategy,
          isAlias: r.is_alias === 1,
        }));
    },

    async putModel(model: VirtualModel) {
      db.run(
        `INSERT INTO virtual_models (id, targets, strategy, is_alias) VALUES (?,?,?,?)
         ON CONFLICT (id) DO UPDATE SET
           targets = excluded.targets,
           strategy = excluded.strategy,
           is_alias = excluded.is_alias`,
        [model.id, JSON.stringify(model.targets), model.strategy, model.isAlias ? 1 : 0],
      );
    },

    async removeModel(id: string) {
      db.run("DELETE FROM virtual_models WHERE id = ?", [id]);
    },

    async getSettings() {
      const raw = readRaw(SETTINGS_KEY);
      if (raw === null) return DEFAULT_SETTINGS;
      const stored = JSON.parse(raw) as Partial<Settings>;
      // Merge over defaults so a settings row written by an older version does
      // not leave newly-added fields undefined.
      return {
        ...DEFAULT_SETTINGS,
        ...stored,
        weights: { ...DEFAULT_SETTINGS.weights, ...stored.weights },
      };
    },

    async putSettings(patch: Partial<Settings>) {
      const current = await this.getSettings();
      const next: Settings = {
        ...current,
        ...patch,
        weights: { ...current.weights, ...patch.weights },
      };
      writeRaw(SETTINGS_KEY, JSON.stringify(next));
      return next;
    },

    async getAdminPasswordHash() {
      return readRaw(ADMIN_HASH_KEY);
    },

    async setAdminPasswordHash(hash: string) {
      writeRaw(ADMIN_HASH_KEY, hash);
    },
  };
}
```

- [ ] **Step 4: Implement the key repository**

`packages/store/src/sqlite/keys.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { ApiKey, KeyRepo } from "../types.ts";

const PREFIX = "sk-omni-";

/** 32 bytes of entropy, base64url, prefixed for recognisability in logs. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return PREFIX + b64;
}

/**
 * SHA-256, not Argon2id.
 *
 * Argon2 exists to slow brute force against low-entropy human passwords. An API
 * key is 256 bits of CSPRNG output, so there is nothing to brute force, and a
 * slow hash on the hot path of every proxied request would be a real cost. The
 * admin *password* does use Argon2id (Task 18) because it is human-chosen.
 */
export async function hashApiKey(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type Row = {
  id: string;
  label: string;
  prefix: string;
  hash: string;
  model_allowlist: string | null;
  rate_limit_per_min: number | null;
  created_at: number;
  revoked_at: number | null;
};

const toKey = (r: Row): ApiKey => ({
  id: r.id,
  label: r.label,
  prefix: r.prefix,
  hash: r.hash,
  modelAllowlist: r.model_allowlist === null ? null : (JSON.parse(r.model_allowlist) as string[]),
  rateLimitPerMin: r.rate_limit_per_min,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
});

export function createKeyRepo(db: Database): KeyRepo {
  return {
    async list() {
      return db.query<Row, []>("SELECT * FROM api_keys ORDER BY created_at DESC").all().map(toKey);
    },

    async findByHash(hash: string) {
      const row = db.query<Row, [string]>("SELECT * FROM api_keys WHERE hash = ?").get(hash);
      return row ? toKey(row) : null;
    },

    async create(input) {
      const now = Date.now();
      db.run(
        `INSERT INTO api_keys (id, label, prefix, hash, model_allowlist, rate_limit_per_min, created_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,NULL)`,
        [
          input.id,
          input.label,
          input.prefix,
          input.hash,
          input.modelAllowlist === null ? null : JSON.stringify(input.modelAllowlist),
          input.rateLimitPerMin,
          now,
        ],
      );
      return { ...input, createdAt: now, revokedAt: null };
    },

    async revoke(id: string) {
      db.run("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [Date.now(), id]);
    },
  };
}
```

- [ ] **Step 5: Implement the usage repository**

`packages/store/src/sqlite/usage.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { ProviderId } from "@omni/ir";
import type { RequestLog, UsageBucket, UsageQuery, UsageRepo } from "../types.ts";

type Row = {
  id: string;
  at: number;
  api_key_id: string | null;
  requested_model: string;
  resolved_provider: string | null;
  resolved_model: string | null;
  credential_id: string | null;
  attempts: number;
  status: number;
  error_code: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ttft_ms: number | null;
  duration_ms: number;
  cost_usd: number;
  degradations: string;
};

const toLog = (r: Row): RequestLog => ({
  id: r.id,
  at: r.at,
  apiKeyId: r.api_key_id,
  requestedModel: r.requested_model,
  resolvedProvider: r.resolved_provider as ProviderId | null,
  resolvedModel: r.resolved_model,
  credentialId: r.credential_id,
  attempts: r.attempts,
  status: r.status,
  errorCode: r.error_code,
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  ttftMs: r.ttft_ms,
  durationMs: r.duration_ms,
  costUsd: r.cost_usd,
  degradations: JSON.parse(r.degradations) as string[],
});

/** Whitelisted so the groupBy value can never reach SQL as raw text. */
const GROUP_COLUMN: Readonly<Record<UsageQuery["groupBy"], string>> = {
  credential: "credential_id",
  model: "resolved_model",
  apiKey: "api_key_id",
  hour: "at / 3600000",
};

export function createUsageRepo(db: Database): UsageRepo {
  return {
    async append(log: RequestLog) {
      db.run(
        `INSERT INTO request_logs
           (id, at, api_key_id, requested_model, resolved_provider, resolved_model, credential_id,
            attempts, status, error_code, input_tokens, output_tokens, cache_read_tokens,
            cache_write_tokens, ttft_ms, duration_ms, cost_usd, degradations)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          log.id,
          log.at,
          log.apiKeyId,
          log.requestedModel,
          log.resolvedProvider,
          log.resolvedModel,
          log.credentialId,
          log.attempts,
          log.status,
          log.errorCode,
          log.inputTokens,
          log.outputTokens,
          log.cacheReadTokens,
          log.cacheWriteTokens,
          log.ttftMs,
          log.durationMs,
          log.costUsd,
          JSON.stringify(log.degradations),
        ],
      );
    },

    async recent(limit: number) {
      return db
        .query<Row, [number]>("SELECT * FROM request_logs ORDER BY at DESC LIMIT ?")
        .all(limit)
        .map(toLog);
    },

    async aggregate(q: UsageQuery) {
      const col = GROUP_COLUMN[q.groupBy];
      const until = q.until ?? Number.MAX_SAFE_INTEGER;
      type Agg = {
        key: string | null;
        requests: number;
        input_tokens: number;
        output_tokens: number;
        cost_usd: number;
        errors: number;
      };
      return db
        .query<Agg, [number, number]>(
          `SELECT ${col} AS key,
                  COUNT(*) AS requests,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens,
                  COALESCE(SUM(cost_usd), 0) AS cost_usd,
                  COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors
             FROM request_logs
            WHERE at >= ? AND at <= ?
            GROUP BY key
            ORDER BY requests DESC`,
        )
        .all(q.since, until)
        .map(
          (r): UsageBucket => ({
            key: r.key === null ? "unknown" : String(r.key),
            requests: r.requests,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            costUsd: r.cost_usd,
            errors: r.errors,
          }),
        );
    },

    async prune(olderThan: number) {
      db.run("DELETE FROM request_logs WHERE at < ?", [olderThan]);
      return db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    },
  };
}
```

- [ ] **Step 6: Compose the store**

`packages/store/src/sqlite/store.ts`:

```ts
import type { Store } from "../types.ts";
import { createConfigRepo } from "./config.ts";
import { createCredentialRepo } from "./credentials.ts";
import { openDb } from "./db.ts";
import { createKeyRepo } from "./keys.ts";
import { createUsageRepo } from "./usage.ts";

export async function createStore(opts: {
  path: string;
  encryptionKey: CryptoKey;
}): Promise<Store> {
  const db = openDb(opts.path);
  return {
    credentials: createCredentialRepo(db, opts.encryptionKey),
    config: createConfigRepo(db),
    keys: createKeyRepo(db),
    usage: createUsageRepo(db),
    close: () => db.close(),
  };
}
```

- [ ] **Step 7: Export from the index**

`packages/store/src/index.ts`:

```ts
export * from "./types.ts";
export * from "./encryption.ts";
export { openDb } from "./sqlite/db.ts";
export { createCredentialRepo } from "./sqlite/credentials.ts";
export { createConfigRepo } from "./sqlite/config.ts";
export { createKeyRepo, generateApiKey, hashApiKey } from "./sqlite/keys.ts";
export { createUsageRepo } from "./sqlite/usage.ts";
export { createStore } from "./sqlite/store.ts";
```

- [ ] **Step 8: Run the tests**

Run: `bun test packages/store`
Expected: 30 pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add packages/store
git commit -m "feat(store): add config, key, and usage repositories"
```

---

## Task 8: Provider adapter interface and SSE parser

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`, `packages/providers/src/types.ts`, `packages/providers/src/sse.ts`, `packages/providers/src/index.ts`
- Test: `packages/providers/test/sse.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `StreamEvent`, `ProviderId` (Tasks 2-3).
- Produces: `ProviderAdapter`, `AdapterContext`, `AdapterRequest`, `Capabilities`, `parseSse(stream): AsyncGenerator<SseMessage>`, `USER_AGENT`. Tasks 9-11 implement `ProviderAdapter`; Task 15 consumes it.

- [ ] **Step 1: Write the failing test**

`packages/providers/test/sse.test.ts`:

```ts
import { expect, test } from "bun:test";
import { parseSse } from "../src/sse.ts";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

async function drain(s: ReadableStream<Uint8Array>) {
  const out = [];
  for await (const m of parseSse(s)) out.push(m);
  return out;
}

test("parses event and data pairs", async () => {
  const msgs = await drain(
    streamOf("event: message_start\ndata: {\"a\":1}\n\nevent: ping\ndata: {}\n\n"),
  );
  expect(msgs).toEqual([
    { event: "message_start", data: '{"a":1}' },
    { event: "ping", data: "{}" },
  ]);
});

test("handles messages split across chunk boundaries", async () => {
  const msgs = await drain(streamOf("event: msg\nda", "ta: {\"x\":", "2}\n\n"));
  expect(msgs).toEqual([{ event: "msg", data: '{"x":2}' }]);
});

test("defaults the event name to 'message' when absent", async () => {
  expect(await drain(streamOf("data: hello\n\n"))).toEqual([{ event: "message", data: "hello" }]);
});

test("joins multi-line data with newlines", async () => {
  expect(await drain(streamOf("data: line1\ndata: line2\n\n"))).toEqual([
    { event: "message", data: "line1\nline2" },
  ]);
});

test("ignores comment lines used as heartbeats", async () => {
  expect(await drain(streamOf(": keep-alive\n\ndata: real\n\n"))).toEqual([
    { event: "message", data: "real" },
  ]);
});

test("tolerates CRLF line endings", async () => {
  expect(await drain(streamOf("event: e\r\ndata: d\r\n\r\n"))).toEqual([
    { event: "e", data: "d" },
  ]);
});

test("emits a trailing message with no terminating blank line", async () => {
  expect(await drain(streamOf("data: last"))).toEqual([{ event: "message", data: "last" }]);
});
```

- [ ] **Step 2: Create the package and run the test to see it fail**

`packages/providers/package.json`:

```json
{
  "name": "@omni/providers",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@omni/ir": "workspace:*" }
}
```

`packages/providers/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "test"]
}
```

Run: `bun install && bun test packages/providers/test/sse.test.ts`
Expected: FAIL — cannot resolve `../src/sse.ts`.

- [ ] **Step 3: Write the SSE parser**

`packages/providers/src/sse.ts`:

```ts
export type SseMessage = { event: string; data: string };

/**
 * Parses an SSE byte stream into messages.
 *
 * Chunk boundaries fall anywhere, including mid-field, so the buffer is only
 * consumed up to the last complete record.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replaceAll("\r\n", "\n");

      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const record = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const msg = parseRecord(record);
        if (msg) yield msg;
        sep = buf.indexOf("\n\n");
      }
    }
    // A stream that ends without a final blank line still carries a message.
    const tail = parseRecord(buf.replaceAll("\r\n", "\n"));
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseRecord(record: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];

  for (const line of record.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  return data.length === 0 ? null : { event, data: data.join("\n") };
}
```

- [ ] **Step 4: Write the adapter interface**

`packages/providers/src/types.ts`:

```ts
import type { ChatRequest, ProviderId, StreamEvent } from "@omni/ir";

/** Sent on every upstream request. Deliberately identifies this gateway. */
export const USER_AGENT = "omnigateway/0.1.0";

export type Capabilities = { tools: boolean; images: boolean; reasoning: boolean };

export type AdapterCredentials = {
  accessToken: string | null;
  apiKey: string | null;
  /** Durable provider-specific state: Kimi device identity, Codex workspace id. */
  providerData: Record<string, unknown>;
};

export type AdapterRequest = {
  request: ChatRequest;
  /** Concrete upstream model id, already resolved from the virtual model. */
  model: string;
  credentials: AdapterCredentials;
  signal: AbortSignal;
};

export type AdapterResult = {
  /** Canonical events. The first blockDelta is dispatch's commit point. */
  events: AsyncGenerator<StreamEvent, void, undefined>;
  /** Capability reductions applied while building the wire request. */
  degradations: string[];
};

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;
  /**
   * Issues the upstream request and returns canonical events.
   *
   * Throws GatewayError before yielding when the upstream rejects the request;
   * after the first event, errors surface as an `error` event in the stream.
   */
  send(req: AdapterRequest): Promise<AdapterResult>;
}
```

- [ ] **Step 5: Write the package index**

`packages/providers/src/index.ts`:

```ts
export * from "./types.ts";
export * from "./sse.ts";
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/providers`
Expected: 7 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): add adapter interface and SSE parser"
```

---

## Task 9: Anthropic adapter

**Files:**
- Create: `packages/providers/src/anthropic/wire.ts`, `packages/providers/src/anthropic/decode.ts`, `packages/providers/src/anthropic/index.ts`, `packages/providers/src/http.ts`
- Modify: `packages/providers/src/index.ts`
- Test: `packages/providers/test/anthropic.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `AdapterRequest`, `parseSse`, `USER_AGENT` (Task 8); IR types (Tasks 2-3).
- Produces: `anthropicAdapter: ProviderAdapter`, plus `toWire(req, model): { body, degradations }` and `decodeAnthropic(sse): AsyncGenerator<StreamEvent>` exported for direct unit testing. Also `httpError(res, provider): GatewayError` in `http.ts`, reused by Tasks 10-11.

The IR was modelled on Anthropic's shape, so `toWire` is nearly structural. The two real jobs are the OAuth system-prompt requirement and mapping upstream errors onto `ErrorCode`.

- [ ] **Step 1: Write the failing test**

`packages/providers/test/anthropic.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { decodeAnthropic } from "../src/anthropic/decode.ts";
import { toWire } from "../src/anthropic/wire.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collectEvents(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

test("maps messages and model onto the wire body", () => {
  const { body } = toWire(base, "claude-opus-4", { oauth: false });
  expect(body.model).toBe("claude-opus-4");
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  expect(body.stream).toBe(true);
  expect(body.max_tokens).toBe(4096);
});

test("passes the system prompt through as blocks", () => {
  const { body } = toWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "claude-opus-4",
    { oauth: false },
  );
  expect(body.system).toEqual([{ type: "text", text: "be terse" }]);
});

test("prepends the required identity block on the oauth path and records it", () => {
  const { body, degradations } = toWire(
    { ...base, system: [{ type: "text", text: "be terse" }] },
    "claude-opus-4",
    { oauth: true },
  );
  expect(body.system?.[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
  expect(body.system?.[1]?.text).toBe("be terse");
  expect(degradations).toContain("anthropic:oauth-system-prefix");
});

test("does not duplicate the identity block when the caller already sent it", () => {
  const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
  const { body, degradations } = toWire({ ...base, system: [{ type: "text", text: identity }] }, "m", {
    oauth: true,
  });
  expect(body.system).toHaveLength(1);
  expect(degradations).not.toContain("anthropic:oauth-system-prefix");
});

test("translates tools and tool choice", () => {
  const { body } = toWire(
    {
      ...base,
      tools: [{ name: "get_weather", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { type: "tool", name: "get_weather" },
    },
    "m",
    { oauth: false },
  );
  expect(body.tools).toEqual([
    { name: "get_weather", description: "d", input_schema: { type: "object" } },
  ]);
  expect(body.tool_choice).toEqual({ type: "tool", name: "get_weather" });
});

test("maps reasoning config onto the thinking block", () => {
  const { body } = toWire({ ...base, reasoning: { effort: "high", budgetTokens: 8000 } }, "m", {
    oauth: false,
  });
  expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
});

test("merges vendor passthrough last so it can override", () => {
  const { body } = toWire({ ...base, vendor: { anthropic: { top_k: 40 } } }, "m", { oauth: false });
  expect(body.top_k).toBe(40);
});

test("decodes a text stream into canonical events", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "message_start",
          data: JSON.stringify({
            message: { id: "msg_1", model: "claude-opus-4", usage: { input_tokens: 10 } },
          }),
        },
        {
          event: "content_block_start",
          data: JSON.stringify({ index: 0, content_block: { type: "text", text: "" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hel" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "lo" } }),
        },
        { event: "content_block_stop", data: JSON.stringify({ index: 0 }) },
        {
          event: "message_delta",
          data: JSON.stringify({
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          }),
        },
        { event: "message_stop", data: "{}" },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "msg_1", model: "claude-opus-4" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  });
});

test("decodes tool use with partial json deltas", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "content_block_start",
          data: JSON.stringify({
            index: 1,
            content_block: { type: "tool_use", id: "tu_1", name: "get_weather" },
          }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"city":' },
          }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({
            index: 1,
            delta: { type: "input_json_delta", partial_json: '"SF"}' },
          }),
        },
        { event: "content_block_stop", data: JSON.stringify({ index: 1 }) },
      ),
    ),
  );

  expect(events[0]).toEqual({
    type: "blockStart",
    index: 1,
    block: { type: "toolUse", id: "tu_1", name: "get_weather" },
  });
  expect(events[1]).toEqual({
    type: "blockDelta",
    index: 1,
    delta: { type: "toolJson", partial: '{"city":' },
  });
  expect(events.at(-1)).toEqual({ type: "blockEnd", index: 1 });
});

test("decodes thinking deltas and signatures", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs(
        {
          event: "content_block_start",
          data: JSON.stringify({ index: 0, content_block: { type: "thinking" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
        },
        {
          event: "content_block_delta",
          data: JSON.stringify({ index: 0, delta: { type: "signature_delta", signature: "sig" } }),
        },
      ),
    ),
  );
  expect(events[1]).toEqual({ type: "blockDelta", index: 0, delta: { type: "thinking", text: "hmm" } });
  expect(events[2]).toEqual({
    type: "blockDelta",
    index: 0,
    delta: { type: "thinkingSignature", signature: "sig" },
  });
});

test("turns a mid-stream error event into an error event", async () => {
  const events = await collectEvents(
    decodeAnthropic(
      msgs({
        event: "error",
        data: JSON.stringify({ error: { type: "overloaded_error", message: "overloaded" } }),
      }),
    ),
  );
  expect(events[0]).toEqual({
    type: "error",
    code: "OVERLOADED",
    message: "overloaded",
    retryable: true,
  });
});

test("ignores ping events and unparseable payloads", async () => {
  const events = await collectEvents(
    decodeAnthropic(msgs({ event: "ping", data: "{}" }, { event: "message_stop", data: "not-json" })),
  );
  expect(events).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/providers/test/anthropic.test.ts`
Expected: FAIL — cannot resolve `../src/anthropic/wire.ts`.

- [ ] **Step 3: Write the shared HTTP error mapper**

`packages/providers/src/http.ts`:

```ts
import { type ErrorCode, GatewayError, type ProviderId } from "@omni/ir";

/** Maps an upstream status to a canonical code, before body inspection. */
function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 402) return "QUOTA_EXHAUSTED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 413 || status === 422 || status === 400) return "BAD_REQUEST";
  if (status === 429) return "RATE_LIMIT";
  if (status === 529) return "OVERLOADED";
  if (status >= 500) return "UPSTREAM";
  return "UPSTREAM";
}

/** `Retry-After` is seconds or an HTTP date; both appear in the wild. */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Builds a GatewayError from a failed upstream response.
 *
 * Reads the body so the message is useful, but never logs it — the caller
 * decides what to surface, and the message is truncated to keep prompt
 * echoes out of error text.
 */
export async function httpError(
  res: Response,
  provider: ProviderId,
  now = Date.now(),
): Promise<GatewayError> {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 500);
  let code = codeForStatus(res.status);

  try {
    const parsed = JSON.parse(text) as {
      error?: { type?: string; message?: string; code?: string };
    };
    if (typeof parsed.error?.message === "string") message = parsed.error.message.slice(0, 500);
    const type = parsed.error?.type ?? parsed.error?.code;
    if (type === "overloaded_error") code = "OVERLOADED";
    else if (type === "insufficient_quota") code = "QUOTA_EXHAUSTED";
    else if (type === "context_length_exceeded") code = "BAD_REQUEST";
    else if (type === "content_policy_violation") code = "CONTENT_FILTER";
  } catch {
    // Non-JSON error bodies (HTML gateway pages) keep the status-derived code.
  }

  return new GatewayError(code, message || `${provider} returned ${res.status}`, {
    provider,
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), now),
  });
}
```

- [ ] **Step 4: Write the wire encoder**

`packages/providers/src/anthropic/wire.ts`:

```ts
import type { ChatRequest, ContentBlock, ToolChoice } from "@omni/ir";

export const OAUTH_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export type AnthropicBody = {
  model: string;
  messages: unknown[];
  system?: { type: "text"; text: string }[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  stop_sequences?: string[];
  tools?: { name: string; description?: string; input_schema: unknown }[];
  tool_choice?: unknown;
  thinking?: { type: "enabled"; budget_tokens: number };
  [key: string]: unknown;
};

const EFFORT_BUDGET = { low: 2048, medium: 8192, high: 24576 } as const;

function encodeBlock(b: ContentBlock): unknown {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.data },
      };
    case "thinking":
      return { type: "thinking", thinking: b.text, signature: b.signature };
    case "toolUse":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "toolResult":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        is_error: b.isError,
      };
  }
}

function encodeToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: c.name };
  }
}

export function toWire(
  req: ChatRequest,
  model: string,
  opts: { oauth: boolean },
): { body: AnthropicBody; degradations: string[] } {
  const degradations: string[] = [];

  let system = req.system?.flatMap((b) =>
    b.type === "text" ? [{ type: "text" as const, text: b.text }] : [],
  );

  // The OAuth token endpoint rejects requests whose first system block is not
  // this string. It is a functional requirement of the credential, not a
  // disguise: the User-Agent still identifies this gateway. Recorded as a
  // degradation so it is visible in the request log.
  if (opts.oauth && system?.[0]?.text !== OAUTH_IDENTITY) {
    system = [{ type: "text" as const, text: OAUTH_IDENTITY }, ...(system ?? [])];
    degradations.push("anthropic:oauth-system-prefix");
  }

  const body: AnthropicBody = {
    model,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content.map(encodeBlock) })),
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream,
  };

  if (system !== undefined && system.length > 0) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop_sequences = req.stopSequences;
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined) {
    const budget = req.reasoning.budgetTokens ?? EFFORT_BUDGET[req.reasoning.effort];
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  // Vendor passthrough is applied last: an operator setting a raw Anthropic
  // field is stating an explicit intent that outranks our mapping.
  Object.assign(body, req.vendor?.anthropic ?? {});

  return { body, degradations };
}
```

- [ ] **Step 5: Write the stream decoder**

`packages/providers/src/anthropic/decode.ts`:

```ts
import { type ErrorCode, RETRYABLE, type StopReason, type StreamEvent } from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const STOP_REASON: Readonly<Record<string, StopReason>> = {
  end_turn: "endTurn",
  max_tokens: "maxTokens",
  stop_sequence: "stopSequence",
  tool_use: "toolUse",
  refusal: "contentFilter",
};

const ERROR_TYPE: Readonly<Record<string, ErrorCode>> = {
  overloaded_error: "OVERLOADED",
  rate_limit_error: "RATE_LIMIT",
  authentication_error: "AUTH",
  permission_error: "AUTH",
  invalid_request_error: "BAD_REQUEST",
  api_error: "UPSTREAM",
};

/** SSE payloads are trusted to be JSON; a malformed one is skipped, not fatal. */
function json(data: string): Record<string, any> | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export async function* decodeAnthropic(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let stopReason: StopReason = "endTurn";

  for await (const msg of messages) {
    const d = json(msg.data);
    if (d === null) continue;

    switch (msg.event) {
      case "message_start": {
        const m = d.message ?? {};
        inputTokens = m.usage?.input_tokens ?? 0;
        cacheReadTokens = m.usage?.cache_read_input_tokens ?? 0;
        cacheWriteTokens = m.usage?.cache_creation_input_tokens ?? 0;
        yield { type: "start", id: String(m.id ?? ""), model: String(m.model ?? "") };
        break;
      }

      case "content_block_start": {
        const cb = d.content_block ?? {};
        const index: number = d.index ?? 0;
        if (cb.type === "text") yield { type: "blockStart", index, block: { type: "text" } };
        else if (cb.type === "thinking")
          yield { type: "blockStart", index, block: { type: "thinking" } };
        else if (cb.type === "tool_use")
          yield {
            type: "blockStart",
            index,
            block: { type: "toolUse", id: String(cb.id), name: String(cb.name) },
          };
        break;
      }

      case "content_block_delta": {
        const index: number = d.index ?? 0;
        const delta = d.delta ?? {};
        if (delta.type === "text_delta")
          yield { type: "blockDelta", index, delta: { type: "text", text: delta.text } };
        else if (delta.type === "thinking_delta")
          yield { type: "blockDelta", index, delta: { type: "thinking", text: delta.thinking } };
        else if (delta.type === "signature_delta")
          yield {
            type: "blockDelta",
            index,
            delta: { type: "thinkingSignature", signature: delta.signature },
          };
        else if (delta.type === "input_json_delta")
          yield {
            type: "blockDelta",
            index,
            delta: { type: "toolJson", partial: delta.partial_json ?? "" },
          };
        break;
      }

      case "content_block_stop":
        yield { type: "blockEnd", index: d.index ?? 0 };
        break;

      case "message_delta": {
        const reason = d.delta?.stop_reason;
        if (typeof reason === "string") stopReason = STOP_REASON[reason] ?? "endTurn";
        outputTokens = d.usage?.output_tokens ?? outputTokens;
        break;
      }

      case "message_stop":
        yield {
          type: "end",
          stopReason,
          usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        };
        break;

      case "error": {
        const code = ERROR_TYPE[String(d.error?.type)] ?? "UPSTREAM";
        yield {
          type: "error",
          code,
          message: String(d.error?.message ?? "upstream error"),
          retryable: RETRYABLE[code],
        };
        break;
      }

      default:
        // ping and any future event types are ignored by design.
        break;
    }
  }
}
```

- [ ] **Step 6: Write the adapter**

`packages/providers/src/anthropic/index.ts`:

```ts
import { GatewayError } from "@omni/ir";
import { httpError } from "../http.ts";
import { parseSse } from "../sse.ts";
import { type AdapterRequest, type AdapterResult, type ProviderAdapter, USER_AGENT } from "../types.ts";
import { decodeAnthropic } from "./decode.ts";
import { toWire } from "./wire.ts";

const BASE_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  capabilities: { tools: true, images: true, reasoning: true },

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;
    const { body, degradations } = toWire(req.request, req.model, { oauth });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "anthropic-version": API_VERSION,
      accept: req.request.stream ? "text/event-stream" : "application/json",
    };

    if (oauth) {
      headers.authorization = `Bearer ${req.credentials.accessToken}`;
      headers["anthropic-beta"] = OAUTH_BETA;
    } else if (req.credentials.apiKey !== null) {
      headers["x-api-key"] = req.credentials.apiKey;
    } else {
      throw new GatewayError("AUTH", "anthropic credential has no token", { provider: "anthropic" });
    }

    const res = await fetch(BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) throw await httpError(res, "anthropic");
    if (res.body === null) throw new GatewayError("UPSTREAM", "empty response body", { provider: "anthropic" });

    return { events: decodeAnthropic(parseSse(res.body)), degradations };
  },
};

export { decodeAnthropic, toWire };
```

- [ ] **Step 7: Export from the package index**

Append to `packages/providers/src/index.ts`:

```ts
export { httpError, parseRetryAfter } from "./http.ts";
export { anthropicAdapter } from "./anthropic/index.ts";
```

- [ ] **Step 8: Run the tests**

Run: `bun test packages/providers`
Expected: 19 pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): add anthropic adapter"
```

---

## Task 10: OpenAI adapter

**Files:**
- Create: `packages/providers/src/openai/wire.ts`, `packages/providers/src/openai/decode.ts`, `packages/providers/src/openai/index.ts`
- Modify: `packages/providers/src/index.ts`
- Test: `packages/providers/test/openai.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `httpError`, `parseSse` (Tasks 8-9).
- Produces: `openaiAdapter: ProviderAdapter`, `toResponsesWire(req, model)`, `decodeResponses(sse)`.

**Why the Responses API and not Chat Completions.** A ChatGPT OAuth token is only accepted at `https://chatgpt.com/backend-api/codex/responses`, which speaks the Responses API. An API-key credential could use either. Supporting one upstream shape keeps the adapter to a single code path, and the Responses API is the one that carries reasoning items, so it is the strict superset. `openaiAdapter` therefore always emits Responses-shaped bodies and switches only the URL and auth header.

**Index mapping.** Responses events carry `output_index` and `content_index` separately; the IR has one flat index. The decoder keeps a `Map<string, number>` keyed by `${output_index}:${content_index}` and assigns IR indices in first-seen order, so a reasoning item at output 0 and a message at output 1 become IR blocks 0 and 1.

- [ ] **Step 1: Write the failing test**

`packages/providers/test/openai.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { decodeResponses } from "../src/openai/decode.ts";
import { toResponsesWire } from "../src/openai/wire.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "smart",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collect(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

test("maps messages onto responses input items", () => {
  const { body } = toResponsesWire(base, "gpt-5");
  expect(body.model).toBe("gpt-5");
  expect(body.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ]);
  expect(body.stream).toBe(true);
});

test("uses output_text for assistant content", () => {
  const { body } = toResponsesWire(
    { ...base, messages: [{ role: "assistant", content: [{ type: "text", text: "yo" }] }] },
    "gpt-5",
  );
  expect(body.input[0]).toEqual({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "yo" }],
  });
});

test("maps the system prompt onto instructions", () => {
  const { body } = toResponsesWire({ ...base, system: [{ type: "text", text: "be terse" }] }, "gpt-5");
  expect(body.instructions).toBe("be terse");
});

test("lifts tool use and tool result to top-level items", () => {
  const { body } = toResponsesWire(
    {
      ...base,
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "call_1", name: "get_weather", input: { city: "SF" } }],
        },
        {
          role: "user",
          content: [{ type: "toolResult", toolUseId: "call_1", content: "sunny", isError: false }],
        },
      ],
    },
    "gpt-5",
  );
  expect(body.input[0]).toEqual({
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: '{"city":"SF"}',
  });
  expect(body.input[1]).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: "sunny",
  });
});

test("flattens tool definitions and maps tool choice", () => {
  const { body } = toResponsesWire(
    {
      ...base,
      tools: [{ name: "f", description: "d", inputSchema: { type: "object" } }],
      toolChoice: { type: "tool", name: "f" },
    },
    "gpt-5",
  );
  expect(body.tools).toEqual([
    { type: "function", name: "f", description: "d", parameters: { type: "object" } },
  ]);
  expect(body.tool_choice).toEqual({ type: "function", name: "f" });
});

test("maps reasoning effort and drops the budget with a degradation", () => {
  const { body, degradations } = toResponsesWire(
    { ...base, reasoning: { effort: "high", budgetTokens: 8000 } },
    "gpt-5",
  );
  expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  expect(degradations).toContain("openai:reasoning-budget-dropped");
});

test("drops images with a degradation when the request carries them", () => {
  const { body, degradations } = toResponsesWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", data: "AAAA" },
          ],
        },
      ],
    },
    "gpt-5",
  );
  expect(body.input[0]).toEqual({
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ],
  });
  expect(degradations).toEqual([]);
});

test("maps maxTokens onto max_output_tokens", () => {
  const { body } = toResponsesWire({ ...base, maxTokens: 100 }, "gpt-5");
  expect(body.max_output_tokens).toBe(100);
});

test("decodes a text response stream", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.created",
          data: JSON.stringify({ response: { id: "resp_1", model: "gpt-5" } }),
        },
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 0, item: { type: "message" } }),
        },
        {
          event: "response.content_part.added",
          data: JSON.stringify({ output_index: 0, content_index: 0, part: { type: "output_text" } }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "Hel" }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "lo" }),
        },
        {
          event: "response.content_part.done",
          data: JSON.stringify({ output_index: 0, content_index: 0 }),
        },
        {
          event: "response.completed",
          data: JSON.stringify({
            response: {
              status: "completed",
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 4 },
              },
            },
          }),
        },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "resp_1", model: "gpt-5" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 0 },
  });
});

test("assigns distinct ir indices to reasoning and message items", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 0, item: { type: "reasoning" } }),
        },
        {
          event: "response.reasoning_summary_text.delta",
          data: JSON.stringify({ output_index: 0, content_index: 0, delta: "thinking" }),
        },
        {
          event: "response.output_item.added",
          data: JSON.stringify({ output_index: 1, item: { type: "message" } }),
        },
        {
          event: "response.content_part.added",
          data: JSON.stringify({ output_index: 1, content_index: 0, part: { type: "output_text" } }),
        },
        {
          event: "response.output_text.delta",
          data: JSON.stringify({ output_index: 1, content_index: 0, delta: "answer" }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({ type: "blockStart", index: 0, block: { type: "thinking" } });
  expect(events[1]).toEqual({ type: "blockDelta", index: 0, delta: { type: "thinking", text: "thinking" } });
  expect(events[2]).toEqual({ type: "blockStart", index: 1, block: { type: "text" } });
  expect(events[3]).toEqual({ type: "blockDelta", index: 1, delta: { type: "text", text: "answer" } });
});

test("decodes function call items with argument deltas", async () => {
  const events = await collect(
    decodeResponses(
      msgs(
        {
          event: "response.output_item.added",
          data: JSON.stringify({
            output_index: 0,
            item: { type: "function_call", call_id: "call_1", name: "f" },
          }),
        },
        {
          event: "response.function_call_arguments.delta",
          data: JSON.stringify({ output_index: 0, delta: '{"a":1}' }),
        },
        { event: "response.output_item.done", data: JSON.stringify({ output_index: 0 }) },
        {
          event: "response.completed",
          data: JSON.stringify({ response: { status: "completed", usage: {} } }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "call_1", name: "f" },
  });
  expect(events[1]).toEqual({ type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } });
  expect(events[2]).toEqual({ type: "blockEnd", index: 0 });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "toolUse" });
});

test("maps an incomplete response with a token cap onto maxTokens", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.completed",
        data: JSON.stringify({
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: {},
          },
        }),
      }),
    ),
  );
  expect(events[0]).toMatchObject({ type: "end", stopReason: "maxTokens" });
});

test("turns a response.failed event into an error event", async () => {
  const events = await collect(
    decodeResponses(
      msgs({
        event: "response.failed",
        data: JSON.stringify({
          response: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        }),
      }),
    ),
  );
  expect(events[0]).toEqual({
    type: "error",
    code: "RATE_LIMIT",
    message: "slow down",
    retryable: true,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/providers/test/openai.test.ts`
Expected: FAIL — cannot resolve `../src/openai/wire.ts`.

- [ ] **Step 3: Write the wire encoder**

`packages/providers/src/openai/wire.ts`:

```ts
import type { ChatRequest, ToolChoice } from "@omni/ir";

export type ResponsesBody = {
  model: string;
  input: unknown[];
  instructions?: string;
  stream: boolean;
  max_output_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: { effort: string; summary: string };
  store?: boolean;
  [key: string]: unknown;
};

function encodeToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: c.name };
  }
}

/**
 * Flattens IR messages into Responses input items.
 *
 * Tool use and tool result are top-level items in this API rather than content
 * blocks inside a message, so a single IR message can expand into several items.
 */
export function toResponsesWire(
  req: ChatRequest,
  model: string,
): { body: ResponsesBody; degradations: string[] } {
  const degradations: string[] = [];
  const input: unknown[] = [];

  for (const message of req.messages) {
    const parts: unknown[] = [];

    const flush = (): void => {
      if (parts.length === 0) return;
      input.push({ type: "message", role: message.role, content: [...parts] });
      parts.length = 0;
    };

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          parts.push({
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: block.text,
          });
          break;
        case "image":
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
          });
          break;
        case "thinking":
          // Anthropic thinking blocks carry a provider-specific signature that
          // is meaningless here. Dropping them is lossless for the model.
          if (!degradations.includes("openai:thinking-dropped")) {
            degradations.push("openai:thinking-dropped");
          }
          break;
        case "toolUse":
          flush();
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
          break;
        case "toolResult":
          flush();
          input.push({
            type: "function_call_output",
            call_id: block.toolUseId,
            output: block.content,
          });
          break;
      }
    }
    flush();
  }

  const body: ResponsesBody = { model, input, stream: req.stream, store: false };

  const instructions = req.system
    ?.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n\n");
  if (instructions !== undefined && instructions.length > 0) body.instructions = instructions;

  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined) {
    body.reasoning = { effort: req.reasoning.effort, summary: "auto" };
    // This API takes a coarse effort level, not a token budget.
    if (req.reasoning.budgetTokens !== undefined) {
      degradations.push("openai:reasoning-budget-dropped");
    }
  }

  Object.assign(body, req.vendor?.openai ?? {});
  return { body, degradations };
}
```

- [ ] **Step 4: Write the stream decoder**

`packages/providers/src/openai/decode.ts`:

```ts
import { type ErrorCode, RETRYABLE, type StopReason, type StreamEvent } from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const ERROR_CODE: Readonly<Record<string, ErrorCode>> = {
  rate_limit_exceeded: "RATE_LIMIT",
  insufficient_quota: "QUOTA_EXHAUSTED",
  invalid_api_key: "AUTH",
  server_error: "UPSTREAM",
  context_length_exceeded: "BAD_REQUEST",
  content_policy_violation: "CONTENT_FILTER",
};

function json(data: string): Record<string, any> | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export async function* decodeResponses(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  // Responses addresses blocks by (output_index, content_index); the IR uses a
  // single flat index. Assign IR indices in first-seen order.
  const indices = new Map<string, number>();
  let next = 0;
  const irIndex = (outputIndex: number, contentIndex = 0): number => {
    const key = `${outputIndex}:${contentIndex}`;
    const existing = indices.get(key);
    if (existing !== undefined) return existing;
    const assigned = next++;
    indices.set(key, assigned);
    return assigned;
  };

  let sawToolCall = false;

  for await (const msg of messages) {
    const d = json(msg.data);
    if (d === null) continue;

    switch (msg.event) {
      case "response.created":
        yield {
          type: "start",
          id: String(d.response?.id ?? ""),
          model: String(d.response?.model ?? ""),
        };
        break;

      case "response.output_item.added": {
        const item = d.item ?? {};
        if (item.type === "reasoning") {
          yield { type: "blockStart", index: irIndex(d.output_index ?? 0), block: { type: "thinking" } };
        } else if (item.type === "function_call") {
          sawToolCall = true;
          yield {
            type: "blockStart",
            index: irIndex(d.output_index ?? 0),
            block: { type: "toolUse", id: String(item.call_id), name: String(item.name) },
          };
        }
        // A message item emits nothing here; its content_part.added does.
        break;
      }

      case "response.content_part.added":
        if (d.part?.type === "output_text") {
          yield {
            type: "blockStart",
            index: irIndex(d.output_index ?? 0, d.content_index ?? 0),
            block: { type: "text" },
          };
        }
        break;

      case "response.output_text.delta":
        yield {
          type: "blockDelta",
          index: irIndex(d.output_index ?? 0, d.content_index ?? 0),
          delta: { type: "text", text: String(d.delta ?? "") },
        };
        break;

      case "response.reasoning_summary_text.delta":
        yield {
          type: "blockDelta",
          index: irIndex(d.output_index ?? 0),
          delta: { type: "thinking", text: String(d.delta ?? "") },
        };
        break;

      case "response.function_call_arguments.delta":
        yield {
          type: "blockDelta",
          index: irIndex(d.output_index ?? 0),
          delta: { type: "toolJson", partial: String(d.delta ?? "") },
        };
        break;

      case "response.content_part.done":
        yield { type: "blockEnd", index: irIndex(d.output_index ?? 0, d.content_index ?? 0) };
        break;

      case "response.output_item.done": {
        // Only close items that opened their own block; message items closed
        // via content_part.done above.
        const key = `${d.output_index ?? 0}:0`;
        if (indices.has(key)) yield { type: "blockEnd", index: irIndex(d.output_index ?? 0) };
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const r = d.response ?? {};
        const reason = r.incomplete_details?.reason;
        let stopReason: StopReason = sawToolCall ? "toolUse" : "endTurn";
        if (reason === "max_output_tokens") stopReason = "maxTokens";
        else if (reason === "content_filter") stopReason = "contentFilter";
        yield {
          type: "end",
          stopReason,
          usage: {
            inputTokens: r.usage?.input_tokens ?? 0,
            outputTokens: r.usage?.output_tokens ?? 0,
            cacheReadTokens: r.usage?.input_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          },
        };
        break;
      }

      case "response.failed":
      case "error": {
        const err = d.response?.error ?? d.error ?? {};
        const code = ERROR_CODE[String(err.code ?? err.type)] ?? "UPSTREAM";
        yield {
          type: "error",
          code,
          message: String(err.message ?? "upstream error"),
          retryable: RETRYABLE[code],
        };
        break;
      }

      default:
        break;
    }
  }
}
```

- [ ] **Step 5: Write the adapter**

`packages/providers/src/openai/index.ts`:

```ts
import { GatewayError } from "@omni/ir";
import { httpError } from "../http.ts";
import { parseSse } from "../sse.ts";
import { type AdapterRequest, type AdapterResult, type ProviderAdapter, USER_AGENT } from "../types.ts";
import { decodeResponses } from "./decode.ts";
import { toResponsesWire } from "./wire.ts";

const OAUTH_URL = "https://chatgpt.com/backend-api/codex/responses";
const API_URL = "https://api.openai.com/v1/responses";

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  capabilities: { tools: true, images: true, reasoning: true },

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;
    const { body, degradations } = toResponsesWire(req.request, req.model);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      accept: "text/event-stream",
    };

    if (oauth) {
      headers.authorization = `Bearer ${req.credentials.accessToken}`;
      // Required by the Codex backend to select the billing account. Stored on
      // the credential at OAuth time (Task 21).
      const accountId = req.credentials.providerData.accountId;
      if (typeof accountId === "string") headers["chatgpt-account-id"] = accountId;
      headers.originator = "codex_cli_rs";
    } else if (req.credentials.apiKey !== null) {
      headers.authorization = `Bearer ${req.credentials.apiKey}`;
    } else {
      throw new GatewayError("AUTH", "openai credential has no token", { provider: "openai" });
    }

    // The Codex endpoint only streams. Non-streaming client requests are served
    // by collecting the stream in dispatch, so always ask for SSE.
    const res = await fetch(oauth ? OAUTH_URL : API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: req.signal,
    });

    if (!res.ok) throw await httpError(res, "openai");
    if (res.body === null) throw new GatewayError("UPSTREAM", "empty response body", { provider: "openai" });

    return { events: decodeResponses(parseSse(res.body)), degradations };
  },
};

export { decodeResponses, toResponsesWire };
```

- [ ] **Step 6: Export from the package index**

Append to `packages/providers/src/index.ts`:

```ts
export { openaiAdapter } from "./openai/index.ts";
```

- [ ] **Step 7: Run the tests**

Run: `bun test packages/providers`
Expected: 32 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): add openai responses adapter"
```

---

## Task 11: Kimi adapter and the adapter registry

**Files:**
- Create: `packages/providers/src/kimi/wire.ts`, `packages/providers/src/kimi/decode.ts`, `packages/providers/src/kimi/index.ts`, `packages/providers/src/registry.ts`
- Modify: `packages/providers/src/index.ts`
- Test: `packages/providers/test/kimi.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `httpError`, `parseSse`, and the anthropic/openai adapters.
- Produces: `kimiAdapter: ProviderAdapter`, `toChatWire(req, model)`, `decodeChat(sse)`, and `ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>>` — the lookup dispatch uses in Task 15.

Kimi speaks OpenAI Chat Completions. Its device identity headers (`X-Msh-Device-Id`, `X-Msh-Platform`) come from `providerData` written at OAuth time (Task 22) and must stay stable for the life of the credential — a changing device id triggers re-auth.

- [ ] **Step 1: Write the failing test**

`packages/providers/test/kimi.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ChatRequest, StreamEvent } from "@omni/ir";
import { decodeChat } from "../src/kimi/decode.ts";
import { toChatWire } from "../src/kimi/wire.ts";
import { ADAPTERS } from "../src/registry.ts";
import type { SseMessage } from "../src/sse.ts";

const base: ChatRequest = {
  model: "cheap",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* msgs(...m: SseMessage[]): AsyncGenerator<SseMessage> {
  for (const x of m) yield x;
}

async function collect(g: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of g) out.push(e);
  return out;
}

test("collapses single text blocks to a plain string content", () => {
  const { body } = toChatWire(base, "kimi-k2");
  expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(body.model).toBe("kimi-k2");
  expect(body.stream).toBe(true);
});

test("prepends the system prompt as a system message", () => {
  const { body } = toChatWire({ ...base, system: [{ type: "text", text: "be terse" }] }, "kimi-k2");
  expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
});

test("emits assistant tool_calls and a tool role result", () => {
  const { body } = toChatWire(
    {
      ...base,
      messages: [
        { role: "assistant", content: [{ type: "toolUse", id: "c1", name: "f", input: { a: 1 } }] },
        { role: "user", content: [{ type: "toolResult", toolUseId: "c1", content: "ok", isError: false }] },
      ],
    },
    "kimi-k2",
  );
  expect(body.messages[0]).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
    ],
  });
  expect(body.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
});

test("drops images with a degradation", () => {
  const { body, degradations } = toChatWire(
    {
      ...base,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mediaType: "image/png", data: "AAAA" },
          ],
        },
      ],
    },
    "kimi-k2",
  );
  expect(body.messages[0]).toEqual({ role: "user", content: "look" });
  expect(degradations).toContain("kimi:images-dropped");
});

test("drops reasoning config with a degradation", () => {
  const { body, degradations } = toChatWire({ ...base, reasoning: { effort: "high" } }, "kimi-k2");
  expect(body.reasoning).toBeUndefined();
  expect(degradations).toContain("kimi:reasoning-dropped");
});

test("decodes chat completion chunks into canonical events", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({
            id: "c1",
            model: "kimi-k2",
            choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ index: 0, delta: { content: "lo" } }] }),
        },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );

  expect(events[0]).toEqual({ type: "start", id: "c1", model: "kimi-k2" });
  expect(events[1]).toEqual({ type: "blockStart", index: 0, block: { type: "text" } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "text", text: "Hel" } });
  expect(events.at(-1)).toEqual({
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
});

test("decodes streamed tool calls indexed after text", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        {
          event: "message",
          data: JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "f", arguments: '{"a"' } },
                  ],
                },
              },
            ],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }],
          }),
        },
        {
          event: "message",
          data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        },
      ),
    ),
  );
  expect(events[0]).toEqual({
    type: "blockStart",
    index: 0,
    block: { type: "toolUse", id: "c1", name: "f" },
  });
  expect(events[1]).toEqual({ type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a"' } });
  expect(events[2]).toEqual({ type: "blockDelta", index: 0, delta: { type: "toolJson", partial: ":1}" } });
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "toolUse" });
});

test("maps a length finish reason", async () => {
  const events = await collect(
    decodeChat(
      msgs({
        event: "message",
        data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
      }),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "maxTokens" });
});

test("[DONE] with no finish_reason still terminates the stream", async () => {
  const events = await collect(
    decodeChat(
      msgs(
        { event: "message", data: JSON.stringify({ choices: [{ delta: { content: "x" } }] }) },
        { event: "message", data: "[DONE]" },
      ),
    ),
  );
  expect(events.at(-1)).toMatchObject({ type: "end", stopReason: "endTurn" });
});

test("the registry exposes exactly the three v1 providers", () => {
  expect(Object.keys(ADAPTERS).sort()).toEqual(["anthropic", "kimi", "openai"]);
  expect(ADAPTERS.kimi.capabilities.images).toBe(false);
  expect(ADAPTERS.anthropic.capabilities.reasoning).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/providers/test/kimi.test.ts`
Expected: FAIL — cannot resolve `../src/kimi/wire.ts`.

- [ ] **Step 3: Write the wire encoder**

`packages/providers/src/kimi/wire.ts`:

```ts
import type { ChatRequest, ToolChoice } from "@omni/ir";

export type ChatBody = {
  model: string;
  messages: unknown[];
  stream: boolean;
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  [key: string]: unknown;
};

function encodeToolChoice(c: ToolChoice): unknown {
  switch (c.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: c.name } };
  }
}

export function toChatWire(
  req: ChatRequest,
  model: string,
): { body: ChatBody; degradations: string[] } {
  const degradations: string[] = [];
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  const messages: unknown[] = [];

  const system = req.system?.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
  if (system !== undefined && system.length > 0) messages.push({ role: "system", content: system });

  for (const message of req.messages) {
    const text: string[] = [];
    const toolCalls: unknown[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          text.push(block.text);
          break;
        case "image":
          note("kimi:images-dropped");
          break;
        case "thinking":
          note("kimi:thinking-dropped");
          break;
        case "toolUse":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input) },
          });
          break;
        case "toolResult":
          // A tool result is its own message in this API, not a content block.
          messages.push({
            role: "tool",
            tool_call_id: block.toolUseId,
            content: block.content,
          });
          break;
      }
    }

    if (toolCalls.length > 0) {
      messages.push({
        role: message.role,
        content: text.length > 0 ? text.join("\n") : null,
        tool_calls: toolCalls,
      });
    } else if (text.length > 0) {
      messages.push({ role: message.role, content: text.join("\n") });
    }
  }

  const body: ChatBody = { model, messages, stream: req.stream };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop = req.stopSequences;
  if (req.tools !== undefined) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice);
  if (req.reasoning !== undefined) note("kimi:reasoning-dropped");

  Object.assign(body, req.vendor?.kimi ?? {});
  return { body, degradations };
}
```

- [ ] **Step 4: Write the stream decoder**

`packages/providers/src/kimi/decode.ts`:

```ts
import { type StopReason, type StreamEvent } from "@omni/ir";
import type { SseMessage } from "../sse.ts";

const FINISH: Readonly<Record<string, StopReason>> = {
  stop: "endTurn",
  length: "maxTokens",
  tool_calls: "toolUse",
  content_filter: "contentFilter",
};

function json(data: string): Record<string, any> | null {
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === "object" && v !== null ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export async function* decodeChat(
  messages: AsyncGenerator<SseMessage> | AsyncIterable<SseMessage>,
): AsyncGenerator<StreamEvent, void, undefined> {
  let started = false;
  let textOpen = false;
  let ended = false;
  let stopReason: StopReason = "endTurn";
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // Text is block 0 when present; tool calls take indices above it.
  const toolIndex = new Map<number, number>();
  let nextIndex = 1;

  const emitEnd = (): StreamEvent => {
    ended = true;
    return { type: "end", stopReason, usage };
  };

  for await (const msg of messages) {
    if (msg.data === "[DONE]") break;
    const d = json(msg.data);
    if (d === null) continue;

    if (!started) {
      started = true;
      yield { type: "start", id: String(d.id ?? ""), model: String(d.model ?? "") };
    }

    if (d.usage) {
      usage = {
        inputTokens: d.usage.prompt_tokens ?? 0,
        outputTokens: d.usage.completion_tokens ?? 0,
        cacheReadTokens: d.usage.prompt_cache_hit_tokens ?? 0,
        cacheWriteTokens: 0,
      };
    }

    const choice = d.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!textOpen) {
        textOpen = true;
        yield { type: "blockStart", index: 0, block: { type: "text" } };
      }
      yield { type: "blockDelta", index: 0, delta: { type: "text", text: delta.content } };
    }

    for (const call of delta.tool_calls ?? []) {
      const wireIndex: number = call.index ?? 0;
      let index = toolIndex.get(wireIndex);
      if (index === undefined) {
        index = nextIndex++;
        toolIndex.set(wireIndex, index);
        yield {
          type: "blockStart",
          index,
          block: {
            type: "toolUse",
            id: String(call.id ?? `call_${wireIndex}`),
            name: String(call.function?.name ?? ""),
          },
        };
      }
      const args = call.function?.arguments;
      if (typeof args === "string" && args.length > 0) {
        yield { type: "blockDelta", index, delta: { type: "toolJson", partial: args } };
      }
    }

    if (typeof choice.finish_reason === "string") {
      stopReason = FINISH[choice.finish_reason] ?? "endTurn";
      if (textOpen) yield { type: "blockEnd", index: 0 };
      for (const index of toolIndex.values()) yield { type: "blockEnd", index };
      yield emitEnd();
    }
  }

  // A stream that reaches [DONE] without a finish_reason still needs a terminal
  // event, or collect() would report an unterminated response.
  if (!ended) {
    if (textOpen) yield { type: "blockEnd", index: 0 };
    for (const index of toolIndex.values()) yield { type: "blockEnd", index };
    yield emitEnd();
  }
}
```

- [ ] **Step 5: Write the adapter**

`packages/providers/src/kimi/index.ts`:

```ts
import { GatewayError } from "@omni/ir";
import { httpError } from "../http.ts";
import { parseSse } from "../sse.ts";
import { type AdapterRequest, type AdapterResult, type ProviderAdapter, USER_AGENT } from "../types.ts";
import { decodeChat } from "./decode.ts";
import { toChatWire } from "./wire.ts";

const BASE_URL = "https://api.moonshot.ai/v1/chat/completions";

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  capabilities: { tools: true, images: false, reasoning: false },

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const { body, degradations } = toChatWire(req.request, req.model);
    const token = req.credentials.accessToken ?? req.credentials.apiKey;
    if (token === null) {
      throw new GatewayError("AUTH", "kimi credential has no token", { provider: "kimi" });
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
    };

    // Device identity is bound to the credential at OAuth time and must stay
    // stable; a changing device id forces re-authentication upstream.
    const deviceId = req.credentials.providerData.deviceId;
    if (typeof deviceId === "string") {
      headers["X-Msh-Device-Id"] = deviceId;
      headers["X-Msh-Platform"] = "cli";
    }

    const res = await fetch(BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, stream: true }),
      signal: req.signal,
    });

    if (!res.ok) throw await httpError(res, "kimi");
    if (res.body === null) throw new GatewayError("UPSTREAM", "empty response body", { provider: "kimi" });

    return { events: decodeChat(parseSse(res.body)), degradations };
  },
};

export { decodeChat, toChatWire };
```

- [ ] **Step 6: Write the registry**

`packages/providers/src/registry.ts`:

```ts
import type { ProviderId } from "@omni/ir";
import { anthropicAdapter } from "./anthropic/index.ts";
import { kimiAdapter } from "./kimi/index.ts";
import { openaiAdapter } from "./openai/index.ts";
import type { ProviderAdapter } from "./types.ts";

export const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  kimi: kimiAdapter,
};
```

- [ ] **Step 7: Export from the package index**

Append to `packages/providers/src/index.ts`:

```ts
export { kimiAdapter } from "./kimi/index.ts";
export { ADAPTERS } from "./registry.ts";
```

- [ ] **Step 8: Run the tests**

Run: `bun test packages/providers`
Expected: 42 pass, 0 fail.

- [ ] **Step 9: Commit**

```bash
git add packages/providers
git commit -m "feat(providers): add kimi adapter and provider registry"
```

---

## Task 12: Gateway app scaffold, routing snapshot, and model resolution

**Files:**
- Create: `apps/gateway/package.json`, `apps/gateway/tsconfig.json`, `apps/gateway/src/router/types.ts`, `apps/gateway/src/router/snapshot.ts`, `apps/gateway/src/router/resolve.ts`, `apps/gateway/test/helpers/fixtures.ts`
- Test: `apps/gateway/test/router/resolve.test.ts`

**Interfaces:**
- Consumes: `Store`, `CredentialView`, `CredentialHealth`, `QuotaWindow`, `VirtualModel`, `Settings`, `Target` (Tasks 5, 7); `ChatRequest`, `GatewayError` (Task 2).
- Produces:
  - `Snapshot`, `Candidate`, `Excluded`, `RankInput`, `RankResult` in `router/types.ts`
  - `buildSnapshot(store, now): Promise<Snapshot>` and `healthKey(credentialId, model): string`
  - `resolveModel(name, snapshot): VirtualModel` — throws `NO_CANDIDATES` when unresolvable
  - `credential(overrides?)`, `target(overrides?)`, `health(overrides?)`, `snapshot(parts?)` test factories in `test/helpers/fixtures.ts`, used by Tasks 13-15

**Why a snapshot.** The router is a pure function so it can be tested exhaustively without a database or a clock. Everything it needs — credentials, health, quota, models, settings, the current time — is gathered once per request into an immutable `Snapshot` and passed in. `buildSnapshot` is the only part that touches I/O.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/router/resolve.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { resolveModel } from "../../src/router/resolve.ts";
import { snapshot, target } from "../helpers/fixtures.ts";

test("resolves a configured virtual model by id", () => {
  const vm = {
    id: "fast",
    strategy: "score" as const,
    isAlias: false,
    targets: [target({ model: "claude-opus-4" })],
  };
  const resolved = resolveModel("fast", snapshot({ models: [vm] }));
  expect(resolved.id).toBe("fast");
  expect(resolved.targets).toHaveLength(1);
});

test("synthesises a single-target model from provider/model syntax", () => {
  const resolved = resolveModel("anthropic/claude-opus-4", snapshot({}));
  expect(resolved.isAlias).toBe(true);
  expect(resolved.strategy).toBe("score");
  expect(resolved.targets).toEqual([
    {
      provider: "anthropic",
      model: "claude-opus-4",
      tier: 1,
      weight: 1,
      costPerMTok: { input: 0, output: 0 },
      capabilities: { tools: true, images: true, reasoning: true },
    },
  ]);
});

test("accepts a colon separator as well as a slash", () => {
  expect(resolveModel("kimi:kimi-k2", snapshot({})).targets[0]?.model).toBe("kimi-k2");
});

test("keeps slashes inside the model portion intact", () => {
  const resolved = resolveModel("openai/org/gpt-5", snapshot({}));
  expect(resolved.targets[0]?.provider).toBe("openai");
  expect(resolved.targets[0]?.model).toBe("org/gpt-5");
});

test("takes capabilities from the registry for a synthesised target", () => {
  const resolved = resolveModel("kimi/kimi-k2", snapshot({}));
  expect(resolved.targets[0]?.capabilities).toEqual({
    tools: true,
    images: false,
    reasoning: false,
  });
});

test("infers the provider for a bare well-known model name", () => {
  const resolved = resolveModel("claude-sonnet-4-5", snapshot({}));
  expect(resolved.targets[0]?.provider).toBe("anthropic");
  expect(resolved.targets[0]?.model).toBe("claude-sonnet-4-5");
});

test("a configured virtual model wins over prefix inference", () => {
  const vm = {
    id: "claude-opus-4",
    strategy: "priority" as const,
    isAlias: false,
    targets: [target({ provider: "kimi" as const, model: "kimi-k2" })],
  };
  expect(resolveModel("claude-opus-4", snapshot({ models: [vm] })).targets[0]?.provider).toBe("kimi");
});

test("throws NO_CANDIDATES for an unresolvable name", () => {
  try {
    resolveModel("does-not-exist", snapshot({}));
    throw new Error("expected throw");
  } catch (e) {
    expect(e).toBeInstanceOf(GatewayError);
    expect((e as GatewayError).code).toBe("NO_CANDIDATES");
  }
});

test("rejects an unknown provider prefix rather than guessing", () => {
  expect(() => resolveModel("bedrock/claude", snapshot({}))).toThrow(GatewayError);
});
```

- [ ] **Step 2: Create the app package and run the test to see it fail**

`apps/gateway/package.json`:

```json
{
  "name": "@omni/gateway",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "start": "bun src/index.ts"
  },
  "dependencies": {
    "@omni/ir": "workspace:*",
    "@omni/providers": "workspace:*",
    "@omni/store": "workspace:*",
    "elysia": "1.4.29",
    "zod": "4.4.3"
  }
}
```

`apps/gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "test"]
}
```

Run: `bun install && bun test apps/gateway`
Expected: FAIL — cannot resolve `../../src/router/resolve.ts`.

- [ ] **Step 3: Write the router types**

`apps/gateway/src/router/types.ts`:

```ts
import type { ChatRequest } from "@omni/ir";
import type {
  CredentialHealth,
  CredentialView,
  QuotaWindow,
  Settings,
  Target,
  VirtualModel,
} from "@omni/store";

/**
 * Everything the router needs, gathered once per request.
 *
 * Held immutable for the life of a request so that two candidates ranked in the
 * same request see identical health and quota, and so ranking is reproducible
 * from its inputs alone.
 */
export type Snapshot = {
  credentials: CredentialView[];
  /** Keyed by `healthKey(credentialId, model)`. */
  health: ReadonlyMap<string, CredentialHealth>;
  /** Keyed by credential id. */
  quota: ReadonlyMap<string, QuotaWindow[]>;
  models: ReadonlyMap<string, VirtualModel>;
  settings: Settings;
  builtAt: number;
};

export type Candidate = {
  credential: CredentialView;
  target: Target;
  score: number;
  /** Per-term contributions, surfaced in the request log for debugging. */
  reasons: Record<string, number>;
};

export type Excluded = {
  credentialId: string;
  model: string;
  reason: string;
};

export type RankInput = {
  request: ChatRequest;
  model: VirtualModel;
  snapshot: Snapshot;
  now: number;
  /** Injected so weighted selection stays a pure function. Range [0, 1). */
  rand: number;
};

export type RankResult = {
  /** Best first. Dispatch walks this list on retryable failure. */
  candidates: Candidate[];
  excluded: Excluded[];
};
```

- [ ] **Step 4: Write the snapshot builder**

`apps/gateway/src/router/snapshot.ts`:

```ts
import type { QuotaWindow, Store } from "@omni/store";
import type { Snapshot } from "./types.ts";

/** Health is per (credential, model); this is the composite key. */
export function healthKey(credentialId: string, model: string): string {
  return `${credentialId} ${model}`;
}

export async function buildSnapshot(store: Store, now: number): Promise<Snapshot> {
  const [credentials, healthRows, quotaRows, models, settings] = await Promise.all([
    store.credentials.list(),
    store.credentials.listHealth(),
    store.credentials.listQuota(),
    store.config.listModels(),
    store.config.getSettings(),
  ]);

  const health = new Map(healthRows.map((h) => [healthKey(h.credentialId, h.model), h]));

  const quota = new Map<string, QuotaWindow[]>();
  for (const row of quotaRows) {
    const list = quota.get(row.credentialId);
    if (list === undefined) quota.set(row.credentialId, [row]);
    else list.push(row);
  }

  return {
    credentials,
    health,
    quota,
    models: new Map(models.map((m) => [m.id, m])),
    settings,
    builtAt: now,
  };
}
```

- [ ] **Step 5: Write model resolution**

`apps/gateway/src/router/resolve.ts`:

```ts
import { GatewayError, type ProviderId } from "@omni/ir";
import { ADAPTERS } from "@omni/providers";
import type { Target, VirtualModel } from "@omni/store";
import type { Snapshot } from "./types.ts";

const PROVIDERS = new Set<string>(Object.keys(ADAPTERS));

/**
 * Prefixes for bare model names, so a client can pass a concrete upstream model
 * without configuring a virtual model first. Longest match wins.
 */
const PREFIX_PROVIDER: ReadonlyArray<readonly [string, ProviderId]> = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["kimi-", "kimi"],
  ["moonshot", "kimi"],
];

function synthesize(provider: ProviderId, model: string): VirtualModel {
  const target: Target = {
    provider,
    model,
    tier: 1,
    weight: 1,
    // Unknown to the operator, so cost scoring contributes nothing and the
    // remaining terms decide. Configure a virtual model to price it.
    costPerMTok: { input: 0, output: 0 },
    capabilities: ADAPTERS[provider].capabilities,
  };
  return { id: `${provider}/${model}`, targets: [target], strategy: "score", isAlias: true };
}

/**
 * Turns a client-supplied model name into a virtual model.
 *
 * Concrete names become single-target virtual models so that routing has one
 * code path: a direct passthrough is just a degenerate load-balancing pool.
 */
export function resolveModel(name: string, snapshot: Snapshot): VirtualModel {
  const configured = snapshot.models.get(name);
  if (configured !== undefined) return configured;

  const sep = name.search(/[/:]/);
  if (sep > 0) {
    const prefix = name.slice(0, sep);
    const rest = name.slice(sep + 1);
    if (PROVIDERS.has(prefix) && rest.length > 0) {
      return synthesize(prefix as ProviderId, rest);
    }
    throw new GatewayError("NO_CANDIDATES", `unknown provider "${prefix}" in model "${name}"`);
  }

  for (const [prefix, provider] of PREFIX_PROVIDER) {
    if (name.startsWith(prefix)) return synthesize(provider, name);
  }

  throw new GatewayError(
    "NO_CANDIDATES",
    `model "${name}" is not a configured virtual model and its provider could not be inferred`,
  );
}
```

- [ ] **Step 6: Write the shared test fixtures**

`apps/gateway/test/helpers/fixtures.ts`:

```ts
import type {
  CredentialHealth,
  CredentialView,
  QuotaWindow,
  Settings,
  Target,
  VirtualModel,
} from "@omni/store";
import { DEFAULT_SETTINGS } from "@omni/store";
import { healthKey } from "../../src/router/snapshot.ts";
import type { Snapshot } from "../../src/router/types.ts";

let seq = 0;

/**
 * Secrets are synthetic. No test in this repo carries a real token, and the
 * thunk records whether ranking touched it.
 */
export function credential(overrides: Partial<CredentialView> = {}): CredentialView {
  const id = overrides.id ?? `cred-${++seq}`;
  return {
    id,
    provider: "anthropic",
    label: id,
    authType: "oauth",
    enabled: true,
    tier: 1,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: {},
    hasRefreshToken: true,
    createdAt: 0,
    updatedAt: 0,
    secrets: async () => ({
      accessToken: `test-token-${id}`,
      refreshToken: `test-refresh-${id}`,
      apiKey: null,
      idToken: null,
    }),
    ...overrides,
  };
}

export function target(overrides: Partial<Target> = {}): Target {
  return {
    provider: "anthropic",
    model: "claude-opus-4",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 15, output: 75 },
    capabilities: { tools: true, images: true, reasoning: true },
    ...overrides,
  };
}

export function health(overrides: Partial<CredentialHealth> = {}): CredentialHealth {
  return {
    credentialId: "cred-1",
    model: "claude-opus-4",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
    ...overrides,
  };
}

export function quota(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    credentialId: "cred-1",
    windowType: "fiveHour",
    startsAt: 0,
    used: 0,
    limit: null,
    ...overrides,
  };
}

export function snapshot(parts: {
  credentials?: CredentialView[];
  health?: CredentialHealth[];
  quota?: QuotaWindow[];
  models?: VirtualModel[];
  settings?: Partial<Settings>;
  builtAt?: number;
}): Snapshot {
  const quotaMap = new Map<string, QuotaWindow[]>();
  for (const row of parts.quota ?? []) {
    const list = quotaMap.get(row.credentialId);
    if (list === undefined) quotaMap.set(row.credentialId, [row]);
    else list.push(row);
  }

  return {
    credentials: parts.credentials ?? [],
    health: new Map((parts.health ?? []).map((h) => [healthKey(h.credentialId, h.model), h])),
    quota: quotaMap,
    models: new Map((parts.models ?? []).map((m) => [m.id, m])),
    settings: {
      ...DEFAULT_SETTINGS,
      ...parts.settings,
      weights: { ...DEFAULT_SETTINGS.weights, ...parts.settings?.weights },
    },
    builtAt: parts.builtAt ?? 1_000_000,
  };
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test apps/gateway`
Expected: 9 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): add routing snapshot and model resolution"
```

---

## Task 13: Candidate filters and scoring

**Files:**
- Create: `apps/gateway/src/router/filters.ts`, `apps/gateway/src/router/score.ts`, `apps/gateway/src/router/index.ts`
- Test: `apps/gateway/test/router/filters.test.ts`, `apps/gateway/test/router/rank.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `Candidate`, `Excluded`, `RankInput`, `RankResult` (Task 12); `healthKey`; fixtures.
- Produces:
  - `requiredCapabilities(request): Capabilities`
  - `eligible(input): { pairs: { credential; target }[]; excluded: Excluded[] }`
  - `score(pairs, input): Candidate[]`
  - `rank(input: RankInput): RankResult` — the router's whole public surface, re-exported from `router/index.ts` along with `buildSnapshot`, `healthKey`, and `resolveModel`

**Scoring model.** Each term is normalized to `0..1` where 1 is best, multiplied by its configured weight, and summed. Terms that cannot be computed contribute a neutral `0.5` rather than 0, so an unmeasured credential is not punished relative to a measured one. The final sum is multiplied by `credential.weight * target.weight`, which is how an operator biases traffic without editing weights that affect every model.

- [ ] **Step 1: Write the failing filter test**

`apps/gateway/test/router/filters.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { eligible, requiredCapabilities } from "../../src/router/filters.ts";
import { credential, health, quota, snapshot, target } from "../helpers/fixtures.ts";

const NOW = 1_000_000;

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const model = (targets = [target()]) => ({
  id: "fast",
  strategy: "score" as const,
  isAlias: false,
  targets,
});

test("derives required capabilities from the request", () => {
  expect(requiredCapabilities(req)).toEqual({ tools: false, images: false, reasoning: false });
  expect(
    requiredCapabilities({ ...req, tools: [{ name: "f", inputSchema: {} }] }).tools,
  ).toBe(true);
  expect(requiredCapabilities({ ...req, reasoning: { effort: "low" } }).reasoning).toBe(true);
  expect(
    requiredCapabilities({
      ...req,
      messages: [
        { role: "user", content: [{ type: "image", mediaType: "image/png", data: "A" }] },
      ],
    }).images,
  ).toBe(true);
});

test("pairs each target with every credential of its provider", () => {
  const a = credential({ id: "a", provider: "anthropic" });
  const k = credential({ id: "k", provider: "kimi" });
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [a, k] }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.credential.id).toBe("a");
});

test("excludes disabled credentials", () => {
  const { pairs, excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a", enabled: false })] }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(0);
  expect(excluded[0]).toEqual({ credentialId: "a", model: "claude-opus-4", reason: "disabled" });
});

test("excludes targets that lack a required capability", () => {
  const { pairs, excluded } = eligible({
    request: { ...req, tools: [{ name: "f", inputSchema: {} }] },
    model: model([target({ capabilities: { tools: false, images: true, reasoning: true } })]),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(0);
  expect(excluded[0]?.reason).toBe("capability:tools");
});

test("excludes an open breaker inside its cooldown", () => {
  const { pairs, excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [
        health({
          credentialId: "a",
          breakerState: "open",
          openedAt: NOW - 1_000,
          consecutiveFailures: 3,
        }),
      ],
    }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(0);
  expect(excluded[0]?.reason).toBe("breaker:open");
});

test("admits an open breaker whose cooldown has elapsed as a half-open probe", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [
        health({
          credentialId: "a",
          breakerState: "open",
          openedAt: NOW - 60_000,
          consecutiveFailures: 3,
        }),
      ],
    }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(1);
});

test("cooldown grows exponentially with consecutive failures", () => {
  // threshold 3, base cooldown 30s. At 5 failures the backoff is 30s * 2^2.
  const openedAt = NOW - 100_000;
  const build = (failures: number) =>
    eligible({
      request: req,
      model: model(),
      snapshot: snapshot({
        credentials: [credential({ id: "a" })],
        health: [
          health({
            credentialId: "a",
            breakerState: "open",
            openedAt,
            consecutiveFailures: failures,
          }),
        ],
      }),
      now: NOW,
      rand: 0,
    });
  expect(build(3).pairs).toHaveLength(1);
  expect(build(8).pairs).toHaveLength(0);
});

test("excludes a credential inside an observed rate-limit window", () => {
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [health({ credentialId: "a", rateLimitedUntil: NOW + 5_000 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(excluded[0]?.reason).toBe("rateLimited");
});

test("an expired rate-limit window no longer excludes", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      health: [health({ credentialId: "a", rateLimitedUntil: NOW - 1 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(1);
});

test("excludes a credential whose configured quota is spent", () => {
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      quota: [quota({ credentialId: "a", used: 100, limit: 100 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(excluded[0]?.reason).toBe("quota:fiveHour");
});

test("a quota window with no configured limit never excludes", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      quota: [quota({ credentialId: "a", used: 10_000, limit: null })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(1);
});

test("excludes an expired credential that cannot be refreshed", () => {
  const dead = credential({ id: "a", expiresAt: NOW - 1, hasRefreshToken: false });
  const { excluded } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [dead] }),
    now: NOW,
    rand: 0,
  });
  expect(excluded[0]?.reason).toBe("expired");
});

test("keeps an expired credential that has a refresh token", () => {
  const { pairs } = eligible({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a", expiresAt: NOW - 1 })] }),
    now: NOW,
    rand: 0,
  });
  expect(pairs).toHaveLength(1);
});

test("api-key credentials are never treated as expired", () => {
  const key = credential({
    id: "a",
    authType: "apiKey",
    expiresAt: NOW - 1,
    hasRefreshToken: false,
    secrets: async () => ({ accessToken: null, refreshToken: null, apiKey: "k", idToken: null }),
  });
  expect(
    eligible({
      request: req,
      model: model(),
      snapshot: snapshot({ credentials: [key] }),
      now: NOW,
      rand: 0,
    }).pairs,
  ).toHaveLength(1);
});
```

- [ ] **Step 2: Write the failing rank test**

`apps/gateway/test/router/rank.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import { rank } from "../../src/router/index.ts";
import { credential, health, quota, snapshot, target } from "../helpers/fixtures.ts";

const NOW = 1_000_000;

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

const model = (targets = [target()], strategy: "score" | "priority" | "roundRobin" | "weighted" = "score") => ({
  id: "fast",
  strategy,
  isAlias: false,
  targets,
});

test("ranking never decrypts a credential", async () => {
  let opened = 0;
  const spy = credential({
    id: "a",
    secrets: async () => {
      opened++;
      return { accessToken: "t", refreshToken: "r", apiKey: null, idToken: null };
    },
  });
  rank({ request: req, model: model(), snapshot: snapshot({ credentials: [spy] }), now: NOW, rand: 0 });
  expect(opened).toBe(0);
});

test("prefers the lower tier when everything else is equal", () => {
  const { candidates } = rank({
    request: req,
    model: model([target({ model: "cheap", tier: 2 }), target({ model: "premium", tier: 1 })]),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.target.model).toBe("premium");
});

test("prefers the healthier credential at the same tier", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "sick" }), credential({ id: "well" })],
      health: [health({ credentialId: "sick", consecutiveFailures: 2 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("well");
});

test("prefers the cheaper target when cost is the only weighted term", () => {
  const { candidates } = rank({
    request: req,
    model: model([
      target({ model: "pricey", costPerMTok: { input: 15, output: 75 } }),
      target({ model: "thrifty", costPerMTok: { input: 1, output: 3 } }),
    ]),
    snapshot: snapshot({
      credentials: [credential({ id: "a" })],
      settings: { weights: { tier: 0, health: 0, quota: 0, cost: 1, latency: 0, recency: 0 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.target.model).toBe("thrifty");
});

test("prefers the faster credential when latency is the only weighted term", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "slow" }), credential({ id: "quick" })],
      health: [
        health({ credentialId: "slow", ewmaTtftMs: 3000 }),
        health({ credentialId: "quick", ewmaTtftMs: 200 }),
      ],
      settings: { weights: { tier: 0, health: 0, quota: 0, cost: 0, latency: 1, recency: 0 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("quick");
});

test("prefers the credential with more quota headroom", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "drained" }), credential({ id: "fresh" })],
      quota: [
        quota({ credentialId: "drained", used: 90, limit: 100 }),
        quota({ credentialId: "fresh", used: 10, limit: 100 }),
      ],
      settings: { weights: { tier: 0, health: 0, quota: 1, cost: 0, latency: 0, recency: 0 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("fresh");
});

test("recency spreads load toward the least recently used credential", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "hot" }), credential({ id: "cold" })],
      health: [
        health({ credentialId: "hot", lastUsedAt: NOW - 1_000 }),
        health({ credentialId: "cold", lastUsedAt: NOW - 600_000 }),
      ],
      settings: { weights: { tier: 0, health: 0, quota: 0, cost: 0, latency: 0, recency: 1 } },
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("cold");
});

test("credential weight multiplies the final score", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({
      credentials: [credential({ id: "light", weight: 1 }), credential({ id: "heavy", weight: 5 })],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("heavy");
});

test("priority strategy sorts by tier and ignores other terms", () => {
  const { candidates } = rank({
    request: req,
    model: model(
      [target({ model: "tier2", tier: 2, costPerMTok: { input: 0, output: 0 } }), target({ model: "tier1", tier: 1 })],
      "priority",
    ),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(candidates.map((c) => c.target.model)).toEqual(["tier1", "tier2"]);
});

test("roundRobin puts the least recently used credential first", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "roundRobin"),
    snapshot: snapshot({
      credentials: [credential({ id: "a" }), credential({ id: "b" })],
      health: [
        health({ credentialId: "a", lastUsedAt: NOW }),
        health({ credentialId: "b", lastUsedAt: NOW - 10 }),
      ],
    }),
    now: NOW,
    rand: 0,
  });
  expect(candidates[0]?.credential.id).toBe("b");
});

test("weighted selection is deterministic in the injected random value", () => {
  const snap = snapshot({
    credentials: [credential({ id: "a", weight: 1 }), credential({ id: "b", weight: 9 })],
  });
  const pick = (rand: number) =>
    rank({ request: req, model: model([target()], "weighted"), snapshot: snap, now: NOW, rand })
      .candidates[0]?.credential.id;
  expect(pick(0.05)).toBe("a");
  expect(pick(0.5)).toBe("b");
  expect(pick(0.05)).toBe("a");
});

test("weighted ranking still returns every candidate for failover", () => {
  const { candidates } = rank({
    request: req,
    model: model([target()], "weighted"),
    snapshot: snapshot({
      credentials: [credential({ id: "a" }), credential({ id: "b" }), credential({ id: "c" })],
    }),
    now: NOW,
    rand: 0.5,
  });
  expect(candidates).toHaveLength(3);
  expect(new Set(candidates.map((c) => c.credential.id)).size).toBe(3);
});

test("returns an empty list with reasons when nothing is eligible", () => {
  const { candidates, excluded } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a", enabled: false })] }),
    now: NOW,
    rand: 0,
  });
  expect(candidates).toEqual([]);
  expect(excluded).toHaveLength(1);
});

test("candidates carry their per-term reasons", () => {
  const { candidates } = rank({
    request: req,
    model: model(),
    snapshot: snapshot({ credentials: [credential({ id: "a" })] }),
    now: NOW,
    rand: 0,
  });
  expect(Object.keys(candidates[0]?.reasons ?? {}).sort()).toEqual([
    "cost",
    "health",
    "latency",
    "quota",
    "recency",
    "tier",
  ]);
});

test("ranking is stable for identical inputs", () => {
  const snap = snapshot({
    credentials: [credential({ id: "a" }), credential({ id: "b" }), credential({ id: "c" })],
  });
  const ids = () =>
    rank({ request: req, model: model(), snapshot: snap, now: NOW, rand: 0 }).candidates.map(
      (c) => c.credential.id,
    );
  expect(ids()).toEqual(ids());
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test apps/gateway/test/router`
Expected: FAIL — cannot resolve `../../src/router/filters.ts`.

- [ ] **Step 4: Write the filters**

`apps/gateway/src/router/filters.ts`:

```ts
import type { ChatRequest } from "@omni/ir";
import type { Capabilities } from "@omni/providers";
import type { CredentialView, Target } from "@omni/store";
import { healthKey } from "./snapshot.ts";
import type { Excluded, RankInput } from "./types.ts";

export type Pair = { credential: CredentialView; target: Target };

/** What the request actually needs, so targets can be filtered on it. */
export function requiredCapabilities(request: ChatRequest): Capabilities {
  const images = request.messages.some((m) => m.content.some((b) => b.type === "image"));
  return {
    tools: (request.tools?.length ?? 0) > 0,
    images,
    reasoning: request.reasoning !== undefined,
  };
}

/**
 * Backoff for an open breaker: base cooldown doubled per failure past the
 * threshold, capped so a long-dead credential is still probed hourly.
 */
function cooldownMs(failures: number, threshold: number, base: number): number {
  const over = Math.max(0, failures - threshold);
  return Math.min(base * 2 ** over, 3_600_000);
}

export function eligible(input: RankInput): { pairs: Pair[]; excluded: Excluded[] } {
  const { request, model, snapshot, now } = input;
  const { breakerThreshold, breakerCooldownMs } = snapshot.settings;
  const need = requiredCapabilities(request);

  const pairs: Pair[] = [];
  const excluded: Excluded[] = [];

  for (const target of model.targets) {
    const missing = (["tools", "images", "reasoning"] as const).find(
      (cap) => need[cap] && !target.capabilities[cap],
    );

    for (const credential of snapshot.credentials) {
      if (credential.provider !== target.provider) continue;

      const drop = (reason: string): void => {
        excluded.push({ credentialId: credential.id, model: target.model, reason });
      };

      if (missing !== undefined) {
        drop(`capability:${missing}`);
        continue;
      }
      if (!credential.enabled) {
        drop("disabled");
        continue;
      }

      // An OAuth credential past expiry is usable only if it can be refreshed;
      // dispatch performs the refresh before the call.
      if (
        credential.authType === "oauth" &&
        credential.expiresAt !== null &&
        credential.expiresAt <= now &&
        !credential.hasRefreshToken
      ) {
        drop("expired");
        continue;
      }

      const h = snapshot.health.get(healthKey(credential.id, target.model));
      if (h !== undefined) {
        if (h.rateLimitedUntil !== null && h.rateLimitedUntil > now) {
          drop("rateLimited");
          continue;
        }
        if (h.breakerState === "open") {
          const elapsed = now - (h.openedAt ?? now);
          if (elapsed < cooldownMs(h.consecutiveFailures, breakerThreshold, breakerCooldownMs)) {
            drop("breaker:open");
            continue;
          }
          // Cooldown elapsed: admitted as a half-open probe.
        }
      }

      const spent = (snapshot.quota.get(credential.id) ?? []).find(
        (w) => w.limit !== null && w.used >= w.limit,
      );
      if (spent !== undefined) {
        drop(`quota:${spent.windowType}`);
        continue;
      }

      pairs.push({ credential, target });
    }
  }

  return { pairs, excluded };
}
```

`hasRefreshToken` comes from `Credential` (Task 5) and is derived from the stored column at read time, so this check costs no decryption.

- [ ] **Step 5: Write the scorer**

`apps/gateway/src/router/score.ts`:

```ts
import { healthKey } from "./snapshot.ts";
import type { Pair } from "./filters.ts";
import type { Candidate, RankInput } from "./types.ts";

/** Neutral value for a term with no data — neither rewarded nor punished. */
const UNKNOWN = 0.5;

/** Maps a raw value into 0..1 where the minimum observed scores 1. */
function lowerIsBetter(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return (max - value) / (max - min);
}

/**
 * Blends input and output price into one number. Output dominates real spend on
 * chat workloads, so it carries three quarters of the weight.
 */
function blendedCost(input: number, output: number): number {
  return input * 0.25 + output * 0.75;
}

export function score(pairs: Pair[], input: RankInput): Candidate[] {
  const { snapshot, now } = input;
  const w = snapshot.settings.weights;

  const tiers = pairs.map((p) => p.target.tier);
  const minTier = Math.min(...tiers);
  const maxTier = Math.max(...tiers);

  const costs = pairs.map((p) => blendedCost(p.target.costPerMTok.input, p.target.costPerMTok.output));
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const latencies = pairs.flatMap((p) => {
    const h = snapshot.health.get(healthKey(p.credential.id, p.target.model));
    return h?.ewmaTtftMs != null ? [h.ewmaTtftMs] : [];
  });
  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  const idleTimes = pairs.map((p) => {
    const h = snapshot.health.get(healthKey(p.credential.id, p.target.model));
    return h?.lastUsedAt == null ? Number.POSITIVE_INFINITY : now - h.lastUsedAt;
  });
  const finiteIdle = idleTimes.filter(Number.isFinite);
  const maxIdle = finiteIdle.length > 0 ? Math.max(...finiteIdle) : 1;

  return pairs.map((pair, i) => {
    const h = snapshot.health.get(healthKey(pair.credential.id, pair.target.model));

    const tier = lowerIsBetter(pair.target.tier, minTier, maxTier);

    // A half-open probe is worth trying but should lose to a healthy peer.
    let health = 1 / (1 + (h?.consecutiveFailures ?? 0));
    if (h?.breakerState === "open" || h?.breakerState === "halfOpen") health *= 0.5;

    const windows = snapshot.quota.get(pair.credential.id) ?? [];
    const limited = windows.filter((q) => q.limit !== null);
    const quota =
      limited.length === 0
        ? 1
        : Math.min(...limited.map((q) => Math.max(0, 1 - q.used / (q.limit as number))));

    // A zero-priced target means "unpriced", not "free"; treat it as unknown.
    const cost =
      maxCost === 0 ? UNKNOWN : lowerIsBetter(costs[i] as number, minCost, maxCost);

    const latency =
      h?.ewmaTtftMs == null ? UNKNOWN : lowerIsBetter(h.ewmaTtftMs, minLatency, maxLatency);

    const idle = idleTimes[i] as number;
    const recency = Number.isFinite(idle) ? Math.min(1, idle / (maxIdle || 1)) : 1;

    const reasons = { tier, health, quota, cost, latency, recency };
    const base =
      tier * w.tier +
      health * w.health +
      quota * w.quota +
      cost * w.cost +
      latency * w.latency +
      recency * w.recency;

    return {
      credential: pair.credential,
      target: pair.target,
      score: base * pair.credential.weight * pair.target.weight,
      reasons,
    };
  });
}
```

- [ ] **Step 6: Write the router entry point**

`apps/gateway/src/router/index.ts`:

```ts
import { eligible } from "./filters.ts";
import { score } from "./score.ts";
import { healthKey } from "./snapshot.ts";
import type { Candidate, RankInput, RankResult } from "./types.ts";

/**
 * Reorders candidates by a weighted lottery.
 *
 * Only the head is drawn by weight; the tail keeps score order so failover
 * still walks the best remaining options. `rand` is injected, so the whole
 * router stays pure and a test can pin the draw.
 */
function weightedShuffle(candidates: Candidate[], rand: number): Candidate[] {
  const total = candidates.reduce((sum, c) => sum + c.credential.weight * c.target.weight, 0);
  if (total <= 0) return candidates;

  let cursor = rand * total;
  let chosen = candidates.length - 1;
  for (let i = 0; i < candidates.length; i++) {
    cursor -= (candidates[i] as Candidate).credential.weight * (candidates[i] as Candidate).target.weight;
    if (cursor < 0) {
      chosen = i;
      break;
    }
  }

  const head = candidates[chosen] as Candidate;
  return [head, ...candidates.filter((_, i) => i !== chosen)];
}

export function rank(input: RankInput): RankResult {
  const { pairs, excluded } = eligible(input);
  if (pairs.length === 0) return { candidates: [], excluded };

  const scored = score(pairs, input);

  switch (input.model.strategy) {
    case "priority":
      // Tier is the only signal; score breaks ties within a tier.
      scored.sort((a, b) => a.target.tier - b.target.tier || b.score - a.score);
      break;

    case "roundRobin": {
      const idle = (c: Candidate): number => {
        const h = input.snapshot.health.get(healthKey(c.credential.id, c.target.model));
        return h?.lastUsedAt == null ? Number.POSITIVE_INFINITY : input.now - h.lastUsedAt;
      };
      scored.sort((a, b) => idle(b) - idle(a));
      break;
    }

    case "weighted":
      scored.sort((a, b) => b.score - a.score);
      return { candidates: weightedShuffle(scored, input.rand), excluded };

    case "score":
      scored.sort((a, b) => b.score - a.score);
      break;
  }

  return { candidates: scored, excluded };
}

export { buildSnapshot, healthKey } from "./snapshot.ts";
export { resolveModel } from "./resolve.ts";
export { requiredCapabilities } from "./filters.ts";
export type { Candidate, Excluded, RankInput, RankResult, Snapshot } from "./types.ts";
```

- [ ] **Step 7: Run the tests**

Run: `bun test apps/gateway`
Expected: 39 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): add candidate filtering and weighted scoring"
```

---

## Task 14: Health tracking and the circuit breaker

**Files:**
- Create: `apps/gateway/src/router/breaker.ts`
- Test: `apps/gateway/test/router/breaker.test.ts`

**Interfaces:**
- Consumes: `CredentialHealth`, `Settings` (Task 5); `ErrorCode` (Task 2).
- Produces:
  - `recordSuccess(current, opts): CredentialHealth`
  - `recordFailure(current, opts): CredentialHealth`
  - `blankHealth(credentialId, model): CredentialHealth`
  - `PENALTY: Readonly<Record<ErrorCode, "none" | "soft" | "hard">>`

Both record functions are pure: they take the prior health row and return the next one. Dispatch (Task 15) persists whatever they return. `now` and any jitter are passed in, never read from the environment.

**Penalty classes.** Not every failure means the credential is bad.
- `hard` — the credential itself failed (`AUTH`, `UPSTREAM`, `TIMEOUT`, `NETWORK`). Increments the failure count and can open the breaker.
- `soft` — the credential is fine but temporarily unusable (`RATE_LIMIT`, `QUOTA_EXHAUSTED`, `OVERLOADED`). Sets `rateLimitedUntil` and leaves the breaker alone.
- `none` — the request was at fault (`BAD_REQUEST`, `CONTENT_FILTER`, `CAPABILITY_MISMATCH`). Records nothing; the next candidate is tried with no health change.

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/router/breaker.test.ts`:

```ts
import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import { PENALTY, blankHealth, recordFailure, recordSuccess } from "../../src/router/breaker.ts";
import { health } from "../helpers/fixtures.ts";

const NOW = 1_000_000;
const opts = { settings: DEFAULT_SETTINGS, now: NOW, jitter: 0 };

test("blank health starts closed with no failures", () => {
  const h = blankHealth("c1", "m");
  expect(h).toEqual({
    credentialId: "c1",
    model: "m",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
  });
});

test("success clears failures and closes the breaker", () => {
  const next = recordSuccess(
    health({ breakerState: "open", consecutiveFailures: 5, openedAt: NOW - 1000 }),
    { ...opts, ttftMs: 400 },
  );
  expect(next.breakerState).toBe("closed");
  expect(next.consecutiveFailures).toBe(0);
  expect(next.openedAt).toBeNull();
  expect(next.lastUsedAt).toBe(NOW);
});

test("success clears a stale rate-limit window", () => {
  const next = recordSuccess(health({ rateLimitedUntil: NOW + 5000 }), { ...opts, ttftMs: 100 });
  expect(next.rateLimitedUntil).toBeNull();
});

test("first latency sample seeds the ewma directly", () => {
  expect(recordSuccess(health(), { ...opts, ttftMs: 500 }).ewmaTtftMs).toBe(500);
});

test("subsequent latency samples blend at alpha 0.3", () => {
  const next = recordSuccess(health({ ewmaTtftMs: 1000 }), { ...opts, ttftMs: 500 });
  expect(next.ewmaTtftMs).toBeCloseTo(850, 5);
});

test("a success with no measured ttft leaves the ewma untouched", () => {
  expect(recordSuccess(health({ ewmaTtftMs: 700 }), { ...opts, ttftMs: null }).ewmaTtftMs).toBe(700);
});

test("hard failures accumulate without opening below the threshold", () => {
  const next = recordFailure(health(), { ...opts, code: "UPSTREAM" });
  expect(next.consecutiveFailures).toBe(1);
  expect(next.breakerState).toBe("closed");
});

test("the breaker opens once the threshold is reached", () => {
  const next = recordFailure(health({ consecutiveFailures: 2 }), { ...opts, code: "UPSTREAM" });
  expect(next.consecutiveFailures).toBe(3);
  expect(next.breakerState).toBe("open");
  expect(next.openedAt).toBe(NOW);
});

test("a failure on a half-open probe reopens immediately", () => {
  const next = recordFailure(health({ breakerState: "halfOpen", consecutiveFailures: 1 }), {
    ...opts,
    code: "NETWORK",
  });
  expect(next.breakerState).toBe("open");
  expect(next.openedAt).toBe(NOW);
});

test("an auth failure opens the breaker on the first occurrence", () => {
  const next = recordFailure(health(), { ...opts, code: "AUTH" });
  expect(next.breakerState).toBe("open");
  expect(next.consecutiveFailures).toBe(1);
});

test("a rate limit sets a window without touching the breaker", () => {
  const next = recordFailure(health(), { ...opts, code: "RATE_LIMIT", retryAfterMs: 30_000 });
  expect(next.rateLimitedUntil).toBe(NOW + 30_000);
  expect(next.breakerState).toBe("closed");
  expect(next.consecutiveFailures).toBe(0);
});

test("a rate limit with no retry-after falls back to the default window", () => {
  const next = recordFailure(health(), { ...opts, code: "RATE_LIMIT" });
  expect(next.rateLimitedUntil).toBe(NOW + 60_000);
});

test("jitter spreads the rate-limit window so credentials do not resume in lockstep", () => {
  const a = recordFailure(health(), { ...opts, code: "RATE_LIMIT", retryAfterMs: 10_000, jitter: 0 });
  const b = recordFailure(health(), { ...opts, code: "RATE_LIMIT", retryAfterMs: 10_000, jitter: 1 });
  expect(b.rateLimitedUntil as number).toBeGreaterThan(a.rateLimitedUntil as number);
  expect((b.rateLimitedUntil as number) - (a.rateLimitedUntil as number)).toBeLessThanOrEqual(2_000);
});

test("quota exhaustion parks the credential for an hour", () => {
  const next = recordFailure(health(), { ...opts, code: "QUOTA_EXHAUSTED" });
  expect(next.rateLimitedUntil).toBe(NOW + 3_600_000);
});

test("request-level errors change nothing", () => {
  const before = health({ consecutiveFailures: 1, ewmaTtftMs: 300 });
  expect(recordFailure(before, { ...opts, code: "BAD_REQUEST" })).toEqual(before);
  expect(recordFailure(before, { ...opts, code: "CAPABILITY_MISMATCH" })).toEqual(before);
  expect(recordFailure(before, { ...opts, code: "CONTENT_FILTER" })).toEqual(before);
});

test("every error code has a penalty class", () => {
  for (const cls of Object.values(PENALTY)) {
    expect(["none", "soft", "hard"]).toContain(cls);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/gateway/test/router/breaker.test.ts`
Expected: FAIL — cannot resolve `../../src/router/breaker.ts`.

- [ ] **Step 3: Write the breaker**

`apps/gateway/src/router/breaker.ts`:

```ts
import type { ErrorCode } from "@omni/ir";
import type { CredentialHealth, Settings } from "@omni/store";

export type Penalty = "none" | "soft" | "hard";

/**
 * How a failure reflects on the credential.
 *
 * `hard` blames the credential, `soft` parks it briefly, `none` blames the
 * request and leaves health untouched so a malformed prompt cannot walk the
 * whole pool into an open breaker.
 */
export const PENALTY: Readonly<Record<ErrorCode, Penalty>> = {
  AUTH: "hard",
  UPSTREAM: "hard",
  TIMEOUT: "hard",
  NETWORK: "hard",
  MODEL_UNAVAILABLE: "hard",
  RATE_LIMIT: "soft",
  QUOTA_EXHAUSTED: "soft",
  OVERLOADED: "soft",
  BAD_REQUEST: "none",
  CONTENT_FILTER: "none",
  CAPABILITY_MISMATCH: "none",
  NO_CANDIDATES: "none",
  ALL_CANDIDATES_FAILED: "none",
  INTERNAL: "none",
};

/** Weight of the newest latency sample. Low enough to ride out one slow call. */
const EWMA_ALPHA = 0.3;
const DEFAULT_RATE_LIMIT_MS = 60_000;
const QUOTA_PARK_MS = 3_600_000;
const MAX_JITTER_MS = 2_000;

export function blankHealth(credentialId: string, model: string): CredentialHealth {
  return {
    credentialId,
    model,
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
  };
}

export function recordSuccess(
  current: CredentialHealth,
  opts: { settings: Settings; now: number; ttftMs: number | null },
): CredentialHealth {
  const ewma =
    opts.ttftMs === null
      ? current.ewmaTtftMs
      : current.ewmaTtftMs === null
        ? opts.ttftMs
        : current.ewmaTtftMs * (1 - EWMA_ALPHA) + opts.ttftMs * EWMA_ALPHA;

  return {
    ...current,
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: ewma,
    lastUsedAt: opts.now,
  };
}

export function recordFailure(
  current: CredentialHealth,
  opts: {
    settings: Settings;
    now: number;
    code: ErrorCode;
    retryAfterMs?: number;
    /** 0..1, injected so the jittered window stays testable. */
    jitter?: number;
  },
): CredentialHealth {
  const penalty = PENALTY[opts.code];
  if (penalty === "none") return current;

  if (penalty === "soft") {
    const base =
      opts.code === "QUOTA_EXHAUSTED"
        ? QUOTA_PARK_MS
        : (opts.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS);
    // Jitter keeps a pool that rate-limited together from resuming together.
    const until = opts.now + base + Math.round((opts.jitter ?? 0) * MAX_JITTER_MS);
    return { ...current, rateLimitedUntil: until, lastUsedAt: opts.now };
  }

  const failures = current.consecutiveFailures + 1;
  // A bad token will not fix itself, and a failed probe means the credential is
  // still down; both open immediately rather than burning the threshold.
  const open =
    opts.code === "AUTH" ||
    current.breakerState === "halfOpen" ||
    failures >= opts.settings.breakerThreshold;

  return {
    ...current,
    consecutiveFailures: failures,
    breakerState: open ? "open" : "closed",
    openedAt: open ? opts.now : current.openedAt,
    lastUsedAt: opts.now,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/gateway`
Expected: 55 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): add circuit breaker and health tracking"
```

---

## Task 15: Dispatch — failover, the commit point, and health writeback

**Files:**
- Create: `apps/gateway/src/dispatch/classify.ts`, `apps/gateway/src/dispatch/attempt.ts`, `apps/gateway/src/dispatch/index.ts`
- Test: `apps/gateway/test/dispatch/classify.test.ts`, `apps/gateway/test/dispatch/dispatch.test.ts`

**Interfaces:**
- Consumes: `rank`, `resolveModel`, `buildSnapshot`, `healthKey`, `Candidate` (Tasks 12-13); `recordSuccess`, `recordFailure`, `blankHealth`, `PENALTY` (Task 14); `ADAPTERS`, `ProviderAdapter` (Task 11); `Store`, `CredentialView` (Tasks 5-7).
- Produces:
  - `classify(error): { code: ErrorCode; retryAfterMs?: number }`
  - `DispatchDeps = { store; adapters; now: () => number; rand: () => number; refresh: (c: CredentialView) => Promise<CredentialSecrets> }`
  - `dispatch(request, deps, signal): Promise<DispatchOutcome>` where `DispatchOutcome = { events: AsyncGenerator<StreamEvent>; log: () => RequestLog }`

**The commit point.** Failover is only possible while nothing has reached the client. Dispatch treats the first `blockDelta` as the commit point: before it, a retryable error advances to the next candidate invisibly; after it, the error is forwarded as an `error` event in the live stream, because the bytes already sent cannot be recalled. The `start` event is deliberately *not* the commit point — providers routinely return 200 and a `message_start` before failing.

**Refresh is injected.** `deps.refresh` is supplied by Task 23. Dispatch only knows that an expired OAuth credential needs one call before use.

- [ ] **Step 1: Write the failing classify test**

`apps/gateway/test/dispatch/classify.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { classify } from "../../src/dispatch/classify.ts";

test("passes a gateway error through with its retry hint", () => {
  const e = new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 5000 });
  expect(classify(e)).toEqual({ code: "RATE_LIMIT", retryAfterMs: 5000 });
});

test("maps an abort to TIMEOUT", () => {
  const e = new DOMException("aborted", "AbortError");
  expect(classify(e).code).toBe("TIMEOUT");
});

test("maps a fetch failure to NETWORK", () => {
  expect(classify(new TypeError("fetch failed")).code).toBe("NETWORK");
});

test("maps connection errors to NETWORK", () => {
  expect(classify(new Error("ECONNREFUSED 1.2.3.4:443")).code).toBe("NETWORK");
  expect(classify(new Error("Unable to connect")).code).toBe("NETWORK");
});

test("falls back to INTERNAL for anything unrecognised", () => {
  expect(classify(new Error("something odd")).code).toBe("INTERNAL");
  expect(classify("a string").code).toBe("INTERNAL");
});
```

- [ ] **Step 2: Write the failing dispatch test**

`apps/gateway/test/dispatch/dispatch.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GatewayError, type ChatRequest, type StreamEvent } from "@omni/ir";
import type { ProviderAdapter } from "@omni/providers";
import { deriveKey, createStore } from "@omni/store";
import type { Store } from "@omni/store";
import { dispatch } from "../../src/dispatch/index.ts";

const req: ChatRequest = {
  model: "fast",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  stream: true,
};

async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: "start", id: "m", model: "claude-opus-4" };
  yield { type: "blockStart", index: 0, block: { type: "text" } };
  yield { type: "blockDelta", index: 0, delta: { type: "text", text } };
  yield { type: "blockEnd", index: 0 };
  yield {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/** Records every call so a test can assert which credential was used. */
function stubAdapter(
  behaviour: (call: number) => AsyncGenerator<StreamEvent> | Error,
): ProviderAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    calls,
    async send(r) {
      calls.push(r.credentials.accessToken ?? "none");
      const result = behaviour(calls.length);
      if (result instanceof Error) throw result;
      return { events: result, degradations: [] };
    },
  };
}

async function seeded(credentials: number): Promise<Store> {
  const store = await createStore({
    path: ":memory:",
    encryptionKey: await deriveKey("test-secret-value-for-unit-tests"),
  });
  for (let i = 1; i <= credentials; i++) {
    await store.credentials.create({
      id: `c${i}`,
      provider: "anthropic",
      label: `c${i}`,
      authType: "oauth",
      enabled: true,
      tier: 1,
      weight: 1,
      expiresAt: null,
      accountEmail: null,
      providerData: {},
      accessToken: `test-token-${i}`,
      refreshToken: `test-refresh-${i}`,
      apiKey: null,
      idToken: null,
    });
  }
  await store.config.putModel({
    id: "fast",
    strategy: "priority",
    isAlias: false,
    targets: [
      {
        provider: "anthropic",
        model: "claude-opus-4",
        tier: 1,
        weight: 1,
        costPerMTok: { input: 15, output: 75 },
        capabilities: { tools: true, images: true, reasoning: true },
      },
    ],
  });
  return store;
}

function deps(store: Store, adapter: ProviderAdapter) {
  return {
    store,
    adapters: { anthropic: adapter, openai: adapter, kimi: adapter },
    now: () => 1_000_000,
    rand: () => 0,
    refresh: async () => ({
      accessToken: "refreshed",
      refreshToken: "r",
      apiKey: null,
      idToken: null,
    }),
  };
}

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

test("streams a successful response and logs it", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hello"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(events.at(-1)).toMatchObject({ type: "end" });
  const log = outcome.log();
  expect(log.status).toBe(200);
  expect(log.attempts).toBe(1);
  expect(log.inputTokens).toBe(10);
  expect(log.resolvedModel).toBe("claude-opus-4");
  store.close();
});

test("fails over to the next credential before the commit point", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) =>
    call === 1 ? new GatewayError("UPSTREAM", "boom") : textStream("recovered"),
  );
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(events.some((e) => e.type === "blockDelta")).toBe(true);
  expect(outcome.log().attempts).toBe(2);
  expect(outcome.log().status).toBe(200);
  store.close();
});

test("a failure after the commit point surfaces as an error event, not a retry", async () => {
  const store = await seeded(2);
  const adapter = stubAdapter((call) => {
    if (call > 1) return textStream("should not be reached");
    return (async function* () {
      yield { type: "start", id: "m", model: "claude-opus-4" } as StreamEvent;
      yield { type: "blockStart", index: 0, block: { type: "text" } } as StreamEvent;
      yield { type: "blockDelta", index: 0, delta: { type: "text", text: "partial" } } as StreamEvent;
      throw new GatewayError("UPSTREAM", "died mid-stream");
    })();
  });

  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "error", code: "UPSTREAM" });
  expect(outcome.log().status).toBe(502);
  store.close();
});

test("a non-retryable error stops immediately without trying other credentials", async () => {
  const store = await seeded(3);
  const adapter = stubAdapter(() => new GatewayError("BAD_REQUEST", "malformed"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(adapter.calls).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "error", code: "BAD_REQUEST" });
  expect(outcome.log().status).toBe(400);
  store.close();
});

test("stops after maxAttempts even with candidates remaining", async () => {
  const store = await seeded(5);
  await store.config.putSettings({ maxAttempts: 2 });
  const adapter = stubAdapter(() => new GatewayError("UPSTREAM", "boom"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  await drain(outcome.events);

  expect(adapter.calls).toHaveLength(2);
  expect(outcome.log().errorCode).toBe("ALL_CANDIDATES_FAILED");
  store.close();
});

test("emits NO_CANDIDATES when the pool is empty", async () => {
  const store = await seeded(0);
  const adapter = stubAdapter(() => textStream("x"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  const events = await drain(outcome.events);

  expect(events[0]).toMatchObject({ type: "error", code: "NO_CANDIDATES" });
  expect(outcome.log().status).toBe(503);
  store.close();
});

test("a hard failure opens the breaker and persists it", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1, breakerThreshold: 1 });
  const adapter = stubAdapter(() => new GatewayError("UPSTREAM", "boom"));
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.breakerState).toBe("open");
  expect(rows[0]?.consecutiveFailures).toBe(1);
  store.close();
});

test("a rate limit parks the credential without opening the breaker", async () => {
  const store = await seeded(1);
  await store.config.putSettings({ maxAttempts: 1 });
  const adapter = stubAdapter(
    () => new GatewayError("RATE_LIMIT", "slow down", { retryAfterMs: 30_000 }),
  );
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.breakerState).toBe("closed");
  expect(rows[0]?.rateLimitedUntil).toBe(1_030_000);
  store.close();
});

test("a success records latency and marks the credential used", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hi"));
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

  const rows = await store.credentials.listHealth();
  expect(rows[0]?.lastUsedAt).toBe(1_000_000);
  expect(rows[0]?.ewmaTtftMs).not.toBeNull();
  store.close();
});

test("refreshes an expired oauth credential before calling the adapter", async () => {
  const store = await seeded(1);
  await store.credentials.update("c1", { expiresAt: 500_000 });
  const adapter = stubAdapter(() => textStream("hi"));
  await drain((await dispatch(req, deps(store, adapter), new AbortController().signal)).events);

  expect(adapter.calls[0]).toBe("refreshed");
  store.close();
});

test("collects the stream for a non-streaming request", async () => {
  const store = await seeded(1);
  const adapter = stubAdapter(() => textStream("hello"));
  const outcome = await dispatch(
    { ...req, stream: false },
    deps(store, adapter),
    new AbortController().signal,
  );
  const events = await drain(outcome.events);
  // The caller still receives events; egress folds them with collect().
  expect(events.filter((e) => e.type === "blockDelta")).toHaveLength(1);
  store.close();
});

test("the log records the excluded candidates and their reasons", async () => {
  const store = await seeded(2);
  await store.credentials.update("c1", { enabled: false });
  const adapter = stubAdapter(() => textStream("hi"));
  const outcome = await dispatch(req, deps(store, adapter), new AbortController().signal);
  await drain(outcome.events);

  expect(outcome.log().degradations).toContain("excluded:c1:disabled");
  store.close();
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test apps/gateway/test/dispatch`
Expected: FAIL — cannot resolve `../../src/dispatch/classify.ts`.

- [ ] **Step 4: Write the classifier**

`apps/gateway/src/dispatch/classify.ts`:

```ts
import { type ErrorCode, GatewayError } from "@omni/ir";

/** Substrings that identify a transport failure across Bun and undici. */
const NETWORK_HINTS = [
  "fetch failed",
  "econnrefused",
  "econnreset",
  "enotfound",
  "etimedout",
  "socket hang up",
  "unable to connect",
];

/** Turns anything thrown during an attempt into a canonical code. */
export function classify(error: unknown): { code: ErrorCode; retryAfterMs?: number } {
  if (error instanceof GatewayError) {
    return { code: error.code, retryAfterMs: error.retryAfterMs };
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "TIMEOUT" };
  }

  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase();
    if (NETWORK_HINTS.some((hint) => text.includes(hint))) return { code: "NETWORK" };
  }

  return { code: "INTERNAL" };
}
```

- [ ] **Step 5: Write the single-attempt runner**

`apps/gateway/src/dispatch/attempt.ts`:

```ts
import { GatewayError, type StreamEvent } from "@omni/ir";
import type { ProviderAdapter } from "@omni/providers";
import type { CredentialSecrets, CredentialView } from "@omni/store";
import type { Candidate } from "../router/index.ts";

export type AttemptResult = {
  events: AsyncGenerator<StreamEvent, void, undefined>;
  degradations: string[];
};

/**
 * Runs one candidate.
 *
 * Refreshes an OAuth token that is expired or within the lead window, then
 * hands the adapter its credentials. Throws before yielding if the upstream
 * rejects the request; the caller decides whether that is retryable.
 */
export async function attempt(opts: {
  candidate: Candidate;
  request: Parameters<ProviderAdapter["send"]>[0]["request"];
  adapter: ProviderAdapter;
  now: number;
  signal: AbortSignal;
  refresh: (credential: CredentialView) => Promise<CredentialSecrets>;
  /** Refresh this far before actual expiry so a long request cannot expire mid-flight. */
  refreshLeadMs: number;
}): Promise<AttemptResult> {
  const { candidate, adapter, now, signal, refresh, refreshLeadMs } = opts;
  const credential = candidate.credential;

  let secrets = await credential.secrets();

  const stale =
    credential.authType === "oauth" &&
    credential.expiresAt !== null &&
    credential.expiresAt - refreshLeadMs <= now;

  if (stale) {
    if (!credential.hasRefreshToken) {
      throw new GatewayError("AUTH", "credential expired with no refresh token", {
        provider: credential.provider,
      });
    }
    secrets = await refresh(credential);
  }

  return adapter.send({
    request: opts.request,
    model: candidate.target.model,
    credentials: {
      accessToken: secrets.accessToken,
      apiKey: secrets.apiKey,
      providerData: credential.providerData,
    },
    signal,
  });
}
```

- [ ] **Step 6: Write dispatch**

`apps/gateway/src/dispatch/index.ts`:

```ts
import {
  type ChatRequest,
  GatewayError,
  HTTP_STATUS,
  RETRYABLE,
  type StreamEvent,
} from "@omni/ir";
import type { ProviderAdapter } from "@omni/providers";
import type { CredentialSecrets, CredentialView, ProviderId, RequestLog, Store } from "@omni/store";
import { blankHealth, recordFailure, recordSuccess } from "../router/breaker.ts";
import { buildSnapshot, healthKey, rank, resolveModel, type Candidate } from "../router/index.ts";
import { attempt } from "./attempt.ts";
import { classify } from "./classify.ts";

/** Refresh this far ahead of expiry so a long stream cannot outlive its token. */
const REFRESH_LEAD_MS = 120_000;

export type DispatchDeps = {
  store: Store;
  adapters: Readonly<Record<ProviderId, ProviderAdapter>>;
  now: () => number;
  rand: () => number;
  refresh: (credential: CredentialView) => Promise<CredentialSecrets>;
};

export type DispatchOutcome = {
  events: AsyncGenerator<StreamEvent, void, undefined>;
  /** Valid once the stream is drained. Egress writes it to the usage repo. */
  log: () => RequestLog;
};

export async function dispatch(
  request: ChatRequest,
  deps: DispatchDeps,
  signal: AbortSignal,
): Promise<DispatchOutcome> {
  const startedAt = deps.now();
  const snapshot = await buildSnapshot(deps.store, startedAt);

  const log: RequestLog = {
    id: crypto.randomUUID(),
    at: startedAt,
    apiKeyId: null,
    requestedModel: request.model,
    resolvedProvider: null,
    resolvedModel: null,
    credentialId: null,
    attempts: 0,
    status: 200,
    errorCode: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ttftMs: null,
    durationMs: 0,
    costUsd: 0,
    degradations: [],
  };

  const fail = (code: GatewayError["code"], message: string): DispatchOutcome => {
    log.errorCode = code;
    log.status = HTTP_STATUS[code];
    log.durationMs = deps.now() - startedAt;
    return {
      events: (async function* () {
        yield { type: "error", code, message, retryable: RETRYABLE[code] } as StreamEvent;
      })(),
      log: () => log,
    };
  };

  let model;
  try {
    model = resolveModel(request.model, snapshot);
  } catch (error) {
    const { code } = classify(error);
    return fail(code, error instanceof Error ? error.message : "unresolvable model");
  }

  const { candidates, excluded } = rank({
    request,
    model,
    snapshot,
    now: startedAt,
    rand: deps.rand(),
  });

  for (const e of excluded) {
    log.degradations.push(`excluded:${e.credentialId}:${e.reason}`);
  }

  if (candidates.length === 0) {
    return fail("NO_CANDIDATES", `no eligible credential for model "${request.model}"`);
  }

  const maxAttempts = Math.min(snapshot.settings.maxAttempts, candidates.length);

  const persistHealth = async (
    candidate: Candidate,
    next: ReturnType<typeof recordSuccess>,
  ): Promise<void> => {
    await deps.store.credentials.saveHealth([next]);
  };

  const healthFor = (candidate: Candidate) =>
    snapshot.health.get(healthKey(candidate.credential.id, candidate.target.model)) ??
    blankHealth(candidate.credential.id, candidate.target.model);

  async function* run(): AsyncGenerator<StreamEvent, void, undefined> {
    let lastError: GatewayError | null = null;

    for (let i = 0; i < maxAttempts; i++) {
      const candidate = candidates[i] as Candidate;
      log.attempts = i + 1;
      log.credentialId = candidate.credential.id;
      log.resolvedProvider = candidate.target.provider;
      log.resolvedModel = candidate.target.model;

      // Reset per-attempt: a failed attempt's partial usage must not leak into
      // the next one's log.
      log.inputTokens = 0;
      log.outputTokens = 0;
      log.cacheReadTokens = 0;
      log.cacheWriteTokens = 0;
      log.ttftMs = null;

      let committed = false;

      try {
        const result = await attempt({
          candidate,
          request,
          adapter: deps.adapters[candidate.target.provider],
          now: deps.now(),
          signal,
          refresh: deps.refresh,
          refreshLeadMs: REFRESH_LEAD_MS,
        });

        for (const d of result.degradations) log.degradations.push(d);

        for await (const event of result.events) {
          if (event.type === "blockDelta" && !committed) {
            // Commit point: the client is about to see bytes, so from here on
            // failover is impossible and errors must be forwarded in-stream.
            committed = true;
            log.ttftMs = deps.now() - startedAt;
          }

          if (event.type === "end") {
            log.inputTokens = event.usage.inputTokens;
            log.outputTokens = event.usage.outputTokens;
            log.cacheReadTokens = event.usage.cacheReadTokens;
            log.cacheWriteTokens = event.usage.cacheWriteTokens;
            log.costUsd = priceOf(candidate, event.usage);
          }

          if (event.type === "error") {
            // An in-stream error before commit is retryable like a thrown one.
            if (!committed && RETRYABLE[event.code]) {
              throw new GatewayError(event.code, event.message);
            }
            committed = true;
          }

          yield event;
        }

        await persistHealth(
          candidate,
          recordSuccess(healthFor(candidate), {
            settings: snapshot.settings,
            now: deps.now(),
            ttftMs: log.ttftMs,
          }),
        );
        log.status = 200;
        log.errorCode = null;
        log.durationMs = deps.now() - startedAt;
        return;
      } catch (error) {
        const { code, retryAfterMs } = classify(error);
        const message = error instanceof Error ? error.message : "attempt failed";
        lastError = new GatewayError(code, message, { retryAfterMs });

        await persistHealth(
          candidate,
          recordFailure(healthFor(candidate), {
            settings: snapshot.settings,
            now: deps.now(),
            code,
            retryAfterMs,
            jitter: deps.rand(),
          }),
        );

        if (committed) {
          // Bytes already went out; the client gets an in-band error and the
          // stream ends there.
          log.status = HTTP_STATUS[code];
          log.errorCode = code;
          log.durationMs = deps.now() - startedAt;
          yield { type: "error", code, message, retryable: false };
          return;
        }

        if (!RETRYABLE[code]) break;
      }
    }

    const code = lastError !== null && !RETRYABLE[lastError.code]
      ? lastError.code
      : "ALL_CANDIDATES_FAILED";
    log.status = HTTP_STATUS[code];
    log.errorCode = code;
    log.durationMs = deps.now() - startedAt;
    yield {
      type: "error",
      code,
      message: lastError?.message ?? "all candidates failed",
      retryable: false,
    };
  }

  return { events: run(), log: () => log };
}

function priceOf(
  candidate: Candidate,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number {
  const p = candidate.target.costPerMTok;
  const cacheRate = p.cacheRead ?? p.input * 0.1;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * cacheRate) /
    1_000_000
  );
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test apps/gateway`
Expected: 72 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): add dispatch with failover and commit-point handling"
```

---

## Task 16: Ingress — parsing client requests into the IR

**Files:**
- Create: `apps/gateway/src/ingress/schemas.ts`, `apps/gateway/src/ingress/anthropic.ts`, `apps/gateway/src/ingress/openai.ts`
- Test: `apps/gateway/test/ingress/anthropic.test.ts`, `apps/gateway/test/ingress/openai.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `validateRequest`, `GatewayError` (Task 2); Zod 4.4.3.
- Produces:
  - `parseAnthropicRequest(body: unknown): ChatRequest`
  - `parseOpenAIRequest(body: unknown): ChatRequest`
  Both throw `GatewayError("BAD_REQUEST", …)` with the Zod issue path on invalid input, and run `validateRequest` before returning.

These are the mirror image of the provider `toWire` functions: same two wire formats, decoded rather than encoded. Ingress is where untrusted input is validated — after this point everything downstream can assume a well-formed `ChatRequest`.

- [ ] **Step 1: Write the failing Anthropic ingress test**

`apps/gateway/test/ingress/anthropic.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";

const minimal = {
  model: "claude-opus-4",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
};

test("parses a minimal request and defaults stream to false", () => {
  const req = parseAnthropicRequest(minimal);
  expect(req.model).toBe("claude-opus-4");
  expect(req.maxTokens).toBe(1024);
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("normalises a string system prompt to blocks", () => {
  expect(parseAnthropicRequest({ ...minimal, system: "be terse" }).system).toEqual([
    { type: "text", text: "be terse" },
  ]);
});

test("accepts a block-array system prompt", () => {
  expect(
    parseAnthropicRequest({ ...minimal, system: [{ type: "text", text: "a" }] }).system,
  ).toEqual([{ type: "text", text: "a" }]);
});

test("parses image blocks", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "image",
    mediaType: "image/png",
    data: "AAAA",
  });
});

test("parses tool use and tool result blocks", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "f", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "tu_1",
    name: "f",
    input: { a: 1 },
  });
  expect(req.messages[1]?.content[0]).toEqual({
    type: "toolResult",
    toolUseId: "tu_1",
    content: "ok",
    isError: false,
  });
});

test("stringifies structured tool result content", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "one" }] },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content[0]).toMatchObject({ type: "toolResult", content: "one" });
});

test("parses tools and tool choice", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "f" },
  });
  expect(req.tools).toEqual([{ name: "f", description: "d", inputSchema: { type: "object" } }]);
  expect(req.toolChoice).toEqual({ type: "tool", name: "f" });
});

test("maps a thinking block onto the reasoning config", () => {
  const req = parseAnthropicRequest({
    ...minimal,
    thinking: { type: "enabled", budget_tokens: 8000 },
  });
  expect(req.reasoning).toEqual({ effort: "medium", budgetTokens: 8000 });
});

test("ignores disabled thinking", () => {
  expect(parseAnthropicRequest({ ...minimal, thinking: { type: "disabled" } }).reasoning).toBeUndefined();
});

test("passes unknown top-level fields through as vendor extras", () => {
  expect(parseAnthropicRequest({ ...minimal, top_k: 40 }).vendor?.anthropic).toEqual({ top_k: 40 });
});

test("applies IR validation to the parsed request", () => {
  // An orphaned tool result is dropped by validateRequest, leaving an empty
  // message that is then removed.
  const req = parseAnthropicRequest({
    ...minimal,
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "nope", content: "x" }] },
    ],
  });
  expect(req.messages).toHaveLength(1);
});

test("rejects a request with no messages", () => {
  expect(() => parseAnthropicRequest({ ...minimal, messages: [] })).toThrow(GatewayError);
});

test("rejects a missing model with a field path in the message", () => {
  try {
    parseAnthropicRequest({ max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
    throw new Error("expected throw");
  } catch (e) {
    expect((e as GatewayError).code).toBe("BAD_REQUEST");
    expect((e as GatewayError).message).toContain("model");
  }
});

test("rejects an unknown role", () => {
  expect(() =>
    parseAnthropicRequest({ ...minimal, messages: [{ role: "system", content: "x" }] }),
  ).toThrow(GatewayError);
});
```

- [ ] **Step 2: Write the failing OpenAI ingress test**

`apps/gateway/test/ingress/openai.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";

const minimal = { model: "gpt-5", messages: [{ role: "user", content: "hi" }] };

test("parses a minimal chat completions request", () => {
  const req = parseOpenAIRequest(minimal);
  expect(req.model).toBe("gpt-5");
  expect(req.stream).toBe(false);
  expect(req.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});

test("lifts system and developer messages out of the message list", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      { role: "system", content: "be terse" },
      { role: "developer", content: "and precise" },
      { role: "user", content: "hi" },
    ],
  });
  expect(req.system).toEqual([
    { type: "text", text: "be terse" },
    { type: "text", text: "and precise" },
  ]);
  expect(req.messages).toHaveLength(1);
});

test("parses multi-part content with image urls", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  });
  expect(req.messages[0]?.content).toEqual([
    { type: "text", text: "look" },
    { type: "image", mediaType: "image/png", data: "AAAA" },
  ]);
});

test("rejects a non-data image url rather than fetching it", () => {
  expect(() =>
    parseOpenAIRequest({
      ...minimal,
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
        },
      ],
    }),
  ).toThrow(GatewayError);
});

test("parses assistant tool calls and tool result messages", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  expect(req.messages[0]?.content[0]).toEqual({
    type: "toolUse",
    id: "c1",
    name: "f",
    input: { a: 1 },
  });
  expect(req.messages[1]).toEqual({
    role: "user",
    content: [{ type: "toolResult", toolUseId: "c1", content: "ok", isError: false }],
  });
});

test("tolerates malformed tool call arguments", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{oops" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
  });
  expect(req.messages[0]?.content[0]).toMatchObject({ type: "toolUse", input: {} });
});

test("parses tools and the required tool choice", () => {
  const req = parseOpenAIRequest({
    ...minimal,
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "required",
  });
  expect(req.tools).toEqual([{ name: "f", description: undefined, inputSchema: { type: "object" } }]);
  expect(req.toolChoice).toEqual({ type: "any" });
});

test("parses a named tool choice", () => {
  expect(
    parseOpenAIRequest({ ...minimal, tool_choice: { type: "function", function: { name: "f" } } })
      .toolChoice,
  ).toEqual({ type: "tool", name: "f" });
});

test("maps reasoning_effort onto the reasoning config", () => {
  expect(parseOpenAIRequest({ ...minimal, reasoning_effort: "high" }).reasoning).toEqual({
    effort: "high",
  });
});

test("accepts both max_tokens and max_completion_tokens", () => {
  expect(parseOpenAIRequest({ ...minimal, max_tokens: 100 }).maxTokens).toBe(100);
  expect(parseOpenAIRequest({ ...minimal, max_completion_tokens: 200 }).maxTokens).toBe(200);
});

test("normalises a string stop value to an array", () => {
  expect(parseOpenAIRequest({ ...minimal, stop: "END" }).stopSequences).toEqual(["END"]);
});

test("passes unknown fields through as vendor extras", () => {
  expect(parseOpenAIRequest({ ...minimal, top_p: 0.5 }).vendor?.openai).toEqual({ top_p: 0.5 });
});

test("rejects a request with no messages", () => {
  expect(() => parseOpenAIRequest({ ...minimal, messages: [] })).toThrow(GatewayError);
});

test("rejects a request that is only a system message", () => {
  expect(() =>
    parseOpenAIRequest({ ...minimal, messages: [{ role: "system", content: "x" }] }),
  ).toThrow(GatewayError);
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test apps/gateway/test/ingress`
Expected: FAIL — cannot resolve `../../src/ingress/anthropic.ts`.

- [ ] **Step 4: Write the shared schemas**

`apps/gateway/src/ingress/schemas.ts`:

```ts
import { GatewayError } from "@omni/ir";
import { z } from "zod";

/**
 * Runs a schema and converts a Zod failure into a BAD_REQUEST carrying the
 * offending field path, so a client can see which field it got wrong.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.join(".") ?? "(root)";
  throw new GatewayError("BAD_REQUEST", `${path}: ${issue?.message ?? "invalid request"}`);
}

/** Anything the schema does not name is preserved for vendor passthrough. */
export function extraFields(
  body: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!known.includes(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/** Splits `data:image/png;base64,AAAA` into its media type and payload. */
export function parseDataUrl(url: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) {
    throw new GatewayError(
      "BAD_REQUEST",
      "image_url must be a base64 data URL; the gateway does not fetch remote images",
    );
  }
  return { mediaType: match[1] as string, data: match[2] as string };
}

export const jsonValue: z.ZodType<unknown> = z.unknown();
```

**Why remote image URLs are rejected.** Fetching a client-supplied URL would make the gateway an open request proxy reachable from any API key — a server-side request forgery vector against whatever the gateway can reach on its network. Clients inline their images; every provider SDK already does this.

- [ ] **Step 5: Write the Anthropic ingress parser**

`apps/gateway/src/ingress/anthropic.ts`:

```ts
import type { ChatRequest, ContentBlock, Message, ToolChoice } from "@omni/ir";
import { GatewayError, validateRequest } from "@omni/ir";
import { z } from "zod";
import { extraFields, parseOrThrow } from "./schemas.ts";

const textBlock = z.object({ type: z.literal("text"), text: z.string() });

const imageBlock = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
});

const thinkingBlock = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
});

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
});

const block = z.discriminatedUnion("type", [
  textBlock,
  imageBlock,
  thinkingBlock,
  toolUseBlock,
  toolResultBlock,
]);

const message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(block)]),
});

const schema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        input_schema: z.unknown(),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.object({ type: z.enum(["auto", "any", "none"]) }),
      z.object({ type: z.literal("tool"), name: z.string() }),
    ])
    .optional(),
  thinking: z
    .union([
      z.object({ type: z.literal("enabled"), budget_tokens: z.number().int().positive() }),
      z.object({ type: z.literal("disabled") }),
    ])
    .optional(),
});

const KNOWN = [
  "model",
  "messages",
  "system",
  "max_tokens",
  "temperature",
  "stop_sequences",
  "stream",
  "tools",
  "tool_choice",
  "thinking",
  "metadata",
] as const;

/** Tool result content may be blocks; flatten to the text the model will see. */
function flattenToolResult(content: string | unknown[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const p = part as { type?: string; text?: string };
      return p.type === "text" && typeof p.text === "string" ? p.text : JSON.stringify(part);
    })
    .join("\n");
}

function toIrBlock(b: z.infer<typeof block>): ContentBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return { type: "image", mediaType: b.source.media_type, data: b.source.data };
    case "thinking":
      return { type: "thinking", text: b.thinking, signature: b.signature };
    case "tool_use":
      return { type: "toolUse", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "toolResult",
        toolUseId: b.tool_use_id,
        content: flattenToolResult(b.content),
        isError: b.is_error ?? false,
      };
  }
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  return c.type === "tool" ? { type: "tool", name: c.name } : { type: c.type };
}

export function parseAnthropicRequest(body: unknown): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new GatewayError("BAD_REQUEST", "request body must be a JSON object");
  }

  const parsed = parseOrThrow(schema, body);

  const messages: Message[] = parsed.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content.map(toIrBlock),
  }));

  const system =
    parsed.system === undefined
      ? undefined
      : typeof parsed.system === "string"
        ? [{ type: "text" as const, text: parsed.system }]
        : parsed.system.map((b) => ({ type: "text" as const, text: b.text }));

  const request: ChatRequest = {
    model: parsed.model,
    messages,
    stream: parsed.stream ?? false,
  };

  if (system !== undefined) request.system = system;
  if (parsed.max_tokens !== undefined) request.maxTokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.stop_sequences !== undefined) request.stopSequences = parsed.stop_sequences;
  if (parsed.tools !== undefined) {
    request.tools = parsed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    }));
  }
  if (parsed.tool_choice !== undefined) request.toolChoice = toIrToolChoice(parsed.tool_choice);
  if (parsed.thinking?.type === "enabled") {
    // The wire format carries a budget, not an effort level; medium is the
    // neutral mapping for providers that only understand effort.
    request.reasoning = { effort: "medium", budgetTokens: parsed.thinking.budget_tokens };
  }

  const extras = extraFields(body as Record<string, unknown>, KNOWN);
  if (extras !== undefined) request.vendor = { anthropic: extras };

  return validateRequest(request);
}
```

- [ ] **Step 6: Write the OpenAI ingress parser**

`apps/gateway/src/ingress/openai.ts`:

```ts
import type { ChatRequest, ContentBlock, Message, ToolChoice } from "@omni/ir";
import { GatewayError, validateRequest } from "@omni/ir";
import { z } from "zod";
import { extraFields, parseDataUrl, parseOrThrow } from "./schemas.ts";

const part = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
]);

const toolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(part), z.null()]).optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().optional(),
});

const schema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.unknown().optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.enum(["auto", "none", "required"]),
      z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
});

const KNOWN = [
  "model",
  "messages",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "stop",
  "stream",
  "tools",
  "tool_choice",
  "reasoning_effort",
  "stream_options",
  "user",
  "n",
] as const;

/** Tool arguments arrive as a JSON string; a malformed one becomes `{}`. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function contentBlocks(content: z.infer<typeof message>["content"]): ContentBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.map((p): ContentBlock => {
    if (p.type === "text") return { type: "text", text: p.text };
    const { mediaType, data } = parseDataUrl(p.image_url.url);
    return { type: "image", mediaType, data };
  });
}

function toIrToolChoice(c: NonNullable<z.infer<typeof schema>["tool_choice"]>): ToolChoice {
  if (typeof c === "string") {
    if (c === "required") return { type: "any" };
    return { type: c };
  }
  return { type: "tool", name: c.function.name };
}

export function parseOpenAIRequest(body: unknown): ChatRequest {
  if (typeof body !== "object" || body === null) {
    throw new GatewayError("BAD_REQUEST", "request body must be a JSON object");
  }

  const parsed = parseOrThrow(schema, body);

  const system: ContentBlock[] = [];
  const messages: Message[] = [];

  for (const m of parsed.messages) {
    if (m.role === "system" || m.role === "developer") {
      // Both map to the IR system prompt; developer is the newer spelling.
      system.push(...contentBlocks(m.content));
      continue;
    }

    if (m.role === "tool") {
      if (m.tool_call_id === undefined) {
        throw new GatewayError("BAD_REQUEST", "messages: tool message requires tool_call_id");
      }
      // The IR follows Anthropic: a tool result is user-turn content.
      messages.push({
        role: "user",
        content: [
          {
            type: "toolResult",
            toolUseId: m.tool_call_id,
            content: typeof m.content === "string" ? m.content : "",
            isError: false,
          },
        ],
      });
      continue;
    }

    const content = contentBlocks(m.content);
    for (const call of m.tool_calls ?? []) {
      content.push({
        type: "toolUse",
        id: call.id,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }
    if (content.length > 0) messages.push({ role: m.role, content });
  }

  if (messages.length === 0) {
    throw new GatewayError("BAD_REQUEST", "messages: at least one non-system message is required");
  }

  const request: ChatRequest = {
    model: parsed.model,
    messages,
    stream: parsed.stream ?? false,
  };

  if (system.length > 0) request.system = system;
  const maxTokens = parsed.max_completion_tokens ?? parsed.max_tokens;
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.stop !== undefined) {
    request.stopSequences = typeof parsed.stop === "string" ? [parsed.stop] : parsed.stop;
  }
  if (parsed.tools !== undefined) {
    request.tools = parsed.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      inputSchema: t.function.parameters ?? { type: "object" },
    }));
  }
  if (parsed.tool_choice !== undefined) request.toolChoice = toIrToolChoice(parsed.tool_choice);
  if (parsed.reasoning_effort !== undefined) request.reasoning = { effort: parsed.reasoning_effort };

  const extras = extraFields(body as Record<string, unknown>, KNOWN);
  if (extras !== undefined) request.vendor = { openai: extras };

  return validateRequest(request);
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test apps/gateway`
Expected: 100 pass, 0 fail.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): add anthropic and openai ingress parsers"
```

---

## Task 17: Egress — rendering IR events back onto both wire formats

**Files:**
- Create: `apps/gateway/src/egress/anthropic.ts`, `apps/gateway/src/egress/openai.ts`
- Test: `apps/gateway/test/egress/anthropic.test.ts`, `apps/gateway/test/egress/openai.test.ts`

**Interfaces:**
- Consumes: `StreamEvent`, `collect`, `CollectedResponse`, `HTTP_STATUS` (Tasks 2-3).
- Produces:
  - `anthropicStream(events, requestId): AsyncGenerator<{ event: string; data: string }>`
  - `anthropicResponse(collected, requestId): unknown`
  - `openaiStream(events, requestId, created): AsyncGenerator<{ event: string; data: string }>`
  - `openaiResponse(collected, requestId, created): unknown`
  Streaming yields SSE frames for the route to serialize; non-streaming takes the already-collected response.

Non-streaming and streaming share the same upstream path: dispatch always produces events, and a non-streaming request is folded with `collect()` before rendering. `created` and `requestId` are parameters rather than generated here, so responses are deterministic under test.

- [ ] **Step 1: Write the failing Anthropic egress test**

`apps/gateway/test/egress/anthropic.test.ts`:

```ts
import { expect, test } from "bun:test";
import { collect, type StreamEvent } from "@omni/ir";
import { anthropicResponse, anthropicStream } from "../../src/egress/anthropic.ts";

async function* src(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

const TEXT: StreamEvent[] = [
  { type: "start", id: "msg_1", model: "claude-opus-4" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function frames(g: AsyncGenerator<{ event: string; data: string }>) {
  const out = [];
  for await (const f of g) out.push({ event: f.event, data: JSON.parse(f.data) });
  return out;
}

test("emits the full anthropic sse sequence", async () => {
  const f = await frames(anthropicStream(src(...TEXT), "msg_1"));
  expect(f.map((x) => x.event)).toEqual([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  expect(f[0]?.data.message.id).toBe("msg_1");
  expect(f[0]?.data.message.usage.input_tokens).toBe(10);
  expect(f[2]?.data.delta).toEqual({ type: "text_delta", text: "Hi" });
  expect(f[4]?.data.delta.stop_reason).toBe("end_turn");
  expect(f[4]?.data.usage.output_tokens).toBe(2);
});

test("renders tool use blocks with input_json_delta", async () => {
  const f = await frames(
    anthropicStream(
      src(
        { type: "blockStart", index: 0, block: { type: "toolUse", id: "tu", name: "f" } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } },
        { type: "blockEnd", index: 0 },
      ),
      "msg_1",
    ),
  );
  expect(f[0]?.data.content_block).toEqual({ type: "tool_use", id: "tu", name: "f", input: {} });
  expect(f[1]?.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"a":1}' });
});

test("renders thinking deltas and signatures", async () => {
  const f = await frames(
    anthropicStream(
      src(
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hm" } },
        { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "s" } },
      ),
      "msg_1",
    ),
  );
  expect(f[1]?.data.delta).toEqual({ type: "thinking_delta", thinking: "hm" });
  expect(f[2]?.data.delta).toEqual({ type: "signature_delta", signature: "s" });
});

test("renders an error event as an anthropic error frame", async () => {
  const f = await frames(
    anthropicStream(
      src({ type: "error", code: "RATE_LIMIT", message: "slow", retryable: true }),
      "msg_1",
    ),
  );
  expect(f[0]?.event).toBe("error");
  expect(f[0]?.data.error).toEqual({ type: "rate_limit_error", message: "slow" });
});

test("builds a non-streaming response body", () => {
  const body = anthropicResponse(collect(TEXT), "msg_1") as Record<string, any>;
  expect(body.id).toBe("msg_1");
  expect(body.type).toBe("message");
  expect(body.role).toBe("assistant");
  expect(body.content).toEqual([{ type: "text", text: "Hi" }]);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
});

test("renders collected tool use with parsed input", () => {
  const body = anthropicResponse(
    collect([
      { type: "blockStart", index: 0, block: { type: "toolUse", id: "tu", name: "f" } },
      { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } },
      { type: "blockEnd", index: 0 },
      {
        type: "end",
        stopReason: "toolUse",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]),
    "msg_1",
  ) as Record<string, any>;
  expect(body.content[0]).toEqual({ type: "tool_use", id: "tu", name: "f", input: { a: 1 } });
  expect(body.stop_reason).toBe("tool_use");
});
```

- [ ] **Step 2: Write the failing OpenAI egress test**

`apps/gateway/test/egress/openai.test.ts`:

```ts
import { expect, test } from "bun:test";
import { collect, type StreamEvent } from "@omni/ir";
import { openaiResponse, openaiStream } from "../../src/egress/openai.ts";

async function* src(...events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

const TEXT: StreamEvent[] = [
  { type: "start", id: "msg_1", model: "gpt-5" },
  { type: "blockStart", index: 0, block: { type: "text" } },
  { type: "blockDelta", index: 0, delta: { type: "text", text: "Hi" } },
  { type: "blockEnd", index: 0 },
  {
    type: "end",
    stopReason: "endTurn",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
];

async function frames(g: AsyncGenerator<{ event: string; data: string }>) {
  const out: { data: string }[] = [];
  for await (const f of g) out.push({ data: f.data });
  return out;
}

test("emits chat completion chunks terminated by [DONE]", async () => {
  const f = await frames(openaiStream(src(...TEXT), "chatcmpl-1", 1000));
  expect(f.at(-1)?.data).toBe("[DONE]");

  const first = JSON.parse(f[0]?.data as string);
  expect(first.object).toBe("chat.completion.chunk");
  expect(first.id).toBe("chatcmpl-1");
  expect(first.created).toBe(1000);
  expect(first.choices[0].delta).toEqual({ role: "assistant", content: "" });

  const content = JSON.parse(f[1]?.data as string);
  expect(content.choices[0].delta).toEqual({ content: "Hi" });

  const last = JSON.parse(f[f.length - 2]?.data as string);
  expect(last.choices[0].finish_reason).toBe("stop");
  expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
});

test("streams tool calls with index and argument deltas", async () => {
  const f = await frames(
    openaiStream(
      src(
        { type: "blockStart", index: 0, block: { type: "toolUse", id: "c1", name: "f" } },
        { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a"' } },
      ),
      "chatcmpl-1",
      1000,
    ),
  );
  const start = JSON.parse(f[0]?.data as string);
  expect(start.choices[0].delta.tool_calls[0]).toEqual({
    index: 0,
    id: "c1",
    type: "function",
    function: { name: "f", arguments: "" },
  });
  const delta = JSON.parse(f[1]?.data as string);
  expect(delta.choices[0].delta.tool_calls[0]).toEqual({
    index: 0,
    function: { arguments: '{"a"' },
  });
});

test("maps a tool-use stop reason onto tool_calls", async () => {
  const f = await frames(
    openaiStream(
      src({
        type: "end",
        stopReason: "toolUse",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      "chatcmpl-1",
      1000,
    ),
  );
  expect(JSON.parse(f[0]?.data as string).choices[0].finish_reason).toBe("tool_calls");
});

test("thinking content is not emitted on the chat completions surface", async () => {
  const f = await frames(
    openaiStream(
      src(
        { type: "blockStart", index: 0, block: { type: "thinking" } },
        { type: "blockDelta", index: 0, delta: { type: "thinking", text: "hm" } },
      ),
      "chatcmpl-1",
      1000,
    ),
  );
  expect(f.filter((x) => x.data !== "[DONE]")).toHaveLength(0);
});

test("renders an error event as an openai error frame", async () => {
  const f = await frames(
    openaiStream(
      src({ type: "error", code: "RATE_LIMIT", message: "slow", retryable: true }),
      "chatcmpl-1",
      1000,
    ),
  );
  const body = JSON.parse(f[0]?.data as string);
  expect(body.error).toEqual({
    message: "slow",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
  });
});

test("builds a non-streaming chat completion body", () => {
  const body = openaiResponse(collect(TEXT), "chatcmpl-1", 1000) as Record<string, any>;
  expect(body.object).toBe("chat.completion");
  expect(body.choices[0].message).toEqual({ role: "assistant", content: "Hi" });
  expect(body.choices[0].finish_reason).toBe("stop");
  expect(body.usage.total_tokens).toBe(12);
});

test("renders collected tool calls in a non-streaming body", () => {
  const body = openaiResponse(
    collect([
      { type: "blockStart", index: 0, block: { type: "toolUse", id: "c1", name: "f" } },
      { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a":1}' } },
      { type: "blockEnd", index: 0 },
      {
        type: "end",
        stopReason: "toolUse",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]),
    "chatcmpl-1",
    1000,
  ) as Record<string, any>;
  expect(body.choices[0].message.content).toBeNull();
  expect(body.choices[0].message.tool_calls[0]).toEqual({
    id: "c1",
    type: "function",
    function: { name: "f", arguments: '{"a":1}' },
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `bun test apps/gateway/test/egress`
Expected: FAIL — cannot resolve `../../src/egress/anthropic.ts`.

- [ ] **Step 4: Write the Anthropic egress renderer**

`apps/gateway/src/egress/anthropic.ts`:

```ts
import type { CollectedResponse, ErrorCode, StopReason, StreamEvent } from "@omni/ir";

export type SseFrame = { event: string; data: string };

const STOP_REASON: Readonly<Record<StopReason, string>> = {
  endTurn: "end_turn",
  maxTokens: "max_tokens",
  stopSequence: "stop_sequence",
  toolUse: "tool_use",
  contentFilter: "refusal",
};

const ERROR_TYPE: Readonly<Record<ErrorCode, string>> = {
  AUTH: "authentication_error",
  RATE_LIMIT: "rate_limit_error",
  QUOTA_EXHAUSTED: "rate_limit_error",
  OVERLOADED: "overloaded_error",
  BAD_REQUEST: "invalid_request_error",
  CONTENT_FILTER: "invalid_request_error",
  CAPABILITY_MISMATCH: "invalid_request_error",
  MODEL_UNAVAILABLE: "not_found_error",
  UPSTREAM: "api_error",
  TIMEOUT: "api_error",
  NETWORK: "api_error",
  NO_CANDIDATES: "overloaded_error",
  ALL_CANDIDATES_FAILED: "api_error",
  INTERNAL: "api_error",
};

const frame = (event: string, data: unknown): SseFrame => ({
  event,
  data: JSON.stringify(data),
});

export async function* anthropicStream(
  events: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
  requestId: string,
): AsyncGenerator<SseFrame, void, undefined> {
  let model = "";
  let inputTokens = 0;

  for await (const event of events) {
    switch (event.type) {
      case "start":
        model = event.model;
        yield frame("message_start", {
          type: "message_start",
          message: {
            id: requestId,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        });
        break;

      case "blockStart": {
        const b = event.block;
        const content_block =
          b.type === "text"
            ? { type: "text", text: "" }
            : b.type === "thinking"
              ? { type: "thinking", thinking: "" }
              : { type: "tool_use", id: b.id, name: b.name, input: {} };
        yield frame("content_block_start", {
          type: "content_block_start",
          index: event.index,
          content_block,
        });
        break;
      }

      case "blockDelta": {
        const d = event.delta;
        const delta =
          d.type === "text"
            ? { type: "text_delta", text: d.text }
            : d.type === "thinking"
              ? { type: "thinking_delta", thinking: d.text }
              : d.type === "thinkingSignature"
                ? { type: "signature_delta", signature: d.signature }
                : { type: "input_json_delta", partial_json: d.partial };
        yield frame("content_block_delta", {
          type: "content_block_delta",
          index: event.index,
          delta,
        });
        break;
      }

      case "blockEnd":
        yield frame("content_block_stop", { type: "content_block_stop", index: event.index });
        break;

      case "end":
        yield frame("message_delta", {
          type: "message_delta",
          delta: { stop_reason: STOP_REASON[event.stopReason], stop_sequence: null },
          usage: { output_tokens: event.usage.outputTokens },
        });
        yield frame("message_stop", { type: "message_stop" });
        break;

      case "error":
        yield frame("error", {
          type: "error",
          error: { type: ERROR_TYPE[event.code], message: event.message },
        });
        break;
    }
  }
}

export function anthropicResponse(collected: CollectedResponse, requestId: string): unknown {
  return {
    id: requestId,
    type: "message",
    role: "assistant",
    model: collected.model,
    content: collected.content.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "thinking":
          return { type: "thinking", thinking: b.text, signature: b.signature };
        case "toolUse":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        default:
          return { type: "text", text: "" };
      }
    }),
    stop_reason: STOP_REASON[collected.stopReason],
    stop_sequence: null,
    usage: {
      input_tokens: collected.usage.inputTokens,
      output_tokens: collected.usage.outputTokens,
    },
  };
}

export function anthropicErrorBody(code: ErrorCode, message: string): unknown {
  return { type: "error", error: { type: ERROR_TYPE[code], message } };
}
```

- [ ] **Step 5: Write the OpenAI egress renderer**

`apps/gateway/src/egress/openai.ts`:

```ts
import type { CollectedResponse, ErrorCode, StopReason, StreamEvent } from "@omni/ir";
import type { SseFrame } from "./anthropic.ts";

const FINISH: Readonly<Record<StopReason, string>> = {
  endTurn: "stop",
  maxTokens: "length",
  stopSequence: "stop",
  toolUse: "tool_calls",
  contentFilter: "content_filter",
};

const ERROR_TYPE: Readonly<Record<ErrorCode, { type: string; code: string }>> = {
  AUTH: { type: "invalid_request_error", code: "invalid_api_key" },
  RATE_LIMIT: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  QUOTA_EXHAUSTED: { type: "insufficient_quota", code: "insufficient_quota" },
  OVERLOADED: { type: "server_error", code: "server_error" },
  BAD_REQUEST: { type: "invalid_request_error", code: "invalid_request" },
  CONTENT_FILTER: { type: "invalid_request_error", code: "content_policy_violation" },
  CAPABILITY_MISMATCH: { type: "invalid_request_error", code: "invalid_request" },
  MODEL_UNAVAILABLE: { type: "invalid_request_error", code: "model_not_found" },
  UPSTREAM: { type: "server_error", code: "server_error" },
  TIMEOUT: { type: "server_error", code: "timeout" },
  NETWORK: { type: "server_error", code: "server_error" },
  NO_CANDIDATES: { type: "server_error", code: "service_unavailable" },
  ALL_CANDIDATES_FAILED: { type: "server_error", code: "server_error" },
  INTERNAL: { type: "server_error", code: "server_error" },
};

const chunk = (id: string, created: number, model: string, choice: unknown, usage?: unknown) => ({
  id,
  object: "chat.completion.chunk",
  created,
  model,
  choices: [choice],
  ...(usage === undefined ? {} : { usage }),
});

export async function* openaiStream(
  events: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
  requestId: string,
  created: number,
): AsyncGenerator<SseFrame, void, undefined> {
  let model = "";
  let roleSent = false;
  // Chat Completions numbers tool calls independently of content blocks.
  const toolIndex = new Map<number, number>();

  const emit = (data: unknown): SseFrame => ({ event: "message", data: JSON.stringify(data) });

  for await (const event of events) {
    switch (event.type) {
      case "start":
        model = event.model;
        break;

      case "blockStart": {
        if (event.block.type === "text") {
          if (!roleSent) {
            roleSent = true;
            yield emit(
              chunk(requestId, created, model, {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              }),
            );
          }
        } else if (event.block.type === "toolUse") {
          const index = toolIndex.size;
          toolIndex.set(event.index, index);
          yield emit(
            chunk(requestId, created, model, {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: event.block.id,
                    type: "function",
                    function: { name: event.block.name, arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            }),
          );
        }
        // Thinking blocks have no representation on this surface.
        break;
      }

      case "blockDelta": {
        const d = event.delta;
        if (d.type === "text") {
          yield emit(
            chunk(requestId, created, model, {
              index: 0,
              delta: { content: d.text },
              finish_reason: null,
            }),
          );
        } else if (d.type === "toolJson") {
          const index = toolIndex.get(event.index) ?? 0;
          yield emit(
            chunk(requestId, created, model, {
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: d.partial } }] },
              finish_reason: null,
            }),
          );
        }
        break;
      }

      case "blockEnd":
        break;

      case "end":
        yield emit(
          chunk(
            requestId,
            created,
            model,
            { index: 0, delta: {}, finish_reason: FINISH[event.stopReason] },
            {
              prompt_tokens: event.usage.inputTokens,
              completion_tokens: event.usage.outputTokens,
              total_tokens: event.usage.inputTokens + event.usage.outputTokens,
            },
          ),
        );
        break;

      case "error": {
        const e = ERROR_TYPE[event.code];
        yield emit({ error: { message: event.message, type: e.type, code: e.code } });
        break;
      }
    }
  }

  yield { event: "message", data: "[DONE]" };
}

export function openaiResponse(
  collected: CollectedResponse,
  requestId: string,
  created: number,
): unknown {
  const text = collected.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
  const toolCalls = collected.content.flatMap((b) =>
    b.type === "toolUse"
      ? [
          {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          },
        ]
      : [],
  );

  return {
    id: requestId,
    object: "chat.completion",
    created,
    model: collected.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length > 0 && text.length === 0 ? null : text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: FINISH[collected.stopReason],
      },
    ],
    usage: {
      prompt_tokens: collected.usage.inputTokens,
      completion_tokens: collected.usage.outputTokens,
      total_tokens: collected.usage.inputTokens + collected.usage.outputTokens,
    },
  };
}

export function openaiErrorBody(code: ErrorCode, message: string): unknown {
  const e = ERROR_TYPE[code];
  return { error: { message, type: e.type, code: e.code } };
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test apps/gateway`
Expected: 113 pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add apps/gateway
git commit -m "feat(gateway): add anthropic and openai egress renderers"
```

---
