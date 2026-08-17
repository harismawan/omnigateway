import type { ProviderId } from "@omni/ir";
import type { HttpClient, HttpResponse } from "@omni/providers";
import { type BodyAttempt, type BodyPair, MAX_ARTIFACT_BYTES } from "@omni/store";

/**
 * How much of one wire body is kept in memory before the rest is discarded.
 *
 * Derived from the artifact ceiling rather than picked: `prepareArtifact`
 * replaces every body with an omission marker once the serialized artifact
 * passes `MAX_ARTIFACT_BYTES`, so bytes captured past that point cannot reach
 * disk in any form — they can only make the artifact large enough to be thrown
 * away wholesale. The cap is per body rather than per artifact because the
 * collector cannot know how many attempts are still to come, and a per-attempt
 * bound is the only one it can enforce as the bytes arrive.
 *
 * Capping does not mean stopping: the capture branch of a tee that is not read
 * to the end backs the source up until the adapter's branch stalls, so bytes
 * past the cap are read and dropped rather than left in the pipe.
 *
 * A soft bound, not an accounting one. The streaming path measures the bytes it
 * read; the two buffered paths cut a string at this many code units, which is
 * never fewer bytes than it says. The hard bound on what is stored is the
 * structural bounding inside `bodies.put`, and it runs on everything captured
 * here whatever this let through.
 *
 * Reusing the artifact ceiling as a per-body cap means the two numbers are not
 * the same bound. `MAX_ARTIFACT_BYTES` bounds one file on disk; this bounds each
 * of the client response and every attempt's request and response held in memory
 * at once, so peak per-request capture is roughly `MAX_ARTIFACT_BYTES` times
 * attempts plus one, not `MAX_ARTIFACT_BYTES`. A failover across three providers
 * on a large response is therefore megabytes live per captured request, which is
 * the number to reason about when capture is on under load — not the artifact
 * that eventually lands.
 */
export const MAX_CAPTURED_BODY_BYTES = MAX_ARTIFACT_BYTES;

/**
 * One outbound wire call, filled in as it happens.
 *
 * Mutable on purpose. A drain that is still running when the artifact is
 * written — a hung upstream, a stream cut off by a disconnect — has already
 * recorded everything it read, so the artifact holds a partial response instead
 * of nothing at all.
 */
type Attempt = {
  attempt: number;
  provider: ProviderId;
  request: unknown;
  /** Raw response text as it arrived, reassembled. Parsed at read time. */
  responseText: string;
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
};

export type BodyCollector = {
  /**
   * Wraps the transport for one request.
   *
   * Installed only when capture is on, so an installation that never enables it
   * runs the transport it ran before this existed.
   */
  wrap(http: HttpClient): HttpClient;
  /**
   * The client-facing pair. Filled in by the route: the request as it was
   * parsed at `/v1/*`, before RTK, and the response the gateway returned.
   */
  client: BodyPair;
  /** The wire pairs, in the order the calls went out. */
  attempts(): BodyAttempt[];
  /** Resolves once every capture drain has finished or failed. */
  settle(): Promise<void>;
};

/** JSON where it parses, the raw text otherwise: a body is whatever was sent. */
function asBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
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

export type FrameSink = {
  /** The retained frames, oldest first. Live: the route holds this array. */
  frames: string[];
  /**
   * Whether anything was dropped to stay inside the cap.
   *
   * Read by the route on the way into the artifact, because the sink is the
   * only thing that can see this: the frames it kept are well-formed and end on
   * the terminal event, so an artifact whose head was evicted is structurally
   * indistinguishable from a short response. `message_start` carries the
   * upstream message id, the model, and the input token count, and losing it
   * silently is how a partial record comes to read as a complete one.
   */
  truncated: boolean;
  write(frame: string): void;
};

/**
 * A bounded home for the frames the gateway writes to a streaming client.
 *
 * A stream has no rendered body to record, so the frames are the response, and
 * a long one produces thousands of them. The most recent are kept, matching
 * what `MAX_ARRAY_ITEMS` does to an array on the way into an artifact: an
 * incident is about how a stream ended, and keeping the head would reliably
 * discard the terminal frame in favour of the first token.
 */
export function createFrameSink(): FrameSink {
  const frames: string[] = [];
  let bytes = 0;
  const sink: FrameSink = {
    frames,
    truncated: false,
    write(frame: string): void {
      frames.push(frame);
      bytes += frame.length;
      while (bytes > MAX_CAPTURED_BODY_BYTES && frames.length > 1) {
        bytes -= (frames.shift() ?? "").length;
        // Closes over `sink` rather than using `this`: the route hands `write`
        // to the SSE writer as a bare function, so there is no receiver.
        sink.truncated = true;
      }
    },
  };
  return sink;
}

export function createBodyCollector(options: BodyCollectorOptions): BodyCollector {
  const attempts: Attempt[] = [];
  const drains: Promise<void>[] = [];
  const client: BodyPair = { request: null, response: null, truncated: false };

  /**
   * Reads a tee branch to the end and records what it saw.
   *
   * Every rule this feature has about streaming lives in this loop:
   *
   * - It never stops early. A tee whose second branch is abandoned buffers for
   *   it until the first branch stalls, which would turn body logging into a
   *   latency bug under load, so the loop keeps reading past the cap and throws
   *   the bytes away instead of leaving them in the pipe.
   * - It never throws. A capture failure — a decode error, a source that died
   *   mid-stream — degrades to a partial artifact, and nothing here is on the
   *   path the client's bytes travel.
   * - It records as it goes, so a drain still running when the artifact is
   *   written contributes what it had.
   *
   * Termination is the transport's, not this loop's: the request signal aborts
   * on every way a request can end, `nodeHttpClient` destroys the socket, and
   * the source errors here. That is why there is no timer and no listener to
   * clean up.
   */
  const drain = async (stream: ReadableStream<Uint8Array>, entry: Attempt): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done === true) break;
        if (value === undefined) continue;
        entry.responded = true;
        if (bytes >= MAX_CAPTURED_BODY_BYTES) {
          entry.truncated = true;
          continue;
        }
        bytes += value.byteLength;
        entry.responseText += decoder.decode(value, { stream: true });
        if (bytes > MAX_CAPTURED_BODY_BYTES) entry.truncated = true;
      }
      entry.responseText += decoder.decode();
    } catch {
      // Whatever broke, it broke on the capture branch. The adapter's branch is
      // a separate reader over a separate queue and is untouched by this.
      entry.truncated = true;
    } finally {
      reader.releaseLock();
    }
    if (options.captureStreamChunks) entry.frames = framesOf(entry.responseText);
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
  const captureResponse = (res: HttpResponse, entry: Attempt): HttpResponse => {
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
        entry.responseText = text.slice(0, MAX_CAPTURED_BODY_BYTES);
        if (entry.responseText.length < text.length) entry.truncated = true;
        if (options.captureStreamChunks) entry.frames = framesOf(entry.responseText);
        return text;
      },
    };
  };

  return {
    client,

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
        const entry: Attempt = {
          attempt: attempts.length + 1,
          provider: req.provider,
          request:
            req.body.length > MAX_CAPTURED_BODY_BYTES
              ? req.body.slice(0, MAX_CAPTURED_BODY_BYTES)
              : asBody(req.body),
          responseText: "",
          responded: false,
          frames: null,
          truncated: req.body.length > MAX_CAPTURED_BODY_BYTES,
        };
        // Recorded before the call, so a transport that throws still leaves the
        // request that was attempted in the artifact.
        attempts.push(entry);
        const res = await http(req);
        return captureResponse(res, entry);
      };
    },

    attempts(): BodyAttempt[] {
      return attempts.map((entry) => ({
        attempt: entry.attempt,
        provider: entry.provider,
        request: entry.request,
        response: entry.responded ? asBody(entry.responseText) : null,
        streamChunks: entry.frames,
        truncated: entry.truncated,
      }));
    },

    async settle(): Promise<void> {
      // `drain` never rejects, so this is a join rather than an error path.
      await Promise.all(drains);
    },
  };
}
