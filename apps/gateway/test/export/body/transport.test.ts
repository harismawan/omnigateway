import { expect, test } from "bun:test";
import { bodyCuts } from "../../../src/export/body/attach.ts";
import { prepare } from "../../../src/export/deliver.ts";
import { buildRecord } from "../../../src/export/record.ts";
import { destination, row, T0 } from "../harness.ts";

test("OTLP body-enabled inline is the complete JSON record; metadata title stays unchanged", () => {
  const p = prepare(
    destination({ type: "otlp", config: { endpoint: "https://collector.test", signal: "logs" } }),
    null,
  );
  if (!p.ok) throw new Error(p.error);
  const record = buildRecord(row("r", T0), { keyLabel: null });
  expect(JSON.parse(p.sender.part(record)).body.stringValue).toBe(`chat ${record.model.requested}`);
  record.body = { state: "included" };
  const part = p.sender.rawPart?.(record, { request: '{"hello":"😀"}', response: "[1,true]" });
  const decoded = JSON.parse(part ?? "");
  expect(JSON.parse(decoded.body.stringValue).body).toEqual({
    state: "included",
    client: { request: { hello: "😀" }, response: [1, true] },
  });
  expect(decoded.attributes).toEqual(JSON.parse(p.sender.part(record)).attributes);
});

test("ES and OTLP body segments use stable IDs/attributes and actual escaping-aware encoded bounds", () => {
  for (const type of ["elasticsearch", "otlp"] as const) {
    const p = prepare(
      destination({
        type,
        config:
          type === "elasticsearch"
            ? { url: "https://es.test", auth: "none" }
            : { endpoint: "https://collector.test", signal: "logs" },
      }),
      null,
    );
    if (!p.ok) throw new Error(p.error);
    const record = buildRecord(row("r", T0), { keyLabel: null });
    const text = '\u0000"\\😀漢'.repeat(1000);
    const cuts = bodyCuts(p.sender, record, "request", text, 1300);
    expect(cuts.join("")).toBe(text);
    expect(bodyCuts(p.sender, record, "request", text, 1300)).toEqual(cuts);
    cuts.forEach((cut, n) => {
      const encoded = p.sender.bodySegment?.(record, "request", cut, n, cuts.length);
      if (!encoded) throw new Error("missing encoder");
      expect(Buffer.byteLength(encoded.sender.body([encoded.part]))).toBeLessThanOrEqual(1300);
      if (type === "elasticsearch") {
        const [action, source] = encoded.part
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(action.index._id).toBe(`r:request:${n}`);
        expect(action.index._index).toBe("omni-bodies-2026.10.25");
        expect(source.text).toBe(cut);
      } else {
        const decoded = JSON.parse(encoded.part);
        expect(decoded.body.stringValue).toBe(cut);
        expect(decoded.attributes[0].value.stringValue).toBe("r");
      }
    });
  }
});
