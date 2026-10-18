import { GatewayError, type LogLevel, type StreamEvent } from "@omni/ir";
import type { AdapterRequest, AdapterResult, HttpClient, ProviderAdapter } from "@omni/providers";
import type { Settings, Store } from "@omni/store";
import {
  type CaptureLogger,
  captureLogger,
  memoryStore,
  seedApiKey,
  seedCredential,
  target,
  virtualModel,
} from "@omni/testkit";
import type { RequestCompleted } from "@omnigateway/plugin-api";
import { ApiKeyRateLimiter } from "../../src/auth/rateLimit.ts";
import { type ProxyDeps, proxyRoutes } from "../../src/routes/proxy.ts";

export type Surface = "anthropic" | "openai" | "responses";
export const SURFACES: readonly Surface[] = ["anthropic", "openai", "responses"];

export const PATH: Readonly<Record<Surface, string>> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
  responses: "/v1/responses",
};

const USAGE = { inputTokens: 40, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A whole upstream turn answering `text`. */
export function textEvents(text: string, model = "stub"): StreamEvent[] {
  return [
    { type: "start", id: "upstream", model },
    { type: "blockStart", index: 0, block: { type: "text" } },
    { type: "blockDelta", index: 0, delta: { type: "text", text } },
    { type: "blockEnd", index: 0 },
    { type: "end", stopReason: "endTurn", usage: USAGE },
  ];
}

async function* replay(
  events: readonly StreamEvent[],
): AsyncGenerator<StreamEvent, void, undefined> {
  for (const event of events) yield event;
}

/** What the stub classifier does with the call it receives. */
export type Classifier =
  | { kind: "reply"; text: string }
  | { kind: "events"; events: StreamEvent[] }
  | { kind: "error" }
  | { kind: "hang" };

export const ALLOW: Classifier = { kind: "reply", text: "ALLOW" };
export const DENY: Classifier = { kind: "reply", text: "DENY" };

/**
 * Waits for the call's own signal and fails with its reason, as a real
 * transport does — so a timeout or a hang-up is observed through the signal
 * dispatch hands the adapter, not through anything the test arranges.
 */
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** The bare transport. A stub adapter never calls it; its identity is what is asserted. */
export const transport: HttpClient = () => {
  throw new Error("a stub adapter reached the transport");
};

export type Harness = {
  store: Store;
  raw: string;
  keyId: string;
  logger: CaptureLogger;
  /** Every request the real target received. Empty on every refusal. */
  targetCalls: AdapterRequest[];
  /** Every request the classifier received. */
  judgeCalls: AdapterRequest[];
  emitted: RequestCompleted[];
  debits: Array<{ keyId: string; model: string; tokens: number; costUsd: number }>;
  /** Swaps what the classifier does for the next call onwards. */
  setClassifier: (next: Classifier) => void;
  /** Resolves once the classifier has received its first call, for cancellation tests. */
  classifierCalled: () => Promise<void>;
  call: (
    surface: Surface,
    opts?: { stream?: boolean; body?: Record<string, unknown>; signal?: AbortSignal },
  ) => Promise<Response>;
};

/**
 * The proxy with two stub providers: `anthropic` is the real target behind the
 * `fast` model, `openai` is the classifier behind `judge`. Each records what it
 * received, so a test asserts both the request the classifier was asked and
 * that the target was never reached on a refusal.
 */
export async function guardrailHarness(
  opts: {
    policy?: string | null;
    classifier?: Classifier;
    settings?: Partial<Settings>;
    deps?: Partial<ProxyDeps>;
    store?: Store;
    /** The captured logger's level. Debug by default, which prints provider-bearing reasons. */
    logLevel?: LogLevel;
  } = {},
): Promise<Harness> {
  const store = opts.store ?? (await memoryStore());
  await seedCredential(store, { id: "c-target", provider: "anthropic" });
  await seedCredential(store, { id: "c-judge", provider: "openai" });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  for (const id of ["judge", "judge-2"]) {
    await store.config.putModel(
      virtualModel({ id, targets: [target({ provider: "openai", model: "gpt-judge" })] }),
    );
  }
  await store.config.putSettings({
    guardrailModel: "judge",
    guardrailTimeoutMs: 40,
    ...opts.settings,
  });
  const policy = opts.policy === undefined ? "Only software engineering work." : opts.policy;
  const { raw, key } = await seedApiKey(store, { guardrailPolicy: policy });

  const targetCalls: AdapterRequest[] = [];
  const judgeCalls: AdapterRequest[] = [];
  let classifier = opts.classifier ?? ALLOW;
  let notify: (() => void) | null = null;
  const called = new Promise<void>((resolve) => {
    notify = resolve;
  });

  const targetAdapter: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      targetCalls.push(request);
      return { events: replay(textEvents("Hi", "claude-opus-4")), degradations: [] };
    },
  };
  const judgeAdapter: ProviderAdapter = {
    id: "openai",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      judgeCalls.push(request);
      notify?.();
      const behaviour = classifier;
      if (behaviour.kind === "error") {
        throw new GatewayError("UPSTREAM", "upstream said: the policy text was ...", {
          provider: "openai",
        });
      }
      if (behaviour.kind === "hang") return hang(request.signal);
      if (behaviour.kind === "events")
        return { events: replay(behaviour.events), degradations: [] };
      return { events: replay(textEvents(behaviour.text, "gpt-judge")), degradations: [] };
    },
  };

  const logger = captureLogger(opts.logLevel);
  const emitted: RequestCompleted[] = [];
  const debits: Harness["debits"] = [];
  const limiter = new ApiKeyRateLimiter({ store, now: () => 1_000_000, logger });
  const debit = limiter.debit.bind(limiter);
  limiter.debit = (keyId, model, usage) => {
    debits.push({ keyId, model, ...usage });
    debit(keyId, model, usage);
  };

  let n = 0;
  const app = proxyRoutes({
    store,
    adapters: Object.assign(Object.create(null), {
      anthropic: targetAdapter,
      openai: judgeAdapter,
    }),
    http: transport,
    now: () => 1_000_000,
    rand: () => 0.5,
    refresh: async (c) => await c.secrets(),
    requestId: () => `req_${++n}`,
    logger,
    rateLimiter: limiter,
    emit: (event) => emitted.push(event),
    ...opts.deps,
  });

  const bodyFor = (surface: Surface, stream: boolean): Record<string, unknown> =>
    surface === "anthropic"
      ? {
          model: "fast",
          max_tokens: 100,
          stream,
          messages: [{ role: "user", content: "review this function" }],
        }
      : surface === "openai"
        ? { model: "fast", stream, messages: [{ role: "user", content: "review this function" }] }
        : { model: "fast", stream, input: "review this function" };

  const call: Harness["call"] = (surface, callOpts = {}) =>
    app.handle(
      new Request(`http://localhost${PATH[surface]}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${raw}` },
        body: JSON.stringify({
          ...bodyFor(surface, callOpts.stream ?? false),
          ...callOpts.body,
        }),
        ...(callOpts.signal === undefined ? {} : { signal: callOpts.signal }),
      }),
    );

  return {
    store,
    raw,
    keyId: key.id,
    logger,
    targetCalls,
    judgeCalls,
    emitted,
    debits,
    setClassifier: (next) => {
      classifier = next;
    },
    classifierCalled: () => called,
    call,
  };
}

/** The text of every block the classifier was sent, system and user alike. */
export function classifierText(request: AdapterRequest): string {
  const blocks = [
    ...(request.request.system ?? []),
    ...request.request.messages.flatMap((m) => m.content),
  ];
  return blocks.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

/** Parses an SSE body into its frames. */
export function frames(text: string): Array<{ event: string; data: string }> {
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("event:"))
    .map((chunk) => {
      const [eventLine = "", ...rest] = chunk.split("\n");
      return {
        event: eventLine.slice("event: ".length),
        data: rest.map((line) => line.replace(/^data: /, "")).join("\n"),
      };
    });
}
