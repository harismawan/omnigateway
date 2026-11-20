import { toWire } from "../../../packages/providers/src/anthropic/wire.ts";

type Block = Parameters<typeof toWire>[0]["messages"][number]["content"][number];
const blocks: Block[] = [
  {
    type: "text",
    text: "hello",
    citations: [{ url: "x" }],
    cacheControl: { type: "ephemeral", ttl: "1h" },
  },
  { type: "image", mediaType: "image/png", data: "YQ==" },
  { type: "thinking", text: "reason", signature: "signed" },
  { type: "toolUse", id: "t", name: "read_file", input: { a: 1 } },
  {
    type: "providerNative",
    provider: "anthropic",
    blockType: "document",
    data: { source: { type: "text", data: "notes" }, type: "wrong" },
  },
];
for (const files of [
  [],
  [{ mediaType: "text/plain", data: "bm90ZXM=" }],
  [{ mediaType: "application/pdf", data: "YQ==", filename: "a.pdf" }],
  [{ mediaType: "audio/wav", data: "YQ==" }],
])
  for (const images of [[], [{ type: "image", mediaType: "image/png", data: "YQ==" }]])
    blocks.push({
      type: "toolResult",
      toolUseId: "t",
      content: "ok",
      isError: false,
      files,
      images,
      native: [
        {
          type: "providerNative",
          provider: "anthropic",
          blockType: "document",
          data: { source: { type: "text", data: "native" } },
        },
      ],
    });
console.log(
  JSON.stringify(
    blocks.map((block) => {
      const message = toWire(
        { model: "m", stream: true, messages: [{ role: "user", content: [block] }] },
        "m",
        {
          oauth: false,
        },
      ).body.messages[0];
      if (!message || !Array.isArray(message.content)) throw Error("missing wire content");
      return { block, wire: message.content[0] };
    }),
  ),
);
