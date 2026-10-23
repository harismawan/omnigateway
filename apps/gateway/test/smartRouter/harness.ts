import { GatewayError, type StreamEvent } from "@omni/ir";
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
import { CONFIDENTIALITY_INSTRUCTION } from "../../src/smartRouter/classifier.ts";
import { PATH, type Surface, textEvents } from "../guardrail/harness.ts";

export { frames, PATH, SURFACES, type Surface } from "../guardrail/harness.ts";

async function* replay(
  events: readonly StreamEvent[],
): AsyncGenerator<StreamEvent, void, undefined> {
  for (const event of events) yield event;
}

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

/**
 * What the local confidentiality classifier does. `secret` answers
 * `CONFIDENTIAL` iff the segment it is sent contains `SECRET`, else `PUBLIC`.
 */
export type LocalClassifier = "secret" | "hang" | "error" | "unreadable";

/** What the local model answers with: a reply, or an upstream failure. */
export type LocalModel = "ok" | "error";

/** Everything a request carried as text, one string. */
export function sentText(call: AdapterRequest): string {
  return [...(call.request.system ?? []), ...call.request.messages.flatMap((m) => m.content)]
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");
}

const isConfidentialityCall = (call: AdapterRequest): boolean =>
  call.request.system?.some((b) => b.type === "text" && b.text === CONFIDENTIALITY_INSTRUCTION) ===
  true;

export type Harness = {
  store: Store;
  raw: string;
  keyId: string;
  logger: CaptureLogger;
  /** Every request the external target (`fast`, anthropic) received. */
  externalCalls: AdapterRequest[];
  /** Every confidentiality classifier call (`local-judge`, smart-router instruction). */
  classifierCalls: AdapterRequest[];
  /** Every guardrail call the local classifier received (`local-judge`, guardrail instruction). */
  localGuardrailCalls: AdapterRequest[];
  /** Every guardrail call the external guardrail model (`judge`, openai) received. */
  judgeCalls: AdapterRequest[];
  /** Every request the local model (`local-llm`) received. */
  localCalls: AdapterRequest[];
  emitted: RequestCompleted[];
  debits: Array<{ keyId: string; model: string; tokens: number; costUsd: number }>;
  setClassifier: (next: LocalClassifier) => void;
  setLocal: (next: LocalModel) => void;
  /** Resolves once the confidentiality classifier has received its first call. */
  classifierCalled: () => Promise<void>;
  call: (
    surface: Surface,
    opts?: { stream?: boolean; body?: Record<string, unknown>; signal?: AbortSignal },
  ) => Promise<Response>;
};

/**
 * The proxy with three stub providers:
 *
 * - `anthropic` is the external target behind `fast`;
 * - `openai` is the external guardrail classifier behind `judge`;
 * - `custom` is the operator's own hardware, behind `local-judge` (the
 *   confidentiality classifier, which also judges the guardrail on a request
 *   going local) and `local-llm` (where confidential requests go). `mixed`
 *   has one custom and one anthropic target, so it is not local-only.
 *
 * The key carries the smart-routing flag and the global switch is on, so every
 * request is screened unless a test says otherwise.
 */
export async function smartRouterHarness(
  opts: {
    policy?: string | null;
    smartRouting?: boolean;
    classifier?: LocalClassifier;
    local?: LocalModel;
    settings?: Partial<Settings>;
    deps?: Partial<ProxyDeps>;
    store?: Store;
    /** Capabilities of the local model's target. All on by default. */
    localCapabilities?: { tools: boolean; images: boolean; reasoning: boolean };
  } = {},
): Promise<Harness> {
  const store = opts.store ?? (await memoryStore());
  await seedCredential(store, { id: "c-target", provider: "anthropic" });
  await seedCredential(store, { id: "c-judge", provider: "openai" });
  await seedCredential(store, {
    id: "c-local",
    provider: "custom",
    authType: "apiKey",
    accessToken: null,
    refreshToken: null,
    apiKey: "key-local",
    providerData: {
      endpointId: "local",
      endpointLabel: "local",
      origin: "https://local.example.com",
      protocol: "chat_completions",
    },
  });
  const local = (model: string, capabilities = { tools: true, images: true, reasoning: true }) =>
    target({
      provider: "custom",
      endpointId: "local",
      model,
      costPerMTok: { input: 1, output: 1 },
      capabilities,
    });
  await store.config.putModel(
    virtualModel({
      id: "fast",
      targets: [target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  await store.config.putModel(
    virtualModel({ id: "judge", targets: [target({ provider: "openai", model: "gpt-judge" })] }),
  );
  await store.config.putModel(virtualModel({ id: "local-judge", targets: [local("judge-8b")] }));
  await store.config.putModel(
    virtualModel({ id: "local-llm", targets: [local("llama3:8b", opts.localCapabilities)] }),
  );
  await store.config.putModel(
    virtualModel({
      id: "mixed",
      targets: [local("llama3:8b"), target({ provider: "anthropic", model: "claude-opus-4" })],
    }),
  );
  await store.config.putSettings({
    guardrailModel: "judge",
    guardrailTimeoutMs: 40,
    smartRouterEnabled: true,
    smartRouterClassifierModel: "local-judge",
    smartRouterLocalModel: "local-llm",
    smartRouterTimeoutMs: 40,
    ...opts.settings,
  });
  const { raw, key } = await seedApiKey(store, {
    guardrailPolicy: opts.policy ?? null,
    smartRouting: opts.smartRouting ?? true,
  });

  const externalCalls: AdapterRequest[] = [];
  const classifierCalls: AdapterRequest[] = [];
  const localGuardrailCalls: AdapterRequest[] = [];
  const judgeCalls: AdapterRequest[] = [];
  const localCalls: AdapterRequest[] = [];
  let classifier: LocalClassifier = opts.classifier ?? "secret";
  let localModel: LocalModel = opts.local ?? "ok";
  let notify: (() => void) | null = null;
  const called = new Promise<void>((resolve) => {
    notify = resolve;
  });

  const external: ProviderAdapter = {
    id: "anthropic",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      externalCalls.push(request);
      return { events: replay(textEvents("Hi", "claude-opus-4")), degradations: [] };
    },
  };
  const judgeAdapter: ProviderAdapter = {
    id: "openai",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      judgeCalls.push(request);
      return { events: replay(textEvents("ALLOW", "gpt-judge")), degradations: [] };
    },
  };
  const custom: ProviderAdapter = {
    id: "custom",
    capabilities: { tools: true, images: true, reasoning: true },
    async send(request): Promise<AdapterResult> {
      if (request.model === "llama3:8b") {
        localCalls.push(request);
        if (localModel === "error") {
          throw new GatewayError("UPSTREAM", "local model down", { provider: "custom" });
        }
        // The upstream names itself, not the configured model id.
        return { events: replay(textEvents("Local hi", "llama3:8b")), degradations: [] };
      }
      if (!isConfidentialityCall(request)) {
        localGuardrailCalls.push(request);
        return { events: replay(textEvents("ALLOW", "judge-8b")), degradations: [] };
      }
      classifierCalls.push(request);
      notify?.();
      if (classifier === "hang") return hang(request.signal);
      if (classifier === "error") {
        throw new GatewayError("UPSTREAM", "upstream said: the policy text was ...", {
          provider: "custom",
        });
      }
      const word =
        classifier === "unreadable"
          ? "MAYBE"
          : sentText(request).includes("SECRET")
            ? "CONFIDENTIAL"
            : "PUBLIC";
      return { events: replay(textEvents(word, "judge-8b")), degradations: [] };
    },
  };

  const logger = captureLogger();
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
      anthropic: external,
      openai: judgeAdapter,
      custom,
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
    externalCalls,
    classifierCalls,
    localGuardrailCalls,
    judgeCalls,
    localCalls,
    emitted,
    debits,
    setClassifier: (next) => {
      classifier = next;
    },
    setLocal: (next) => {
      localModel = next;
    },
    classifierCalled: () => called,
    call,
  };
}

/** A body carrying `text` as the one user message, on any surface. */
export function bodyWith(surface: Surface, text: string): Record<string, unknown> {
  return surface === "responses"
    ? { input: text }
    : { messages: [{ role: "user", content: text }] };
}
