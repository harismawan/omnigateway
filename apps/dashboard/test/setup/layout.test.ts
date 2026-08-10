import { describe, expect, test } from "bun:test";

describe("dashboard test layout", () => {
  test("keeps responsive components in their unmeasured sentinel state", () => {
    const element = document.createElement("div");

    expect(element.getBoundingClientRect().width).toBe(-1);
    expect(element.getBoundingClientRect().height).toBe(-1);
  });

  test("does not schedule resize callbacks outside React act boundaries", async () => {
    let calls = 0;
    const observer = new ResizeObserver(() => {
      calls += 1;
    });

    observer.observe(document.createElement("div"));
    await Promise.resolve();

    expect(calls).toBe(0);
  });
});
