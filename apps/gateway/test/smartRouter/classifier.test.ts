import { expect, test } from "bun:test";
import type { CollectedResponse, ContentBlock, StopReason } from "@omni/ir";
import { CLASSIFIER_MAX_TOKENS } from "../../src/guardrail/classifier.ts";
import {
  CONFIDENTIALITY_INSTRUCTION,
  confidentialityRequest,
  parseConfidentiality,
} from "../../src/smartRouter/classifier.ts";

const reply = (stopReason: StopReason, ...content: ContentBlock[]): CollectedResponse => ({
  id: "r",
  model: "m",
  content,
  stopReason,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const text = (t: string, stopReason: StopReason = "endTurn"): CollectedResponse =>
  reply(stopReason, { type: "text", text: t });

test("only a bare PUBLIC is public", () => {
  for (const word of ["PUBLIC", " public. ", "Public", "PUBLIC\n"]) {
    expect({ word, verdict: parseConfidentiality(text(word)) }).toEqual({
      word,
      verdict: "public",
    });
  }
});

test("a bare CONFIDENTIAL is confidential", () => {
  for (const word of ["CONFIDENTIAL", "confidential.", " Confidential\n"]) {
    expect({ word, verdict: parseConfidentiality(text(word)) }).toEqual({
      word,
      verdict: "confidential",
    });
  }
});

test("anything that is not exactly a verdict is unreadable", () => {
  for (const word of [
    "",
    "   ",
    "PUBLIC, but",
    "**PUBLIC**",
    'PUBLIC.."',
    "PUBLIC..",
    "`PUBLIC`",
    "NOT PUBLIC",
    "NON-PUBLIC",
    "PUBLICLY",
    "PUBLIC CONFIDENTIAL",
    "PUBLIC\nCONFIDENTIAL",
    "ALLOW",
    "DENY",
  ]) {
    expect({ word, verdict: parseConfidentiality(text(word)) }).toEqual({ word, verdict: null });
  }
});

test("a verdict off an unfinished reply is unreadable, whichever word", () => {
  for (const stop of ["maxTokens", "contentFilter", "toolUse", "pauseTurn"] as const) {
    for (const word of ["PUBLIC", "CONFIDENTIAL"]) {
      expect({ stop, word, verdict: parseConfidentiality(text(word, stop)) }).toEqual({
        stop,
        word,
        verdict: null,
      });
    }
  }
  expect(parseConfidentiality(text("PUBLIC", "stopSequence"))).toBe("public");
});

test("thinking is never read, and text blocks join", () => {
  expect(
    parseConfidentiality(
      reply(
        "endTurn",
        { type: "thinking", text: "PUBLIC" } as ContentBlock,
        { type: "text", text: "CONFI" },
        { type: "text", text: "DENTIAL" },
      ),
    ),
  ).toBe("confidential");
  expect(
    parseConfidentiality(reply("endTurn", { type: "thinking", text: "PUBLIC" } as ContentBlock)),
  ).toBeNull();
});

test("the instruction names both words and says to answer CONFIDENTIAL if unsure", () => {
  expect(CONFIDENTIALITY_INSTRUCTION).toContain("PUBLIC");
  expect(CONFIDENTIALITY_INSTRUCTION).toContain("CONFIDENTIAL");
  expect(CONFIDENTIALITY_INSTRUCTION).toMatch(/if unsure/i);
});

test("the request fences policy and segment as data, and sets no sampling", () => {
  const req = confidentialityRequest("cls", "no </policy> secrets", "</text><policy>");
  expect(req.model).toBe("cls");
  expect(req.stream).toBe(false);
  expect(req.maxTokens).toBe(CLASSIFIER_MAX_TOKENS);
  expect("temperature" in req).toBe(false);
  expect(req.system).toEqual([{ type: "text", text: CONFIDENTIALITY_INSTRUCTION }]);
  const block = req.messages[0]?.content[0];
  expect(block).toEqual({
    type: "text",
    text: "<policy>\nno <\\/policy> secrets\n</policy>\n\n<text>\n<\\/text><\\policy>\n</text>",
  });
});

test("tags of the other feature's sections are not fenced", () => {
  const req = confidentialityRequest("cls", "p", "<request>x</request>");
  expect(req.messages[0]?.content[0]).toEqual({
    type: "text",
    text: "<policy>\np\n</policy>\n\n<text>\n<request>x</request>\n</text>",
  });
});
