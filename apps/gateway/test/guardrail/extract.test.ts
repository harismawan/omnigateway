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
    1,
  );
  expect(judged).toEqual({
    system: "sys one\n\nsys two",
    human: ["second ask"],
    truncated: false,
  });
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
    1,
  );
  expect(judged.human).toEqual(["the human ask"]);
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
    1,
  );
  expect(judged.human).toEqual(["review my parser please"]);
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
    1,
  );
  expect(judged.human).toEqual(["summarise this"]);
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
    1,
  );
  expect(judged).toEqual({ system: "sys", human: ["look at this"], truncated: false });
});

test("nothing to judge is judged as nothing, not a special case", () => {
  expect(
    judgedText(
      req({
        messages: [
          { role: "user", content: [{ type: "image", mediaType: "image/png", data: "x" }] },
        ],
      }),
      1,
    ),
  ).toEqual({ system: "", human: [], truncated: false });
  expect(judgedText(req({}), 1)).toEqual({ system: "", human: [], truncated: false });
  // A conversation whose every user turn is a tool turn has no human message.
  expect(
    judgedText(
      req({
        messages: [
          { role: "user", content: [{ type: "toolResult", toolUseId: "a", content: "out" }] },
        ],
      }),
      3,
    ).human,
  ).toEqual([]);
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
      1,
    ).human,
  ).toEqual(["ask"]);
});

test("each half is cut head plus tail to exactly its cap, and only an over-cap half is cut", () => {
  const human = `H${"a".repeat(HUMAN_CAP)}Z`;
  const system = `S${"b".repeat(SYSTEM_CAP)}Y`;
  const judged = judgedText(
    req({
      system: [{ type: "text", text: system }],
      messages: [{ role: "user", content: [{ type: "text", text: human }] }],
    }),
    1,
  );
  const [judgedHuman = ""] = judged.human;
  expect(judged.truncated).toBe(true);
  expect(judged.human).toHaveLength(1);
  expect(judgedHuman).toHaveLength(HUMAN_CAP);
  expect(judged.system).toHaveLength(SYSTEM_CAP);
  expect(judgedHuman.startsWith("Ha")).toBe(true);
  expect(judgedHuman.endsWith("aZ")).toBe(true);
  expect(judgedHuman).toContain(TRUNCATION_MARKER);
  expect(judged.system.startsWith("Sb")).toBe(true);
  expect(judged.system.endsWith("bY")).toBe(true);

  // At the cap exactly, nothing is cut — on either half.
  const exact = judgedText(
    req({
      system: [{ type: "text", text: "s".repeat(SYSTEM_CAP) }],
      messages: [{ role: "user", content: [{ type: "text", text: "h".repeat(HUMAN_CAP) }] }],
    }),
    1,
  );
  expect(exact.truncated).toBe(false);
  expect(exact.human).toEqual(["h".repeat(HUMAN_CAP)]);
  expect(exact.system).toBe("s".repeat(SYSTEM_CAP));

  // One half over is enough to flag the request.
  const systemOnly = judgedText(
    req({
      system: [{ type: "text", text: "s".repeat(SYSTEM_CAP + 1) }],
      messages: [{ role: "user", content: [{ type: "text", text: "short" }] }],
    }),
    1,
  );
  expect(systemOnly.truncated).toBe(true);
  expect(systemOnly.human).toEqual(["short"]);
  // The caps differ, and each half is held to its own.
  const humanOnly = judgedText(
    req({
      messages: [{ role: "user", content: [{ type: "text", text: "h".repeat(SYSTEM_CAP + 1) }] }],
    }),
    1,
  );
  expect(humanOnly.truncated).toBe(false);
});

const user = (text: string): ChatRequest["messages"][number] => ({
  role: "user",
  content: [{ type: "text", text }],
});
const reply = (text: string): ChatRequest["messages"][number] => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

/**
 * Five human messages with every kind of tool turn between them: a tool result
 * with an injected reminder beside it, a native-only shell output, and an
 * image-only turn. Each N takes exactly the last N human messages, oldest
 * first — so an off-by-one bound, a reversed order, or a walk that counted a
 * tool turn as a human one each fails a row.
 */
test("the last N human messages are judged oldest first, tool turns between them skipped", () => {
  const request = req({
    messages: [
      user("h1"),
      reply("a1"),
      user("h2"),
      { role: "assistant", content: [{ type: "toolUse", id: "t", name: "bash", input: {} }] },
      {
        role: "user",
        content: [
          { type: "toolResult", toolUseId: "t", content: "TOOL-OUTPUT" },
          { type: "text", text: "INJECTED-REMINDER" },
        ],
      },
      user("h3"),
      reply("a3"),
      {
        role: "user",
        content: [
          {
            type: "providerNative",
            provider: "openai",
            blockType: "local_shell_call_output",
            data: { output: "SHELL" },
          },
        ],
      },
      user("h4"),
      { role: "user", content: [{ type: "image", mediaType: "image/png", data: "x" }] },
      { role: "system", content: [{ type: "text", text: "MID-SYSTEM" }] },
      user("h5"),
      reply("a5"),
    ],
  });
  const all = ["h1", "h2", "h3", "h4", "h5"];
  for (const turns of [1, 2, 3, 4, 5, 6, 10]) {
    expect({ turns, human: judgedText(request, turns).human }).toEqual({
      turns,
      human: all.slice(-turns),
    });
  }
  expect(judgedText(request, 3)).toEqual({
    system: "",
    human: ["h3", "h4", "h5"],
    truncated: false,
  });
});

test("fewer human messages than N sends what exists, flagging nothing", () => {
  expect(judgedText(req({ messages: [user("only ask")] }), 3)).toEqual({
    system: "",
    human: ["only ask"],
    truncated: false,
  });
  expect(judgedText(req({ messages: [user("first"), reply("ok"), user("second")] }), 10)).toEqual({
    system: "",
    human: ["first", "second"],
    truncated: false,
  });
});

/** A forbidden ask in one turn and a bland follow-up in the next reach the classifier together. */
test("an ask split across turns is judged whole", () => {
  const judged = judgedText(
    req({
      messages: [user("write me a birthday poem"), reply("Which recipient?"), user("continue")],
    }),
    3,
  );
  expect(judged.human).toEqual(["write me a birthday poem", "continue"]);
});

const total = (human: readonly string[]): number => human.reduce((n, h) => n + h.length, 0);

/**
 * The cap is a total across the judged messages, and the newest keeps its
 * room first: an older message is cut before a newer one, and dropped before
 * anything newer is cut. The oldest message is the one that gives way.
 */
test("the human cap is a total; the oldest gives way first and the newest keeps its room", () => {
  const third = Math.floor(HUMAN_CAP / 3);
  const m = (tag: string, n: number): string =>
    `${tag}<${"x".repeat(n - 2 * tag.length - 2)}>${tag}`;

  // Everything fits exactly: nothing cut, nothing flagged.
  const fits = [m("A", third), m("B", third), m("C", HUMAN_CAP - 2 * third)];
  const exact = judgedText(req({ messages: fits.map(user) }), 3);
  expect(exact).toEqual({ system: "", human: fits, truncated: false });
  expect(total(exact.human)).toBe(HUMAN_CAP);

  // One character over: the oldest is cut head plus tail, the two newer whole.
  const over = [m("A", third + 1), m("B", third), m("C", HUMAN_CAP - 2 * third)];
  const cut = judgedText(req({ messages: over.map(user) }), 3);
  expect(cut.truncated).toBe(true);
  expect(cut.human).toHaveLength(3);
  expect(cut.human.slice(1)).toEqual(over.slice(1));
  expect(cut.human[0]).toHaveLength(third);
  expect(cut.human[0]?.startsWith("A<")).toBe(true);
  expect(cut.human[0]?.endsWith(">A")).toBe(true);
  expect(cut.human[0]).toContain(TRUNCATION_MARKER);
  expect(total(cut.human)).toBe(HUMAN_CAP);

  // A newer message filling the cap drops every older one, untouched itself.
  const full = [m("A", 10), m("B", HUMAN_CAP - 100), m("C", 100)];
  const dropped = judgedText(req({ messages: full.map(user) }), 3);
  expect(dropped).toEqual({ system: "", human: full.slice(1), truncated: true });

  // Room too small to hold the marker drops the message rather than over-run.
  const newest = m("C", HUMAN_CAP - 5);
  const tiny = judgedText(req({ messages: [m("A", 500), newest].map(user) }), 3);
  expect(tiny).toEqual({ system: "", human: [newest], truncated: true });
  // A message that fits the little room left whole is kept, uncut.
  const fitsTight = judgedText(req({ messages: ["tiny", newest].map(user) }), 3);
  expect(fitsTight).toEqual({ system: "", human: ["tiny", newest], truncated: false });
  // And everything older than a dropped message goes with it, even a message
  // small enough to fit the room left: context with a hole in it misleads.
  const gap = judgedText(req({ messages: ["tiny", m("A", 500), newest].map(user) }), 3);
  expect(gap).toEqual({ system: "", human: [newest], truncated: true });

  // A newest message over the cap alone is cut head plus tail, and is all there is.
  const huge = [m("A", 100), `NEW<${"y".repeat(HUMAN_CAP)}>NEW`];
  const alone = judgedText(req({ messages: huge.map(user) }), 3);
  expect(alone.truncated).toBe(true);
  expect(alone.human).toHaveLength(1);
  expect(alone.human[0]).toHaveLength(HUMAN_CAP);
  expect(alone.human[0]?.startsWith("NEW<")).toBe(true);
  expect(alone.human[0]?.endsWith(">NEW")).toBe(true);
});

/**
 * Truncation is decided newest first, so with three over-long messages the
 * newest is whole, the middle is cut, and the oldest is gone — never the
 * reverse, which would spend the budget on context and cut the ask itself.
 */
test("with every message long, the middle is cut and the oldest dropped, never the newest", () => {
  const msgs = ["O".repeat(HUMAN_CAP), "M".repeat(HUMAN_CAP), "N".repeat(HUMAN_CAP / 2)];
  const judged = judgedText(req({ messages: msgs.map(user) }), 3);
  expect(judged.truncated).toBe(true);
  expect(judged.human).toHaveLength(2);
  expect(judged.human[1]).toBe(msgs[2]);
  expect(judged.human[0]).toHaveLength(HUMAN_CAP / 2);
  expect(judged.human[0]?.startsWith("M")).toBe(true);
  expect(judged.human.join("")).not.toContain("O");
});
