import { expect, test } from "bun:test";
import { faultResponse } from "./bench-fault";
import { completeBody } from "./bench-integrity";

test("complete text and announced usage are mandatory", () => {
  const m = { provider: "custom-chat", ingress: "chat", mode: "json" } as const;
  const body = (text: string, n: number) =>
    JSON.stringify({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 64, completion_tokens: n },
    });
  expect(() => completeBody(m, body("lorem ipsum ", 2), 2000)).toThrow("aggregate");
  expect(() => completeBody(m, body("lorem ipsum ", 0), 1)).toThrow("usage");
  expect(() => completeBody(m, body("lorem ipsum ", 2), 1)).not.toThrow();
});
test("permanent fault modes produce empty, error and HTTP failure bodies", async () => {
  const previous = process.env.OMNI_BENCH_FAULT;
  try {
    process.env.OMNI_BENCH_FAULT = "empty-after-first";
    expect(faultResponse()).toBeNull();
    expect(await faultResponse()?.text()).toBe("");
    process.env.OMNI_BENCH_FAULT = "error-frame-after-first";
    expect(await faultResponse()?.text()).toContain('"type":"error"');
    process.env.OMNI_BENCH_FAULT = "500-after-first";
    expect(faultResponse()?.status).toBe(500);
  } finally {
    if (previous === undefined) delete process.env.OMNI_BENCH_FAULT;
    else process.env.OMNI_BENCH_FAULT = previous;
  }
});
