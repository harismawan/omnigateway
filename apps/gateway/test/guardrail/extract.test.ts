import { expect, test } from "bun:test";
import type { ChatRequest } from "@omni/ir";
import {
  HUMAN_CAP,
  judgedText,
  SYSTEM_CAP,
  TRUNCATION_MARKER,
} from "../../src/guardrail/extract.ts";

const req = (overrides: Partial<ChatRequest>): ChatRequest => ({
  model: "fast",
  stream: false,
  messages: [],
  ...overrides,
});

test("the system text and the last human message are judged, nothing older", () => {
  const judged = judgedText(
    req({
      system: [
        { type: "text", text: "sys one" },
        { type: "text", text: "sys two" },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "first ask" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "second ask" }] },
        { role: "assistant", content: [{ type: "text", text: "later answer" }] },
      ],
    }),
  );
  expect(judged).toEqual({ system: "sys one\n\nsys two", human: "second ask", truncated: false });
});

/**
 * A user turn that carries any tool result is a tool turn, even when the client
 * put text beside it, and the walk goes past it to the turn a human wrote. A
 * walk that stopped at the first user turn, or skipped only tool-result-only
 * turns, judges the injected text instead.
 */
test("a user turn carrying any tool result is skipped whole, text beside it included", () => {
  const judged = judgedText(
    req({
      messages: [
        { role: "user", content: [{ type: "text", text: "the human ask" }] },
        { role: "assistant", content: [{ type: "toolUse", id: "a", name: "bash", input: {} }] },
        {
          role: "user",
          content: [
            { type: "toolResult", toolUseId: "a", content: "tool output" },
            { type: "text", text: "injected reminder" },
          ],
        },
        { role: "assistant", content: [{ type: "toolUse", id: "b", name: "bash", input: {} }] },
        {
          role: "user",
          content: [
            { type: "text", text: "reminder first" },
            { type: "toolResult", toolUseId: "b", content: "more output" },
          ],
        },
      ],
    }),
  );
  expect(judged.human).toBe("the human ask");
});

/**
 * Tool output that is not a `toolResult` — a Responses `local_shell_call_output`
 * arrives as a user turn holding one native block — is a tool turn too. A walk
 * that stopped there judged an empty string on every Codex shell turn. A user
 * turn holding no text block at all says nothing a human wrote, so the walk
 * goes past it, an image-only turn included.
 */
test("a user turn holding no text block is skipped, so native tool output is never judged", () => {
  const judged = judgedText(
    req({
      messages: [
        { role: "user", content: [{ type: "text", text: "review my parser please" }] },
        {
          role: "assistant",
          content: [
            { type: "providerNative", provider: "openai", blockType: "local_shell_call", data: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "providerNative",
              provider: "openai",
              blockType: "local_shell_call_output",
              data: { output: "SHELL-OUTPUT" },
            },
          ],
        },
        { role: "user", content: [{ type: "image", mediaType: "image/png", data: "x" }] },
      ],
    }),
  );
  expect(judged.human).toBe("review my parser please");
});

/**
 * A native block beside text a human wrote does not make the turn a tool turn:
 * "summarise this" with a cited document attached is the human's own ask, and
 * skipping it would judge an older, already-allowed message in its place.
 */
test("a user turn with text beside a native block is judged on its text", () => {
  const judged = judgedText(
    req({
      messages: [
        { role: "user", content: [{ type: "text", text: "an older ask" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        {
          role: "user",
          content: [
            {
              type: "providerNative",
              provider: "anthropic",
              blockType: "document",
              data: { citations: { enabled: true } },
            },
            { type: "text", text: "summarise this" },
          ],
        },
      ],
    }),
  );
  expect(judged.human).toBe("summarise this");
});

test("images, files, thinking and native blocks are never judged, only text blocks", () => {
  const judged = judgedText(
    req({
      system: [
        { type: "text", text: "sys" },
        { type: "image", mediaType: "image/png", data: "SYSIMG" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", data: "IMGDATA" },
            { type: "text", text: "look at this" },
            { type: "thinking", text: "THOUGHT" },
            {
              type: "providerNative",
              provider: "anthropic",
              blockType: "x",
              data: { v: "NATIVE" },
            },
          ],
        },
      ],
    }),
  );
  expect(judged).toEqual({ system: "sys", human: "look at this", truncated: false });
});

test("nothing to judge is judged as empty strings, not a special case", () => {
  expect(
    judgedText(
      req({
        messages: [
          { role: "user", content: [{ type: "image", mediaType: "image/png", data: "x" }] },
        ],
      }),
    ),
  ).toEqual({ system: "", human: "", truncated: false });
  expect(judgedText(req({}))).toEqual({ system: "", human: "", truncated: false });
  // A conversation whose every user turn is a tool turn has no human message.
  expect(
    judgedText(
      req({
        messages: [
          { role: "user", content: [{ type: "toolResult", toolUseId: "a", content: "out" }] },
        ],
      }),
    ).human,
  ).toBe("");
});

test("the last human message is found past assistant and system turns", () => {
  expect(
    judgedText(
      req({
        messages: [
          { role: "user", content: [{ type: "text", text: "ask" }] },
          { role: "system", content: [{ type: "text", text: "mid system" }] },
          { role: "assistant", content: [{ type: "text", text: "reply" }] },
        ],
      }),
    ).human,
  ).toBe("ask");
});

test("each half is cut head plus tail to exactly its cap, and only an over-cap half is cut", () => {
  const human = `H${"a".repeat(HUMAN_CAP)}Z`;
  const system = `S${"b".repeat(SYSTEM_CAP)}Y`;
  const judged = judgedText(
    req({
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: [{ type: "text", text: human }] }],
    }),
  );
  expect(judged.truncated).toBe(true);
  expect(judged.human).toHaveLength(HUMAN_CAP);
  expect(judged.system).toHaveLength(SYSTEM_CAP);
  expect(judged.human.startsWith("Ha")).toBe(true);
  expect(judged.human.endsWith("aZ")).toBe(true);
  expect(judged.human).toContain(TRUNCATION_MARKER);
  expect(judged.system.startsWith("Sb")).toBe(true);
  expect(judged.system.endsWith("bY")).toBe(true);

  // At the cap exactly, nothing is cut — on either half.
  const exact = judgedText(
    req({
      system: [{ type: "text", text: "s".repeat(SYSTEM_CAP) }],
      messages: [{ role: "user", content: [{ type: "text", text: "h".repeat(HUMAN_CAP) }] }],
    }),
  );
  expect(exact.truncated).toBe(false);
  expect(exact.human).toBe("h".repeat(HUMAN_CAP));
  expect(exact.system).toBe("s".repeat(SYSTEM_CAP));

  // One half over is enough to flag the request.
  const systemOnly = judgedText(
    req({
      system: [{ type: "text", text: "s".repeat(SYSTEM_CAP + 1) }],
      messages: [{ role: "user", content: [{ type: "text", text: "short" }] }],
    }),
  );
  expect(systemOnly.truncated).toBe(true);
  expect(systemOnly.human).toBe("short");
  // The caps differ, and each half is held to its own.
  const humanOnly = judgedText(
    req({
      messages: [{ role: "user", content: [{ type: "text", text: "h".repeat(SYSTEM_CAP + 1) }] }],
    }),
  );
  expect(humanOnly.truncated).toBe(false);
});
