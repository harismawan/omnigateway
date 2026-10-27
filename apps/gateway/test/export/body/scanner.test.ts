import { expect, spyOn, test } from "bun:test";
import { extractClient } from "../../../src/export/body/scanner.ts";

const signal = () => new AbortController().signal;

test("extracts only client raw JSON without parsing a tree", () => {
  const request = '{"a":[1,true,"}\\""]}';
  const text = `{"attempts":[{"client":{"request":"private"}}],"clie\\u006et":{"request":${request},"response":null,"truncated":false}}`;
  const parse = spyOn(JSON, "parse").mockImplementation(() => {
    throw new Error("tree parse");
  });
  try {
    expect(extractClient(text, signal())).toEqual({ request, response: "null" });
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test("large fields and 100,000-deep skipped values are stack safe", () => {
  const request = JSON.stringify('😀\\"\u0000'.repeat(100_000));
  const deep = `${"[".repeat(100_000)}0${"]".repeat(100_000)}`;
  expect(
    extractClient(
      `{"attempts":${deep},"client":{"request":${request},"response":false}}`,
      signal(),
    ),
  ).toEqual({ request, response: "false" });
});

test("rejects malformed JSON and duplicate sensitive fields; honours cancellation", () => {
  for (const text of [
    '{"client":{"request":01}}',
    '{"client":{"request":[1,]}}',
    '{"client":{"request":"\\x"}}',
    '{"client":{},"client":{}}',
    '{"client":{"request":1,"request":2}}',
    "{} trailing",
  ]) {
    expect(() => extractClient(text, signal())).toThrow();
  }
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  expect(() => extractClient("{}", controller.signal)).toThrow("cancelled");
});
