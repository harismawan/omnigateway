import { expect, test } from "bun:test";
import {
  applyAnthropicSystem,
  BODY_ORDER,
  computeCch,
  orderFields,
  signAnthropicBody,
} from "../src/body.ts";

test("orderFields emits listed keys first, in order", () => {
  const out = orderFields({ stream: true, model: "m", messages: [] }, [
    "model",
    "messages",
    "stream",
  ]);
  expect(Object.keys(out)).toEqual(["model", "messages", "stream"]);
});

test("orderFields appends unlisted keys in their original order", () => {
  const out = orderFields({ z: 1, model: "m", a: 2 }, ["model"]);
  expect(Object.keys(out)).toEqual(["model", "z", "a"]);
});

test("orderFields skips keys that are absent", () => {
  const out = orderFields({ model: "m" }, ["model", "temperature", "stream"]);
  expect(Object.keys(out)).toEqual(["model"]);
});

test("no body order contains an integer-like key", () => {
  // V8 hoists integer-like keys to the front of an object regardless of
  // insertion order, which would silently defeat orderFields.
  for (const order of Object.values(BODY_ORDER)) {
    for (const key of order) expect(String(Number(key))).not.toBe(key);
  }
});

test("computeCch returns five lowercase hex digits", () => {
  const token = computeCch('{"model":"claude-opus-4","messages":[]}');
  expect(token).toMatch(/^[0-9a-f]{5}$/);
});

test("computeCch is deterministic and input-sensitive", () => {
  const a = computeCch('{"model":"a"}');
  const b = computeCch('{"model":"a"}');
  const c = computeCch('{"model":"b"}');
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});

test("signAnthropicBody preserves the byte length", () => {
  const json = JSON.stringify({
    model: "claude-opus-4",
    system: [{ type: "text", text: "x-anthropic-billing-header: cch=00000;" }],
  });
  const signed = signAnthropicBody(json);
  expect(Buffer.byteLength(signed, "utf8")).toBe(Buffer.byteLength(json, "utf8"));
});

test("signAnthropicBody substitutes the placeholder with a real token", () => {
  const json = JSON.stringify({
    system: [{ type: "text", text: "cc_version=2.1.219.250; cc_entrypoint=cli; cch=00000;" }],
  });
  const signed = signAnthropicBody(json);
  expect(signed).not.toContain("cch=00000");
  expect(signed).toMatch(/cch=[0-9a-f]{5};/);
});

test("signAnthropicBody is a no-op when there is no placeholder", () => {
  const json = '{"model":"m"}';
  expect(signAnthropicBody(json)).toBe(json);
});

test("applyAnthropicSystem puts the billing block first", () => {
  const blocks = applyAnthropicSystem([{ type: "text", text: "Do the thing." }]);
  expect(blocks[0]?.text).toContain("x-anthropic-billing-header:");
  expect(blocks[0]?.text).toContain("cch=00000;");
  expect(blocks[1]?.text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  expect(blocks[2]?.text).toBe("Do the thing.");
});

test("applyAnthropicSystem handles an empty system", () => {
  const blocks = applyAnthropicSystem([]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.text).toContain("cch=00000;");
});

test("applyAnthropicSystem drops paragraphs naming other agents", () => {
  const blocks = applyAnthropicSystem([
    {
      type: "text",
      text: ["Keep this.", "See https://o‍pencode.ai/docs for help.", "Keep this too."].join("\n\n"),
    },
  ]);
  const joined = blocks.map((b) => b.text).join("\n");
  expect(joined).toContain("Keep this.");
  expect(joined).toContain("Keep this too.");
  expect(joined).not.toContain("o‍pencode.ai/docs");
});

test("applyAnthropicSystem rewrites the known phrases", () => {
  const blocks = applyAnthropicSystem([
    {
      type: "text",
      text: "Answer if O‍penCode honestly cannot.\n\nHere is some useful information about the environment you are running in:",
    },
  ]);
  const joined = blocks.map((b) => b.text).join("\n");
  expect(joined).toContain("if the assistant honestly");
  expect(joined).toContain("Environment context you are running in:");
  expect(joined).not.toContain("O‍penCode honestly");
});

test("applyAnthropicSystem is idempotent", () => {
  const once = applyAnthropicSystem([{ type: "text", text: "Do the thing." }]);
  const twice = applyAnthropicSystem(once);
  expect(twice.filter((b) => b.text.includes("x-anthropic-billing-header:"))).toHaveLength(1);
  expect(twice.filter((b) => b.text.startsWith("You are a Claude agent"))).toHaveLength(1);
  expect(twice.map((b) => b.text)).toEqual(once.map((b) => b.text));
});
