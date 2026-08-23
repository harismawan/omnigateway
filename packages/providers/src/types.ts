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
  /**
   * The gateway's own request id, when there is one.
   *
   * Carried so an adapter whose upstream expects a correlation id can reuse the
   * value stdout and `request_logs` already join on, instead of minting a third
   * unrelated identifier. Optional because callers outside dispatch have none.
   */
  requestId?: string;
  /**
   * Whether the adapter may add a cache breakpoint the client did not send.
   *
   * A policy the operator set, not a property of the request, so it arrives
   * beside it rather than inside it: writing it onto the `ChatRequest` would
   * put a gateway decision into the object RTK, routing and the token estimate
   * all read as the caller's own. Only the Anthropic adapter reads it.
   */
  autoCache?: boolean;
};

export type AdapterResult = {
  /** Canonical events. The first blockDelta is dispatch's commit point. */
  events: AsyncGenerator<StreamEvent, void, undefined>;
  /** Capability reductions applied while building the wire request. */
  degradations: string[];
  /**
   * How many client tool names an adapter renamed on the outbound leg.
   *
   * A count and never the names: a tool name is client free text, and the
   * caller puts this straight into `LogFields`, which is the redaction
   * boundary. Absent when nothing was renamed, which is every adapter but
   * Anthropic's and, within it, every request on an API key.
   */
  cloakedTools?: number;
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
