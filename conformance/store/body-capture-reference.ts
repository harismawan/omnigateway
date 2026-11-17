// Frozen oracle: this product module must remain identical to 1780bb39.
import { createBodyCollector, createFrameSink } from "../../apps/gateway/src/bodyCapture.ts";
const input = JSON.parse(await Bun.stdin.text());
if (!Array.isArray(input)) {
  console.log(JSON.stringify(input.sinks.map((writes: string[]) => {
    const sink = createFrameSink();
    for (const write of writes) sink.write(write);
    return { frames: sink.frames, truncated: sink.truncated };
  })));
  process.exit(0);
}
const cases = input;
const out = [];
for (const c of cases) {
  const collector = createBodyCollector({ captureStreamChunks: c.captureFrames });
  collector.client.request = JSON.parse(c.client);
  collector.client.response = JSON.parse(c.response);
  for (const a of c.attempts) {
    const http = collector.wrap(async () => {
      if (a.mode === "throw") throw new Error("transport failed");
      return {
        status: 200, headers: new Headers(),
        body: new ReadableStream({
          start(controller) {
            for (const chunk of a.chunks ?? []) controller.enqueue(Uint8Array.from(chunk));
            if (a.fail) controller.error(new Error("source failed"));
            else controller.close();
          },
        }),
        text: async () => a.text,
      };
    });
    try {
      const res = await http({ provider: a.provider, body: a.request } as never);
      if (a.mode === "text") await res.text();
      else {
        // Touching the body starts a tee drain without consuming the adapter
        // branch: capture completion must be independent of adapter reads.
        void res.body;
      }
    } catch { /* The attempted call is still captured. */ }
  }
  await collector.settle();
  out.push(JSON.stringify({
    schemaVersion: 1, requestId: "req_1", at: 123,
    client: collector.client, attempts: collector.attempts(), error: null,
  }));
}
console.log(JSON.stringify(out));
