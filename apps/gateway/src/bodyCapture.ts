import type { ProviderId } from "@omni/ir";
import type { HttpClient, HttpResponse } from "@omni/providers";
import { MAX_ARTIFACT_BYTES } from "@omni/store";
import type { CaptureBudget } from "./bodies/budget.ts";

/**
 * How many UTF-8 bytes of one side are kept in memory before the rest is
 * discarded: the client request, the client response (or its frames), and
 * each attempt's request and response.
 *
 * Derived from the artifact ceiling rather than picked: `prepareArtifact`
 * replaces every body with an omission marker once the serialized artifact
 * passes `MAX_ARTIFACT_BYTES`, so bytes captured past that point cannot reach
 * disk in any form. The cap is per side rather than per artifact because the
 * collector cannot know how many attempts are still to come.
 *
 * Capping does not mean stopping: the capture branch of a tee that is not read
 * to the end backs the source up until the adapter's branch stalls, so bytes
 * past the cap are read and dropped rather than left in the pipe.
 *
 * Bytes, not code units, on every path, so the number means what the budget
 * below and the artifact ceiling mean. Peak per-request capture is therefore
 * this times attempts plus one — which is why the global budget exists.
 */
export const MAX_CAPTURED_BODY_BYTES = MAX_ARTIFACT_BYTES;

/** Why a capture was given up on. Only the budget, here; the body writer adds its own. */
export type AbandonReason = "budget";

/**
 * One request's capture, as text, handed to whatever writes it.
 *
 * Raw strings and nothing parsed: the client request is the text the route
 * read, the client response the JSON it sent (or the frames it streamed), and
 * every wire body the text that crossed the transport. Parsing, masking and
 * serializing are the writer's, so none of it happens on the request path.
 *
 * `reservedBytes` is held against the capture budget on the writer's behalf:
 * whoever writes these parts releases it once the write is done or has failed.
 */
export type CapturedParts = {
  requestId: string;
  at: number;
  client: { request: string | null; response: string | string[] | null; truncated: boolean };
  attempts: Array<{
    attempt: number;
    provider: ProviderId;
    request: string | null;
    response: string | null;
    streamChunks: string[] | null;
    truncated: boolean;
  }>;
  /** What the request failed with — code and status only — or null. */
  error: unknown;
  /** Set when capture was given up on; every body above is then null. */
  abandoned: AbandonReason | null;
  reservedBytes: number;
};

/**
 * One outbound wire call, filled in as it happens.
 *
 * Mutable on purpose. A drain that is still running when the parts are taken —
 * a hung upstream, a stream cut off by a disconnect — has already recorded
 * everything it read, so the artifact holds a partial response instead of
 * nothing at all.
 */
type Attempt = {
  attempt: number;
  provider: ProviderId;
  request: string | null;
  /**
   * Response text as it arrived, held as the decoded segments rather than one
   * accumulating string, and joined only when the parts are taken — which is
   * what lets a drain still running contribute exactly what it has read.
   */
  responseChunks: string[];
  /** Set once anything responded, so an attempt that never answered stays null. */
  responded: boolean;
  frames: string[] | null;
  truncated: boolean;
};

export type BodyCollectorOptions = {
  /**
   * Whether raw SSE frames are retained per attempt. Off, a streaming response
   * appears only as the reassembled body, which is what almost every incident
   * needs; on, it is additionally kept frame by frame, which is the only way to
   * debug stream framing itself and the most expensive thing this can store.
   */
  captureStreamChunks: boolean;
  requestId: string;
  at: number;
  /** The process-wide budget every byte kept here is reserved against. */
  budget: CaptureBudget;
  /** Told once, when a reservation is refused and the capture is abandoned. */
  onAbandoned?: (reason: AbandonReason) => void;
};

export type BodyCollector = {
  /**
   * Wraps the transport for one request.
   *
   * Installed only when capture is on, so an installation that never enables it
   * runs the transport it ran before this existed.
   */
  wrap(http: HttpClient): HttpClient;
  /** The request text exactly as it arrived at `/v1/*`, before anything parsed it. */
  captureRequest(text: string): void;
  /** The serialized body the client was sent; replaces whatever was recorded before. */
  captureResponse(text: string): void;
  /**
   * One frame written to a streaming client. The most recent are kept: an
   * incident is about how a stream ended, so the head is evicted to stay under
   * the cap, never the terminal frame — and the eviction marks the client side
   * truncated, because the frames left behind are well-formed and would
   * otherwise read as a complete short response. A frame larger than the whole
   * cap is discarded with truncation rather than retained partially.
   */
  frame(frame: string): void;
  /** The client side is incomplete for a reason only the route knows — a hang-up. */
  markTruncated(): void;
  readonly abandoned: AbandonReason | null;
  /** Resolves once every capture drain has finished or failed. */
  settle(): Promise<void>;
  /**
   * The parts, once. The collector's reservation moves to them, and nothing
   * arriving afterwards is stored or reserved.
   */
  take(error: unknown): CapturedParts;
};

const encoder = new TextEncoder();

/** UTF-8 length without materialising the bytes. */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * `text` cut to at most `max` UTF-8 bytes on a character boundary.
 *
 * The cut is decoded back from bytes rather than taken with `slice`, because a
 * slice can share the storage of the whole original — keeping alive exactly the
 * bytes the cap exists to drop.
 */
function fitted(text: string, max: number): { text: string; bytes: number; cut: boolean } {
  const bytes = utf8Bytes(text);
  if (bytes <= max) return { text, bytes, cut: false };
  const room = new Uint8Array(max);
  // `encodeInto` stops before a character that would not fit whole.
  const { written } = encoder.encodeInto(text, room);
  return { text: new TextDecoder().decode(room.subarray(0, written)), bytes: written, cut: true };
}

/**
 * Splits a reassembled SSE body into its records.
 *
 * Network chunk boundaries fall anywhere, including mid-field, so the frames a
 * reader wants are not the chunks that arrived — they are the blank-line
 * separated records, which only exist once the body is reassembled. A body that
 * is not SSE splits into a single element, which is the honest answer for it.
 */
function framesOf(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .filter((frame) => frame.length > 0);
}

export function createBodyCollector(options: BodyCollectorOptions): BodyCollector {
  const { budget } = options;
  const attempts: Attempt[] = [];
  const drains: Promise<void>[] = [];
  let clientRequest: string | null = null;
  let clientResponse: string | string[] | null = null;
  /** What the client response holds, in bytes — the text's, or the frames' together. */
  let responseBytes = 0;
  let clientTruncated = false;
  let abandoned: AbandonReason | null = null;
  let taken = false;
  /** Everything this collector has reserved and not given back. */
  let held = 0;

  const storing = (): boolean => abandoned === null && !taken;

  /**
   * Gives every buffer up and every byte back.
   *
   * The attempt list survives without its bodies: which providers were tried,
   * in what order, is the frame an omission marker keeps.
   */
  const abandon = (reason: AbandonReason): void => {
    abandoned = reason;
    budget.release(held);
    held = 0;
    clientRequest = null;
    clientResponse = null;
    responseBytes = 0;
    for (const entry of attempts) {
      entry.request = null;
      entry.responseChunks = [];
      entry.frames = null;
    }
    options.onAbandoned?.(reason);
  };

  /** Reserves `bytes` for storing, or abandons. False means do not store them. */
  const reserve = (bytes: number): boolean => {
    if (!storing()) return false;
    if (!budget.reserve(bytes)) {
      abandon("budget");
      return false;
    }
    held += bytes;
    return true;
  };

  const release = (bytes: number): void => {
    budget.release(bytes);
    held -= bytes;
  };

  /**
   * Reads a tee branch to the end and records what it saw.
   *
   * Every rule this feature has about streaming lives in this loop:
   *
   * - It never stops early. A tee whose second branch is abandoned buffers for
   *   it until the first branch stalls, which would turn body logging into a
   *   latency bug under load, so the loop keeps reading past the cap — and past
   *   an abandoned capture — and throws the bytes away instead of leaving them
   *   in the pipe.
   * - It never throws. A capture failure — a decode error, a source that died
   *   mid-stream — degrades to a partial artifact, and nothing here is on the
   *   path the client's bytes travel.
   * - It records as it goes, so a drain still running when the parts are taken
   *   contributes what it had.
   *
   * Termination is the transport's, not this loop's: the request signal aborts
   * on every way a request can end, `nodeHttpClient` destroys the socket, and
   * the source errors here. That is why there is no timer and no listener to
   * clean up.
   */
  const drain = async (stream: ReadableStream<Uint8Array>, entry: Attempt): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let kept = 0;
    let full = false;
    const retain = (text: string): void => {
      // Invalid input can expand into replacement characters. Count the UTF-8
      // text we keep, not the source bytes (including text from the final flush).
      const part = fitted(text, MAX_CAPTURED_BODY_BYTES - kept);
      if (part.cut) {
        full = true;
        entry.truncated = true;
      }
      if (part.bytes === 0 || !reserve(part.bytes)) return;
      kept += part.bytes;
      entry.responseChunks.push(part.text);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done === true) break;
        if (value === undefined) continue;
        entry.responded = true;
        if (full) {
          entry.truncated = true;
          continue;
        }
        if (!storing()) continue;
        retain(decoder.decode(value, { stream: true }));
      }
      if (!full && storing()) retain(decoder.decode());
    } catch {
      // Whatever broke, it broke on the capture branch. The adapter's branch is
      // a separate reader over a separate queue and is untouched by this.
      entry.truncated = true;
    } finally {
      reader.releaseLock();
    }
    if (options.captureStreamChunks && storing()) recordFrames(entry, entry.responseChunks.join(""));
  };

  const recordFrames = (entry: Attempt, text: string): void => {
    if (!options.captureStreamChunks || !storing()) return;
    const frames = framesOf(text);
    if (reserve(frames.reduce((sum, frame) => sum + utf8Bytes(frame), 0))) entry.frames = frames;
  };

  /**
   * Wraps one response so whichever half the adapter reads is the half captured.
   *
   * `body` and `text()` are two views of one underlying socket and an adapter
   * uses exactly one of them — the streaming path takes `body`, `httpError`
   * takes `text()`. Reading both would consume the response twice, so `body` is
   * a getter that tees on first touch and `text()` records what it returned:
   * whichever the adapter reaches for is the one that captures, and the other
   * never runs.
   */
  const captureWireResponse = (res: HttpResponse, entry: Attempt): HttpResponse => {
    let forAdapter: ReadableStream<Uint8Array> | null | undefined;
    return {
      status: res.status,
      headers: res.headers,
      get body() {
        if (forAdapter !== undefined) return forAdapter;
        const source = res.body;
        if (source === null) {
          forAdapter = null;
          return null;
        }
        const [adapterBranch, captureBranch] = source.tee();
        // Started, deliberately not awaited. The adapter is handed its branch
        // in the same turn it asked for it, and the capture branch catches up
        // on its own; `settle` is where the write waits for it, long after the
        // response has finished.
        drains.push(drain(captureBranch, entry));
        forAdapter = adapterBranch;
        return forAdapter;
      },
      text: async () => {
        const text = await res.text();
        entry.responded = true;
        const kept = fitted(text, MAX_CAPTURED_BODY_BYTES);
        if (kept.cut) entry.truncated = true;
        if (reserve(kept.bytes)) {
          entry.responseChunks = [kept.text];
          recordFrames(entry, kept.text);
        }
        return text;
      },
    };
  };

  /** Drops whatever client response is held and gives its bytes back. */
  const dropResponse = (): void => {
    release(responseBytes);
    responseBytes = 0;
    clientResponse = null;
  };

  return {
    get abandoned() {
      return abandoned;
    },

    captureRequest(text) {
      if (!storing()) return;
      const kept = fitted(text, MAX_CAPTURED_BODY_BYTES);
      if (!reserve(kept.bytes)) return;
      clientRequest = kept.text;
      if (kept.cut) clientTruncated = true;
    },

    captureResponse(text) {
      if (!storing()) return;
      dropResponse();
      const kept = fitted(text, MAX_CAPTURED_BODY_BYTES);
      if (!reserve(kept.bytes)) return;
      clientResponse = kept.text;
      responseBytes = kept.bytes;
      if (kept.cut) clientTruncated = true;
    },

    frame(frame) {
      if (!storing()) return;
      if (!Array.isArray(clientResponse)) {
        dropResponse();
        clientResponse = [];
      }
      const frames = clientResponse;
      const bytes = utf8Bytes(frame);
      if (bytes > MAX_CAPTURED_BODY_BYTES) {
        clientTruncated = true;
        return;
      }
      // Evicted before the new frame is reserved, so a stream at its cap
      // holds the cap and not the cap plus one frame.
      while (frames.length > 0 && responseBytes + bytes > MAX_CAPTURED_BODY_BYTES) {
        const evicted = utf8Bytes(frames.shift() ?? "");
        release(evicted);
        responseBytes -= evicted;
        clientTruncated = true;
      }
      if (!reserve(bytes)) return;
      frames.push(frame);
      responseBytes += bytes;
    },

    markTruncated() {
      clientTruncated = true;
    },

    wrap(http: HttpClient): HttpClient {
      return async (req) => {
        // `req.headers` is never read, here or anywhere below. Every provider
        // authenticates through headers, so that list is where the OAuth tokens
        // and API keys are; the decorator taking only `body` and `provider` is
        // what makes "headers are never captured" a property of this layer
        // rather than a rule each new adapter has to remember.
        //
        // One entry per outbound call, numbered in wire order. That is not
        // `request_logs.attempts`: an AUTH failure that refreshes and retries
        // makes a second HTTP call inside one dispatch attempt and gets its own
        // entry here, because for forensics the two calls are two different
        // things that went to the provider.
        const kept = storing() ? fitted(req.body, MAX_CAPTURED_BODY_BYTES) : null;
        const entry: Attempt = {
          attempt: attempts.length + 1,
          provider: req.provider,
          request: null,
          responseChunks: [],
          responded: false,
          frames: null,
          truncated: kept?.cut === true,
        };
        // Recorded before the call, so a transport that throws still leaves the
        // request that was attempted in the artifact.
        attempts.push(entry);
        if (kept !== null && reserve(kept.bytes)) entry.request = kept.text;
        const res = await http(req);
        return captureWireResponse(res, entry);
      };
    },

    async settle(): Promise<void> {
      // `drain` never rejects, so this is a join rather than an error path.
      await Promise.all(drains);
    },

    take(error) {
      if (taken) throw new Error("body capture already taken");
      const reservedBytes = held;
      const parts: CapturedParts = {
        requestId: options.requestId,
        at: options.at,
        client: {
          request: clientRequest,
          response: Array.isArray(clientResponse) ? [...clientResponse] : clientResponse,
          truncated: clientTruncated,
        },
        attempts: attempts.map((entry) => ({
          attempt: entry.attempt,
          provider: entry.provider,
          request: entry.request,
          response: entry.responded && abandoned === null ? entry.responseChunks.join("") : null,
          streamChunks: entry.frames,
          truncated: entry.truncated,
        })),
        error,
        abandoned,
        reservedBytes,
      };
      taken = true;
      held = 0;
      clientRequest = null;
      clientResponse = null;
      responseBytes = 0;
      for (const entry of attempts) {
        entry.request = null;
        entry.responseChunks = [];
        entry.frames = null;
      }
      attempts.length = 0;
      drains.length = 0;
      return parts;
    },
  };
}
