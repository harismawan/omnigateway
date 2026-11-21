import { anthropicCodec } from "../../../packages/providers/src/anthropic/codec.ts";

const rows = [];
for (const model of ["m", "claude-haiku-4-5"])
  for (const oauth of [true, false])
    for (const review of [true, false]) {
      const request: Parameters<typeof anthropicCodec.buildRequest>[0]["request"] = {
        model: "virtual",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [{ kind: "portable", name: "read_file", inputSchema: {} }],
        betas: ["context-1m-2025-08-07", "test-beta"],
        providerHeaders: {
          anthropic: {
            "anthropic-beta": "test-beta, context-1m-2025-08-07",
            "anthropic-version": "2023-06-01",
            "anthropic-extra": "yes",
          },
        },
        ...(review ? { vendor: { anthropic: { safeguards: [{ type: "test" }] } } } : {}),
      };
      const credentials = {
        accessToken: oauth ? "token" : null,
        apiKey: oauth ? null : "key",
        providerData: {},
      };
      const result = anthropicCodec.buildRequest({
        request,
        model,
        credentials,
        fail: (_code, message) => new Error(message),
      });
      rows.push({
        request,
        model,
        credentials,
        wire: result.request,
        degradations: result.degradations,
        cloakedTools: result.cloakedTools ?? null,
      });
    }
console.log(JSON.stringify(rows));
