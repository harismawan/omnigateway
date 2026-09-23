import { expect, test } from "bun:test";
import type { ContentBlock } from "@omni/ir";
import { toAnthropicWire as toWire } from "@omni/providers";
import { parseAnthropicRequest } from "../../src/ingress/anthropic.ts";
import { parseOpenAIRequest } from "../../src/ingress/openai.ts";
import { parseResponsesRequest } from "../../src/ingress/responses.ts";

/**
 * An image returned by a tool is read as an image on every surface, never
 * serialised into the result's text. Claude Code reads an image-only PDF as one
 * PNG per page, and flattening those into text sent a request of over a million
 * tokens where the images cost a few thousand.
 */

const DATA = "iVBORw0KGgo".padEnd(4096, "A");
const IMAGE = { type: "image" as const, mediaType: "image/png", data: DATA };

function result(blocks: ContentBlock[] | undefined): ContentBlock | undefined {
  return blocks?.find((b) => b.type === "toolResult");
}

test("anthropic: tool_result image parts become images, text stays text", () => {
  const req = parseAnthropicRequest({
    model: "claude-opus-4",
    max_tokens: 64,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: [
              { type: "text", text: "page 1" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: DATA } },
            ],
          },
        ],
      },
    ],
  });
  expect(result(req.messages[1]?.content)).toEqual({
    type: "toolResult",
    toolUseId: "t",
    content: "page 1",
    images: [IMAGE],
    isError: false,
  });
});

test("anthropic: the image round-trips to the Anthropic wire as an image block", () => {
  // The exact shape Claude Code sends for a `Read` of a PNG.
  const req = parseAnthropicRequest({
    model: "claude-opus-4",
    max_tokens: 64,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: DATA } },
            ],
          },
        ],
      },
    ],
  });
  const wire = JSON.stringify(toWire(req, "claude-opus-4", { oauth: false }).body);
  expect(wire).toContain(`"content":[{"type":"image","source":{"type":"base64"`);
  expect(wire).not.toContain('\\"type\\":\\"image\\"');
});

test("openai: a tool message's image part is kept, not emptied", () => {
  const req = parseOpenAIRequest({
    model: "gpt-5",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c",
        content: [
          { type: "text", text: "page 1" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${DATA}` } },
        ],
      },
    ],
  });
  expect(result(req.messages[1]?.content)).toMatchObject({ content: "page 1", images: [IMAGE] });
});

test("responses: function_call_output content parts keep their image", () => {
  const req = parseResponsesRequest({
    model: "gpt-5",
    input: [
      { type: "function_call", call_id: "c", name: "Read", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c",
        output: [
          { type: "input_text", text: "page 1" },
          { type: "input_image", image_url: `data:image/png;base64,${DATA}` },
        ],
      },
    ],
  });
  const blocks = req.messages.flatMap((m) => m.content);
  expect(result(blocks)).toMatchObject({ content: "page 1", images: [IMAGE] });
});

test("openai: a remote image in a tool message is dropped, not refused", () => {
  // Array content here was read as "" before; a 400 would fail requests that
  // used to succeed. The Responses surface drops a remote image the same way.
  const req = parseOpenAIRequest({
    model: "gpt-5",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "Read", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c",
        content: [
          { type: "text", text: "page 1" },
          { type: "image_url", image_url: { url: "https://example.com/p1.png" } },
        ],
      },
    ],
  });
  expect(result(req.messages[1]?.content)).toEqual({
    type: "toolResult",
    toolUseId: "c",
    content: "page 1",
    isError: false,
  });
});

test("anthropic: a tool_result PDF document becomes a portable file, same wire back", () => {
  // The same amplification as an image: a base64 PDF flattened into the text
  // is billed as prose. It is a plain file, so any provider may take it, and
  // Anthropic receives exactly the document the client sent.
  const pdf = "JVBERi0x".padEnd(4096, "A");
  const req = parseAnthropicRequest({
    model: "claude-opus-4",
    max_tokens: 64,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t",
            content: [
              { type: "text", text: "the pdf" },
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: pdf },
              },
            ],
          },
        ],
      },
    ],
  });
  expect(result(req.messages[1]?.content)).toEqual({
    type: "toolResult",
    toolUseId: "t",
    content: "the pdf",
    files: [{ type: "file", mediaType: "application/pdf", data: pdf }],
    isError: false,
  });
  const wire = toWire(req, "claude-opus-4", { oauth: false }).body.messages[1] as {
    content: { content: unknown }[];
  };
  expect(wire.content[0]?.content).toEqual([
    { type: "text", text: "the pdf" },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
  ]);
});

test("anthropic: a malformed document part still flattens rather than failing", () => {
  const req = parseAnthropicRequest({
    model: "claude-opus-4",
    max_tokens: 64,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t", content: [{ type: "document", bogus: 1 }] },
        ],
      },
    ],
  });
  expect(result(req.messages[1]?.content)).toEqual({
    type: "toolResult",
    toolUseId: "t",
    content: '{"type":"document","bogus":1}',
    isError: false,
  });
});

test("responses: an input_file in a function_call_output stays a file, not text", () => {
  const pdf = "JVBERi0x".padEnd(4096, "C");
  const outputs = [`data:application/pdf;base64,${pdf}`, pdf];
  for (const file_data of outputs) {
    const req = parseResponsesRequest({
      model: "gpt-5",
      input: [
        { type: "function_call", call_id: "c", name: "read", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "c",
          output: [
            { type: "input_text", text: "the pdf" },
            { type: "input_file", filename: "r.pdf", file_data },
          ],
        },
      ],
    });
    expect(result(req.messages[1]?.content)).toEqual({
      type: "toolResult",
      toolUseId: "c",
      content: "the pdf",
      files: [{ type: "file", mediaType: "application/pdf", data: pdf, filename: "r.pdf" }],
      isError: false,
    });
  }
});

test("responses: a file_id reference stays a short text reference", () => {
  const req = parseResponsesRequest({
    model: "gpt-5",
    input: [
      { type: "function_call", call_id: "c", name: "read", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "c",
        output: [{ type: "input_file", file_id: "file-abc" }],
      },
    ],
  });
  expect(result(req.messages[1]?.content)).toEqual({
    type: "toolResult",
    toolUseId: "c",
    content: '{"type":"input_file","file_id":"file-abc"}',
    isError: false,
  });
});

function docResult(document: Record<string, unknown>) {
  const req = parseAnthropicRequest({
    model: "claude-opus-4",
    max_tokens: 64,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: [document] }],
      },
    ],
  });
  return result(req.messages[1]?.content) as {
    content: string;
    files?: unknown[];
    native?: unknown[];
  };
}

test("anthropic: a text document becomes the result's text, and its title a filename", () => {
  expect(
    docResult({ type: "document", source: { type: "text", media_type: "text/plain", data: "hi" } }),
  ).toMatchObject({ content: "hi" });
  expect(
    docResult({
      type: "document",
      title: "daily report",
      source: { type: "text", media_type: "text/plain", data: "hi" },
    }),
  ).toMatchObject({ content: "daily report\nhi" });
  const titled = docResult({
    type: "document",
    title: "r.pdf",
    source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" },
  });
  expect(titled.files).toEqual([
    { type: "file", mediaType: "application/pdf", data: "JVBERi0x", filename: "r.pdf" },
  ]);
});

test("anthropic: a document only Anthropic can honour stays native", () => {
  const pdf = { type: "base64", media_type: "application/pdf", data: "JVBERi0x" };
  for (const document of [
    { type: "document", source: pdf, citations: { enabled: true } },
    { type: "document", source: pdf, context: "from the wiki" },
    { type: "document", source: pdf, cache_control: { type: "ephemeral" } },
    { type: "document", source: { type: "url", url: "https://x/y.pdf" } },
    { type: "document", source: { type: "file", file_id: "file_1" } },
    { type: "document", source: { type: "content", content: [{ type: "text", text: "hi" }] } },
  ]) {
    const r = docResult(document);
    expect(`${JSON.stringify(document)}:${r.native?.length ?? 0}:${r.files?.length ?? 0}`).toBe(
      `${JSON.stringify(document)}:1:0`,
    );
  }
});
