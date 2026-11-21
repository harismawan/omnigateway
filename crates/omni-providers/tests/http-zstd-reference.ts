import { createServer } from "node:net";
import { nodeHttpClient } from "../../../packages/providers/src/http-client.ts";

const input = await Bun.stdin.json();
const captured = Promise.withResolvers<Buffer>();
const server = createServer((socket) => {
  let bytes = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    const end = bytes.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = bytes.subarray(0, end).toString();
    const length = /content-length: (\d+)/i.exec(head);
    if (
      length
        ? bytes.length < end + 4 + Number(length[1])
        : !bytes.subarray(end + 4).includes(Buffer.from("0\r\n\r\n"))
    )
      return;
    captured.resolve(bytes);
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("address");
await nodeHttpClient()({
  ...input,
  provider: "openai",
  method: "POST",
  url: `http://127.0.0.1:${address.port}/`,
  bodyEncoding: "zstd",
  signal: new AbortController().signal,
});
console.log(JSON.stringify({ hex: (await captured.promise).toString("hex") }));
server.close();
