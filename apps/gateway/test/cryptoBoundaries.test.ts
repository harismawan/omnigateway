import { expect, test } from "bun:test";
import { verdictKey } from "../src/guardrail/cache.ts";
import { parseResponsesRequest } from "../src/ingress/responses.ts";

test("verdict keys preserve the complete UTF8 JSON tuple and empty members", () => {
  expect(
    verdictKey({
      apiKeyId: "鍵",
      policy: "許可🦊",
      model: "モデル",
      system: "",
      human: ["", "café"],
    }),
  ).toBe("13e280b024e57aeed5ec6cc273f0fbd2ced6a103dee990532eee9ba07fb3f948");
  expect(verdictKey({ apiKeyId: "", policy: "", model: "", system: "", human: [] })).toBe(
    "be4374bb3254c5871b59c635cbd456b58aaaac344d890c01f2d818b362dd7f8b",
  );
});

test("Responses hashes long Unicode call ids to full SHA256 while bypassing 64 UTF16 units", () => {
  for (const [raw, want] of [
    ["会".repeat(64), "会".repeat(64)],
    ["会".repeat(65), "f3d8cc68018e7e0a0aa2c74cfddfc7515e10785943068732c6ed311eb6f074c5"],
    [
      `call_${"会話🦊".repeat(20)}`,
      "aae270c2444f1269e9373da4ae19b7d789ded3081ec9bc86061dd37c23b9e54c",
    ],
  ]) {
    const parsed = parseResponsesRequest({
      model: "pool",
      input: [
        { type: "function_call", call_id: raw, name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: raw, output: "ok" },
      ],
    });
    expect(parsed.messages[0]?.content[0]).toMatchObject({ type: "toolUse", id: want });
    expect(parsed.messages[1]?.content[0]).toMatchObject({ type: "toolResult", toolUseId: want });
  }
});
