import { expect, test } from "bun:test";
import type { ChatRequest, ContentBlock } from "@omni/ir";
import { ADAPTERS } from "../src/registry.ts";
import type { HttpResponse } from "../src/types.ts";

/**
 * What every adapter does with a `system` block it cannot send.
 *
 * **A discovery instrument at the provider boundary, walking `ADAPTERS` rather
 * than naming six providers.** It exists because the fix for this bug was made
 * one layer too high and the bug survived it.
 *
 * `requiredCapabilities` was taught to read `request.system` so that an image in
 * a system prompt excludes an `images: false` target. That is correct and it is
 * not the fix: `kimi` is the only built-in declaring `images: false`, so the
 * other five pass the check and then drop the block anyway. Every adapter's
 * system path is the same text-only fold —
 * `req.system?.flatMap((b) => (b.type === "text" ? [b.text] : []))` — with no
 * `note()`, while the message loop directly below it records every non-text case
 * it drops. Seven sites, one idiom, and the router change hid the asymmetry
 * rather than closing it.
 *
 * `packages/router/test/blockPositions.test.ts` cannot see this. It is a matrix
 * of positions against *router predicates*, and the same position asymmetry
 * lives one package over. That is the whole lesson of this file: an instrument
 * scoped to the layer a review happened to name has the blind spot the fix had.
 *
 * The rule asserted here is the one CLAUDE.md already states for the message
 * path — "record degradations for requested features provider cannot express" —
 * applied to the position that was exempt from it. Dropping is fine. Dropping
 * *silently* is not: a client's reference image vanishes, the model answers as
 * though it were never sent, and `request_logs` shows a clean 200 with
 * `degradations: []`.
 */

const SYSTEM_ONLY: ContentBlock[] = [
  { type: "text", text: "you are a helpful assistant" },
  { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
];

const request = (system: ContentBlock[]): ChatRequest => ({
  model: "m",
  system,
  messages: [{ role: "user", content: [{ type: "text", text: "which is it?" }] }],
  stream: true,
});

/** An upstream that answers nothing, so only the encode path is exercised. */
const http = async (): Promise<HttpResponse> => ({
  status: 200,
  headers: new Headers({ "content-type": "text/event-stream" }),
  body: new ReadableStream({
    start(controller) {
      controller.close();
    },
  }),
  text: async () => "",
});

async function encode(
  id: string,
  system: ContentBlock[],
  protocol: "chat_completions" | "responses" = "chat_completions",
) {
  const adapter = ADAPTERS[id];
  if (adapter === undefined) throw new Error(`no adapter for ${id}`);
  const result = await adapter.send({
    request: request(system),
    model: "m",
    // Both ways in and a custom endpoint, so no adapter refuses before it
    // encodes — `custom` needs an API key and an origin, the OAuth ones need a
    // token. The point of reach here is the encoder, not the auth check.
    credentials: {
      // API key rather than a token: Anthropic's OAuth leg injects its own
      // identity line and records `anthropic:oauth-system-prefix` for it, which
      // is a real degradation about something else and would make the control
      // below assert nothing.
      accessToken: null,
      apiKey: "test-key",
      providerData: {
        endpointId: "e1",
        endpointLabel: "E",
        origin: "https://upstream.test",
        basePath: "",
        protocol,
      },
    },
    http,
    signal: new AbortController().signal,
  });
  // The stream is never read: `send` has already built and sent the wire body,
  // which is the whole of what this asserts on.
  return result.degradations;
}

test("every adapter is checked, and the registry is what decides which", async () => {
  // Walked, not listed. A seventh provider joins this test the day it is
  // registered — which is the property the six-name version of this file would
  // have lacked, and the reason the original bug reached seven call sites.
  const ids = Object.keys(ADAPTERS);
  expect(ids.length).toBeGreaterThanOrEqual(6);

  const silent: string[] = [];
  for (const id of ids) {
    const degradations = await encode(id, SYSTEM_ONLY);
    if (degradations.length === 0) silent.push(id);
  }

  expect(silent).toEqual([]);
});

test("a system prompt of plain text degrades nothing, in every adapter", async () => {
  // The positive control the sweep above needs: an adapter that recorded a
  // degradation unconditionally would satisfy every row of it.
  const noisy: string[] = [];
  for (const id of Object.keys(ADAPTERS)) {
    const degradations = await encode(id, [{ type: "text", text: "plain" }]);
    if (degradations.length > 0) noisy.push(`${id}: ${degradations.join(",")}`);
  }

  expect(noisy).toEqual([]);
});
