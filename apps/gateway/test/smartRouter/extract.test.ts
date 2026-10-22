import { expect, test } from "bun:test";
import type { ChatRequest, Message } from "@omni/ir";
import { SEGMENT_CHARS, segments } from "../../src/smartRouter/extract.ts";

const req = (overrides: Partial<ChatRequest>): ChatRequest => ({
  model: "fast",
  stream: false,
  messages: [],
  ...overrides,
});

const containing = (all: string[], marker: string): boolean => all.some((s) => s.includes(marker));

test("system, user, assistant, thinking, tool call arguments and tool results are all judged", () => {
  const out = segments(
    req({
      system: [{ type: "text", text: "MARK-system" }],
      tools: [
        {
          kind: "portable",
          name: "MARK-tool-name",
          description: "MARK-tool-desc",
          inputSchema: {},
        },
        {
          kind: "provider",
          provider: "anthropic",
          type: "bash_20250124",
          name: "MARK-hosted",
          wire: {},
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "MARK-user" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "MARK-thinking" },
            { type: "text", text: "MARK-assistant" },
            { type: "toolUse", id: "t1", name: "Write", input: { content: "MARK-args" } },
          ],
        },
        { role: "system", content: [{ type: "text", text: "MARK-mid-system" }] },
        {
          role: "user",
          content: [{ type: "toolResult", toolUseId: "t1", content: "MARK-result" }],
        },
      ],
    }),
  );
  for (const marker of [
    "MARK-system",
    "MARK-tool-name",
    "MARK-tool-desc",
    "MARK-hosted",
    "MARK-user",
    "MARK-thinking",
    "MARK-assistant",
    "MARK-args",
    "Write",
    "MARK-mid-system",
    "MARK-result",
  ]) {
    expect(containing(out, marker)).toBe(true);
  }
});

test("a tool call with no input is still judged by name and does not throw", () => {
  const out = segments(
    req({
      messages: [
        {
          role: "assistant",
          content: [{ type: "toolUse", id: "t1", name: "MARK-noargs", input: undefined }],
        },
      ],
    }),
  );
  expect(containing(out, "MARK-noargs")).toBe(true);
  expect(containing(out, "undefined")).toBe(false);
});

test("images, files and native blocks are not judged", () => {
  const b64 = "BASE64-MARKER-AAAA";
  const out = segments(
    req({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: b64 },
            { type: "providerNative", provider: "anthropic", blockType: "x", data: { b: b64 } },
            {
              type: "toolResult",
              toolUseId: "t1",
              content: "visible",
              images: [{ type: "image", mediaType: "image/png", data: b64 }],
              files: [{ type: "file", mediaType: "application/pdf", data: b64 }],
              native: [
                { type: "providerNative", provider: "anthropic", blockType: "y", data: { b64 } },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(containing(out, "visible")).toBe(true);
  expect(containing(out, b64)).toBe(false);
});

test("no segment exceeds SEGMENT_CHARS and nothing is cut", () => {
  const text = "abcdefghij".repeat(2_000);
  const out = segments(req({ messages: [{ role: "user", content: [{ type: "text", text }] }] }));
  expect(out.length).toBeGreaterThan(1);
  for (const s of out) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  expect(out.join("")).toBe(`[user]\n${text}`);
});

test("an oversized system prompt and tool list are split, not cut", () => {
  const text = "s".repeat(20_000);
  const out = segments(req({ system: [{ type: "text", text }] }));
  expect(out.length).toBe(3);
  for (const s of out) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  expect(out.join("")).toBe(text);

  const description = "d".repeat(20_000);
  const tools = segments(
    req({ tools: [{ kind: "portable", name: "big", description, inputSchema: {} }] }),
  );
  for (const s of tools) expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
  expect(tools.join("")).toContain(description);
});

test("a slice never splits a surrogate pair", () => {
  const text = "😀".repeat(SEGMENT_CHARS);
  const out = segments(req({ messages: [{ role: "user", content: [{ type: "text", text }] }] }));
  for (const s of out) {
    expect(s.length).toBeLessThanOrEqual(SEGMENT_CHARS);
    expect(s.isWellFormed()).toBe(true);
  }
  expect(out.join("")).toBe(`[user]\n${text}`);
});

const turn = (i: number): Message => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: [
    { type: "text", text: `turn ${i} ${String.fromCharCode(97 + (i % 26)).repeat(3_000)}` },
  ],
});

test("appending a turn leaves every earlier closed segment unchanged", () => {
  const all = Array.from({ length: 12 }, (_, i) => turn(i));
  for (let n = 1; n < all.length; n++) {
    const before = segments(req({ messages: all.slice(0, n) }));
    const after = segments(req({ messages: all.slice(0, n + 1) }));
    const closed = before.slice(0, -1);
    expect(after.slice(0, closed.length)).toEqual(closed);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  }
  expect(segments(req({ messages: all })).length).toBeGreaterThan(3);
});

test("a changed system prompt or tool list does not change message segments", () => {
  const messages = Array.from({ length: 6 }, (_, i) => turn(i));
  const bare = segments(req({ messages }));
  const a = segments(req({ system: [{ type: "text", text: "system A" }], messages }));
  const b = segments(
    req({
      system: [{ type: "text", text: "a rather different system B" }],
      tools: [{ kind: "portable", name: "t", description: "d", inputSchema: {} }],
      messages,
    }),
  );
  expect(a.slice(1)).toEqual(bare);
  expect(b.slice(2)).toEqual(bare);
  expect(a[0]).toBe("system A");
});

test("units that do not fit are packed greedily from the start", () => {
  const small = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] });
  const out = segments(req({ messages: [small("one"), small("two")] }));
  expect(out).toEqual(["[user]\none\n\n[user]\ntwo"]);
});

test("an empty request yields no segments", () => {
  expect(segments(req({}))).toEqual([]);
  expect(
    segments(
      req({
        system: [],
        tools: [],
        messages: [
          { role: "user", content: [] },
          { role: "user", content: [{ type: "text", text: "" }] },
        ],
      }),
    ),
  ).toEqual([]);
});
