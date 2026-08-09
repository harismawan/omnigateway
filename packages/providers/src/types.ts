import type { ChatRequest, ProviderId, StreamEvent } from "@omni/ir";

/** One header, name casing preserved exactly as it goes on the wire. */
export type HeaderPair = readonly [name: string, value: string];

/**
 * An upstream request with everything already decided.
 *
 * Headers are ordered and cased; the body is a finished string. The transport
 * writes both verbatim — it never sorts, re-cases, or re-serializes. This is
 * the whole reason the seam exists: Bun's `fetch` sorts request headers
 * alphabetically, which destroys the CLI fingerprint.
 */
export type HttpRequest = {
  provider: ProviderId;
  url: string;
  method: string;
  headers: readonly HeaderPair[];
  body: string;
  signal: AbortSignal;
};

export type HttpResponse = {
  status: number;
  /** Response side only. Order does not matter here. */
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

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
  /** Injected so tests can capture the exact bytes an adapter puts on the wire. */
  http: HttpClient;
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
