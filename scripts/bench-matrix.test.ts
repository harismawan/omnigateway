import { expect, test } from "bun:test";
import { matches, matrixScenarios, responseVerdict } from "./bench-matrix";

test("matrix has distinct scenarios and selects globs literally", () => {
  const cases = matrixScenarios();
  expect(cases).toHaveLength(32);
  expect(new Set(cases.map((c) => c.name)).size).toBe(32);
  expect(cases.filter((c) => matches(c.name, "*.responses.*"))).toHaveLength(8);
  expect(matches("custom-chat.chat.json", "custom-*")).toBe(true);
  expect(matches("custom-chatXchatXjson", "custom-chat.chat.json")).toBe(false);
});

test("errors and successful lies cannot become supported measurements", () => {
  const meta = { provider: "custom-chat", ingress: "chat", mode: "json" } as const;
  expect(responseVerdict(meta, 500, "application/json", "upstream failure").classification).toBe(
    "failed",
  );
  expect(
    responseVerdict(meta, 404, "application/json", '{"error":{"code":"model_not_found"}}')
      .classification,
  ).toBe("unsupported");
  expect(
    responseVerdict(meta, 200, "application/json", '{"error":"lorem ipsum"}').classification,
  ).toBe("failed");
  expect(
    responseVerdict(meta, 200, "text/plain", '{"choices":[{"message":{"content":"lorem ipsum"}}]}')
      .classification,
  ).toBe("failed");
  expect(
    responseVerdict(
      meta,
      200,
      "application/json",
      '{"choices":[{"message":{"content":"lorem ipsum"}}]}',
    ).classification,
  ).toBe("supported");
});

test("stream must finish and cannot contain a late error", () => {
  const meta = { provider: "custom-chat", ingress: "chat", mode: "stream" } as const;
  const delta = 'data: {"choices":[{"delta":{"content":"lorem ipsum"}}]}\n\n';
  expect(responseVerdict(meta, 200, "text/event-stream", delta).classification).toBe("failed");
  expect(
    responseVerdict(meta, 200, "text/event-stream", `${delta}data: [DONE]\n\n`).classification,
  ).toBe("supported");
  expect(
    responseVerdict(
      meta,
      200,
      "text/event-stream",
      `${delta}data: {"error":"broken"}\n\ndata: [DONE]\n\n`,
    ).classification,
  ).toBe("failed");
});
