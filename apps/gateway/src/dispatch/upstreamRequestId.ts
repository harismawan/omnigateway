import { type HttpClient, upstreamRequestIdOf } from "@omni/providers";

/**
 * The provider's request id for one request, across its attempts.
 *
 * The row names the id of the attempt that produced its outcome — the serving
 * one, or the last tried. So each attempt starts by **clearing** the id (an
 * attempt that never gets a response head must not inherit the previous
 * attempt's), and only the newest attempt's watcher may write: a response that
 * arrives late from an abandoned attempt is ignored.
 */
export function createUpstreamRequestIdRecorder(onId: (id: string | null) => void): {
  /** A transport for the next attempt; supersedes every earlier one. */
  forAttempt(http: HttpClient): HttpClient;
} {
  let generation = 0;
  return {
    forAttempt(http) {
      const mine = ++generation;
      onId(null);
      const watched: HttpClient = async (request) => {
        const response = await http(request);
        if (mine === generation) onId(upstreamRequestIdOf(response.headers));
        return response;
      };
      return Object.assign(watched, { [WATCHED]: http });
    },
  };
}

/**
 * The transport a watched client wraps. Lets a test ask "which transport did
 * this attempt really get" — the bare one, or the body-capturing decorator —
 * now that every attempt's transport is wrapped once more by the recorder.
 */
export const WATCHED: unique symbol = Symbol("omni.upstreamRequestId.watched");

export function unwatched(http: HttpClient): HttpClient {
  return (http as HttpClient & { [WATCHED]?: HttpClient })[WATCHED] ?? http;
}
