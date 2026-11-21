// Run only under the private namespace used by observability.py.
import { createStore, deriveKey } from "../../packages/store/src/index.ts";

const store = await createStore({
  path: process.argv[2]!,
  encryptionKey: await deriveKey("e3-fixture-encryption-key"),
});
await store.bodies.put({
  schemaVersion: 1,
  requestId: "body-ready",
  at: 1000,
  client: {
    request: { messages: [{ role: "user", content: "intended body output" }] },
    response: { answer: "ok" },
    truncated: false,
  },
  attempts: [
    {
      attempt: 1,
      provider: "openai",
      request: { input: "post RTK" },
      response: { output: "done" },
      streamChunks: ['data: {"delta":"done"}'],
      truncated: false,
    },
  ],
  error: null,
});
store.close();
