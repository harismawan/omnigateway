import { expect, test } from "bun:test";
import { segments } from "../../../src/export/body/segment.ts";

test("stable code-point segments fit actual escaped envelopes and count digit changes", () => {
  for (const text of ['\u0000"\\😀漢'.repeat(200), "x".repeat(1100), ""]) {
    const envelope = (seg: string, n: number, of: number) =>
      Buffer.byteLength(JSON.stringify({ n, of, text: seg }));
    const split = segments(text, 51, envelope);
    expect(split.join("")).toBe(text);
    expect(segments(text, 51, envelope)).toEqual(split);
    split.forEach((seg, i) => {
      expect(envelope(seg, i, split.length)).toBeLessThanOrEqual(51);
      expect(seg.endsWith("\ud83d")).toBe(false);
    });
  }
});

test("refuses a cap too small for even one code point", () => {
  expect(() => segments("😀", 3, (s) => Buffer.byteLength(s))).toThrow();
});
