import { describe, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { antigravityCodec } from "../src/antigravity/codec.ts";
import type { CodecInput } from "../src/codec.ts";

const fail: CodecInput["fail"] = (code, message, opts) =>
  new GatewayError(code, message, opts as never);

function input(overrides: Partial<CodecInput> = {}): CodecInput {
  return {
    request: { model: "gemini-3.6-flash-high", messages: [], stream: true },
    model: "gemini-3.6-flash-high",
    credentials: {
      accessToken: "at-1",
      apiKey: null,
      providerData: { projectId: "projects/p-1" },
    },
    requestId: "req-1",
    fail,
    ...overrides,
  };
}

function headerOf(headers: readonly (readonly [string, string])[], name: string) {
  return headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
}

describe("the request", () => {
  test("always asks the streaming endpoint, on the runtime host", () => {
    const built = antigravityCodec.buildRequest(input());
    // **`daily-` is load-bearing, not a canary.** Measured against a live
    // account: this host served the request, plain `cloudcode-pa` answered 429
    // for the same bytes while that account's quota read 0% used and its IDE
    // was generating. Only the bootstrap and quota RPCs belong on `cloudcode-pa`.
    expect(built.request.url).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    expect(built.request.method).toBe("POST");
  });

  test("inference does not share the bootstrap host", () => {
    // Its own assertion because collapsing the two is exactly what shipped
    // first, and it fails as a uniform 429 that reads as an account problem
    // rather than a routing one — so the equality above could be "fixed" back
    // to the wrong host by someone tidying two constants into one.
    expect(antigravityCodec.buildRequest(input()).request.url).not.toContain(
      "//cloudcode-pa.googleapis.com",
    );
  });

  test("a non-streaming client request uses the same streaming endpoint", () => {
    const built = antigravityCodec.buildRequest(
      input({ request: { model: "m", messages: [], stream: false } }),
    );
    expect(built.request.url).toContain("streamGenerateContent");
  });

  test("carries the bearer token and the client identity", () => {
    const built = antigravityCodec.buildRequest(input());
    expect(headerOf(built.request.headers, "authorization")).toBe("Bearer at-1");
    expect(headerOf(built.request.headers, "user-agent")).toContain("antigravity/ide/");
    expect(headerOf(built.request.headers, "accept")).toBe("text/event-stream");
  });
});

describe("the project id", () => {
  test("comes from providerData and reaches the envelope", () => {
    const built = antigravityCodec.buildRequest(input());
    expect(JSON.parse(built.request.body).project).toBe("projects/p-1");
  });

  test("an absent project is refused before a request is built", () => {
    expect(() =>
      antigravityCodec.buildRequest(
        input({ credentials: { accessToken: "at-1", apiKey: null, providerData: {} } }),
      ),
    ).toThrow(/reconnect/i);
  });

  test("a blank project is refused too", () => {
    expect(() =>
      antigravityCodec.buildRequest(
        input({
          credentials: { accessToken: "at-1", apiKey: null, providerData: { projectId: "   " } },
        }),
      ),
    ).toThrow(/reconnect/i);
  });

  test("a credential with no access token is an AUTH failure", () => {
    let thrown: unknown;
    try {
      antigravityCodec.buildRequest(
        input({
          credentials: {
            accessToken: null,
            apiKey: null,
            providerData: { projectId: "projects/p-1" },
          },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayError);
    expect((thrown as GatewayError).code).toBe("AUTH");
  });
});

describe("the request id", () => {
  test("reuses the gateway's own when there is one", () => {
    const built = antigravityCodec.buildRequest(input());
    expect(JSON.parse(built.request.body).requestId).toBe("req-1");
  });

  test("is derived, not random, when the caller has none", () => {
    const a = antigravityCodec.buildRequest(input({ requestId: undefined }));
    const b = antigravityCodec.buildRequest(input({ requestId: undefined }));
    // The contract requires the same input to describe the same request: the
    // host may build once and send on more than one attempt.
    expect(JSON.parse(a.request.body).requestId).toBe(JSON.parse(b.request.body).requestId);
    expect(JSON.parse(a.request.body).requestId).not.toBe("");
  });
});
