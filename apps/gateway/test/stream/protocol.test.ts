import { expect, test } from "bun:test";
import { parseClientFrame, topicClass } from "../../src/stream/protocol.ts";

test("topicClass names the two delivery contracts and the plugin namespace", () => {
  expect(topicClass("res:usage")).toBe("res");
  expect(topicClass("stream:console")).toBe("stream");
  expect(topicClass("plugin:rc:session")).toBe("plugin");
});

test("a topic with no known prefix names no class", () => {
  // Refused rather than defaulted. A topic that fell through to the
  // invalidation class would be a stream that silently stopped sequencing,
  // which is the failure `gap` exists to make visible.
  expect(topicClass("usage")).toBeNull();
  expect(topicClass("admin:secrets")).toBeNull();
  expect(topicClass("")).toBeNull();
});

test("a prefix with nothing after it is not a topic", () => {
  expect(topicClass("res:")).toBeNull();
  expect(topicClass("stream:")).toBeNull();
  // `plugin:` needs both halves, or a plugin id alone would name a topic.
  expect(topicClass("plugin:rc")).toBeNull();
  expect(topicClass("plugin:rc:")).toBeNull();
  expect(topicClass("plugin::name")).toBeNull();
});

test("subscribe parses with and without a cursor", () => {
  expect(parseClientFrame({ type: "subscribe", topic: "res:usage" })).toEqual({
    type: "subscribe",
    topic: "res:usage",
  });
  expect(
    parseClientFrame({ id: "a1", type: "subscribe", topic: "stream:console", sinceSeq: 12 }),
  ).toEqual({ id: "a1", type: "subscribe", topic: "stream:console", sinceSeq: 12 });
});

test("a non-integer sinceSeq is refused, never coerced", () => {
  // Coercing `"12"` would let a malformed client replay from somewhere it did
  // not ask for, and replaying from the wrong point is indistinguishable at the
  // far end from the gap this protocol promises to report.
  for (const sinceSeq of ["12", 1.5, -1, Number.NaN, null, {}]) {
    expect(parseClientFrame({ type: "subscribe", topic: "stream:console", sinceSeq })).toBeNull();
  }
});

test("unsubscribe and send parse, and send keeps an absent payload absent", () => {
  expect(parseClientFrame({ type: "unsubscribe", topic: "res:logs" })).toEqual({
    type: "unsubscribe",
    topic: "res:logs",
  });
  // `exactOptionalPropertyTypes` is on: an absent payload and an explicit
  // `undefined` are different values, and a plugin reading `"payload" in frame`
  // must see the difference the client sent.
  expect(parseClientFrame({ type: "send", topic: "plugin:rc:session" })).toEqual({
    type: "send",
    topic: "plugin:rc:session",
  });
  expect(parseClientFrame({ type: "send", topic: "plugin:rc:session", payload: null })).toEqual({
    type: "send",
    topic: "plugin:rc:session",
    payload: null,
  });
});

test("anything that is not a frame is refused", () => {
  for (const raw of [null, undefined, 1, "subscribe", [], [{ type: "subscribe" }]]) {
    expect(parseClientFrame(raw)).toBeNull();
  }
});

test("an unknown frame type is refused", () => {
  expect(parseClientFrame({ type: "publish", topic: "res:usage" })).toBeNull();
  expect(parseClientFrame({ topic: "res:usage" })).toBeNull();
});

test("a frame naming an unknown topic class is refused before it reaches the registry", () => {
  expect(parseClientFrame({ type: "subscribe", topic: "credentials" })).toBeNull();
});

test("an over-long topic is refused so the topic index cannot be grown by asking", () => {
  expect(parseClientFrame({ type: "subscribe", topic: `res:${"x".repeat(200)}` })).toBeNull();
});

test("a non-string id is refused", () => {
  expect(parseClientFrame({ id: 7, type: "subscribe", topic: "res:usage" })).toBeNull();
});
