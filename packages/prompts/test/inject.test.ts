import { expect, test } from "bun:test";
import { type ChatRequest, type ContentBlock, cacheControlOf } from "@omni/ir";
import { PONYTAIL_MARKER } from "@omni/ponytail";
import {
  builtinPrompts,
  injectPrompts,
  type PromptsReport,
  promptNotes,
  type ResolvedPrompt,
} from "../src/index.ts";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function request(system?: ContentBlock[]): ChatRequest {
  return freeze({
    model: "fast",
    stream: false,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...(system === undefined ? {} : { system }),
  });
}
const prompt = (id: string, text = `${id} rules`): ResolvedPrompt => ({ id, text, version: 3 });
const inject = (req: ChatRequest, prompts: ResolvedPrompt[]) => injectPrompts(req, freeze(prompts));
const text = (block: ContentBlock | undefined) => (block?.type === "text" ? block.text : "");
const marker = (block: ContentBlock | undefined) =>
  block === undefined ? undefined : cacheControlOf(block);

test("empty retains identity and has no notes", () => {
  const req = request();
  const result = inject(req, []);
  expect(result.request).toBe(req);
  expect(result.report).toEqual({
    applied: [],
    skipped: [],
    cacheMarkerMoved: false,
    cacheMarkerNotLast: false,
  });
  expect(promptNotes(result.report)).toEqual([]);
});

test("joins survivors into one block and leaves frozen input unchanged", () => {
  const req = request([{ type: "text", text: "client rules" }]);
  const result = inject(req, [prompt("a"), prompt("b")]);
  expect(result.request).not.toBe(req);
  expect(result.request.system).toHaveLength(2);
  expect(result.request.system?.[0]).toBe(req.system?.[0]);
  expect(text(result.request.system?.[1])).toBe("a rules\n\nb rules");
  expect(result.request.messages).toBe(req.messages);
  expect(req.system).toHaveLength(1);
  expect(result.report.applied).toEqual([
    { id: "a", version: 3 },
    { id: "b", version: 3 },
  ]);
  expect(marker(result.request.system?.[1])).toBeUndefined();
});

test("dedupes marker in system blocks and system turns but not user or assistant turns", () => {
  const builtins = [...builtinPrompts()].slice(0, 1);
  for (const role of ["system", "user", "assistant"] as const) {
    const req = freeze<ChatRequest>({
      model: "fast",
      stream: false,
      messages: [{ role, content: [{ type: "text", text: `prefix ${PONYTAIL_MARKER}` }] }],
    });
    const result = inject(req, builtins);
    expect(result.report.applied.length).toBe(role === "system" ? 0 : 1);
    if (role === "system") expect(result.request).toBe(req);
  }
  expect(
    inject(request([{ type: "text", text: PONYTAIL_MARKER }]), builtins).report.skipped,
  ).toEqual([{ id: "ponytail-lite", reason: "already-present" }]);
});

test("full-text dedupe checks system turns, substrings, and repeated injection", () => {
  const req = freeze<ChatRequest>({
    model: "fast",
    stream: false,
    messages: [
      { role: "system", content: [{ type: "text", text: "prefix a rules suffix" }] },
      { role: "user", content: [{ type: "text", text: "b rules" }] },
    ],
  });
  const prompts = [prompt("a", "  a rules  "), prompt("b")];
  const first = inject(req, prompts);
  expect(first.report.skipped).toEqual([{ id: "a", reason: "already-present" }]);
  expect(first.report.applied).toEqual([{ id: "b", version: 3 }]);
  const second = inject(freeze(first.request), prompts);
  expect(second.request).toBe(first.request);
  expect(second.report.applied).toEqual([]);
  expect(second.report.skipped).toHaveLength(2);
});

test("leading whitespace retained and identical custom survivor text deduped", () => {
  const result = inject(request(), [prompt("a", "  indent\n rule"), prompt("b", "indent\n rule")]);
  expect(text(result.request.system?.[0])).toBe("  indent\n rule");
  expect(result.report.applied).toEqual([{ id: "a", version: 3 }]);
  expect(result.report.skipped).toEqual([{ id: "b", reason: "already-present" }]);
});

test("copies of built-in text do not inherit marker dedupe semantics", () => {
  const builtin = builtinPrompts()[0];
  if (!builtin) throw new Error("missing fixture");
  const result = inject(request([{ type: "text", text: PONYTAIL_MARKER }]), [
    prompt("copy", builtin.text),
  ]);
  expect(result.report.applied).toEqual([{ id: "copy", version: 3 }]);
});

test("budget includes separators and is applied after dedupe", () => {
  expect(16_000 + 2 + 15_998).toBe(32_000);
  const result = inject(request([{ type: "text", text: "existing" }]), [
    prompt("present", "existing"),
    prompt("a", "a".repeat(16_000)),
    prompt("b", "b".repeat(15_998)),
    prompt("c", "c"),
  ]);
  expect(result.report.applied.map((p) => p.id)).toEqual(["a", "b"]);
  expect(result.report.skipped).toEqual([
    { id: "present", reason: "already-present" },
    { id: "c", reason: "over-budget" },
  ]);
  expect(text(result.request.system?.[1])).toHaveLength(32_000);
  const boundary = inject(request(), [
    prompt("a", "a".repeat(16_000)),
    prompt("b", "b".repeat(15_998)),
    prompt("c"),
  ]);
  expect(boundary.report.applied.map((p) => p.id)).toEqual(["a", "b"]);
  expect(boundary.report.skipped).toEqual([{ id: "c", reason: "over-budget" }]);
});

test("overflowing middle survivor drops later small survivor too", () => {
  const result = inject(request(), [
    prompt("a", "a".repeat(16_000)),
    prompt("b", "b".repeat(16_000)),
    prompt("c", "c"),
  ]);
  expect(result.report.applied.map((p) => p.id)).toEqual(["a"]);
  expect(result.report.skipped).toEqual([
    { id: "b", reason: "over-budget" },
    { id: "c", reason: "over-budget" },
  ]);
});

test("only final cache marker moves with identical TTL and count", () => {
  for (const ttl of ["5m", "1h"] as const) {
    const req = request([
      { type: "text", text: "earlier", cacheControl: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: "last", cacheControl: { type: "ephemeral", ttl } },
    ]);
    const result = inject(req, [prompt("a"), prompt("b")]);
    expect(marker(result.request.system?.[0])).toBe(marker(req.system?.[0]));
    expect(marker(result.request.system?.[1])).toBeUndefined();
    expect(marker(result.request.system?.[2])).toBe(marker(req.system?.[1]));
    expect(result.request.system?.filter((b) => cacheControlOf(b) !== undefined)).toHaveLength(2);
    expect(result.report.cacheMarkerMoved).toBe(true);
    expect(result.report.cacheMarkerNotLast).toBe(false);
    expect(promptNotes(result.report)).toEqual(["prompt:cache-marker-moved"]);
  }
});

test("earlier marker stays without manufacturing a marker", () => {
  const req = request([
    { type: "text", text: "earlier", cacheControl: { type: "ephemeral", ttl: "1h" } },
    { type: "text", text: "last" },
  ]);
  const result = inject(req, [prompt("a")]);
  expect(result.request.system?.[0]).toBe(req.system?.[0]);
  expect(marker(result.request.system?.[2])).toBeUndefined();
  expect(result.report.cacheMarkerMoved).toBe(false);
  expect(promptNotes(result.report)).toEqual(["prompt:cache-marker-not-last"]);
});

test("no survivor means no marker move for dedupe or budget drops", () => {
  const req = request([{ type: "text", text: "a rules", cacheControl: { type: "ephemeral" } }]);
  for (const prompts of [[prompt("a")], [prompt("huge", "x".repeat(32_001))]]) {
    const result = inject(req, prompts);
    expect(result.request).toBe(req);
    expect(result.report.cacheMarkerMoved).toBe(false);
    expect(result.report.cacheMarkerNotLast).toBe(false);
  }
});

test("notes cannot quote IDs or text, only exact built-ins emit legacy notes", () => {
  const report: PromptsReport = freeze({
    applied: [
      { id: "ponytail-secret", version: "private" },
      { id: "ponytail-full", version: "v4.9.0" },
    ],
    skipped: [
      { id: "secret", reason: "already-present" },
      { id: "ponytail-lite", reason: "already-present" },
      { id: "private", reason: "over-budget" },
      { id: "also-private", reason: "over-budget" },
    ],
    cacheMarkerMoved: true,
    cacheMarkerNotLast: false,
  });
  expect([...promptNotes(report)].sort()).toEqual([
    "ponytail:already-present",
    "ponytail:full",
    "prompt:already-present",
    "prompt:cache-marker-moved",
    "prompt:over-budget",
  ]);
});
