import { expect, test } from "bun:test";
import { probeText } from "./bench-probe";

for (const phase of ["headers", "body"]) {
  test(`smoke deadline bounds stalled ${phase}`, async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        if (phase === "headers") return new Promise<Response>(() => {});
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("partial")); } }));
      },
    });
    try {
      await expect(probeText(server.url.toString(), {}, 50)).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  }, 2000);
}
