import { createServer } from "node:net";
import { nodeHttpClient } from "../packages/providers/src/http-client";

// Rust supplies identical raw responses to this real TS transport and its own.
const cases = JSON.parse(await Bun.stdin.text()) as string[];
const results: string[] = [];
for (const response of cases) {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => socket.end(response));
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  try {
    const res = await nodeHttpClient()({
      provider: "custom",
      url: `http://127.0.0.1:${address.port}`,
      method: "POST",
      headers: [],
      body: "{}",
      signal: AbortSignal.timeout(2000),
    });
    results.push(`ok:${await res.text()}`);
  } catch {
    results.push("error");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
console.log(JSON.stringify(results));
