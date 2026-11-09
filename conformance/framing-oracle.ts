import { createServer } from "node:net";
import { nodeHttpClient } from "../packages/providers/src/http-client";

const cases = [
  ["te-cl", "Transfer-Encoding: chunked\r\nContent-Length: 5\r\n"],
  ["duplicate-cl", "Content-Length: 5\r\nContent-Length: 5\r\n"],
  ["plus-cl", "Content-Length: +5\r\n"],
  ["repeated-te", "Transfer-Encoding: chunked\r\nTransfer-Encoding: gzip\r\n"],
  ["duplicate-chunked", "Transfer-Encoding: chunked, chunked\r\n"],
] as const;
for (const [name, headers] of cases) {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\n${headers}\r\nhello`));
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  try {
    await nodeHttpClient()({ provider: "custom", url: `http://127.0.0.1:${address.port}`, method: "POST", headers: [], body: "{}", signal: AbortSignal.timeout(2000) });
    console.log(name, "accepted");
  } catch (error) {
    const code = (error as {code?: string}).code;
    if (!code?.startsWith("HPE_")) throw error;
    console.log(name, code);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
