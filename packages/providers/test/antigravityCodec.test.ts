import { describe, expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { antigravityCodec } from "../src/antigravity/codec.ts";
import type { CodecInput } from "../src/codec.ts";
import capture from "./fixtures/antigravity-2.34.0.json";

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

  test("uses the recorded App agent header spelling, values and order", () => {
    const { request } = antigravityCodec.buildRequest(input());
    // The gateway transport does not negotiate compressed responses here.
    expect(request.headers).toEqual(
      capture.headers
        .filter(([name]) => name !== "Accept-Encoding")
        .map(([name, value]) => {
          if (name === undefined || value === undefined) throw Error("malformed capture header");
          return [name, name === "Authorization" ? "Bearer at-1" : value];
        }),
    );
  });

  test("serializes the agent envelope in the recorded App order", () => {
    const { request } = antigravityCodec.buildRequest(input());
    const body = JSON.parse(request.body);
    expect(Object.keys(body)).toEqual(Object.keys(capture.envelope));
    expect(body.userAgent).toBe(capture.envelope.userAgent);
    expect(body.requestType).toBe(capture.envelope.requestType);
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
  test("prefixes the gateway's own id with the recorded request kind", () => {
    const built = antigravityCodec.buildRequest(input());
    expect(JSON.parse(built.request.body).requestId).toBe(
      capture.envelope.requestId.replace("<id>", "req-1"),
    );
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
