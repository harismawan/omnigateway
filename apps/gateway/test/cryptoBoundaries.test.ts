import { expect, test } from "bun:test";
import { verdictKey } from "../src/guardrail/cache.ts";
import { parseResponsesRequest } from "../src/ingress/responses.ts";
import { segmentKey } from "../src/smartRouter/cache.ts";

test("verdict keys preserve the complete UTF8 JSON tuple and empty members", () => {
  expect(
    verdictKey({
      apiKeyId: "鍵",
      policy: "許可🦊",
      model: "モデル",
      system: "",
      human: ["", "café"],
      toolResults: ["", "結果🦊"],
    }),
  ).toBe("a8e0847d2c2475bad31cfdaab1010710179d314fb571865156d1cdac76c0d57d");
  expect(
    verdictKey({ apiKeyId: "", policy: "", model: "", system: "", human: [], toolResults: [] }),
  ).toBe("4ad9f43325e69195ee5aabdea79bdcbfa54b3a77e3a116d6a36e5561e6ce370d");
});

test("segment keys preserve the complete UTF8 JSON tuple and empty members", () => {
  expect(segmentKey("モデル", "許可🦊", "秘密 café")).toBe(
    "536ed8fffeeeebcac957349d228bdedd9b73f924d443715bdc92cb40edb9c89d",
  );
  expect(segmentKey("", "", "")).toBe(
    "799c55d702efedb7750db18b36386fc3a3f4be7dddcfb649adeb41a3ed0da228",
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
