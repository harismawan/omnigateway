import { type StopReason, type StreamEvent, usageFromPromptTotal } from "@omni/ir";
import type { CodecDecodeInput } from "../codec.ts";
import { parseSse } from "../sse.ts";

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function count(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}
export async function* decodeQoder({ body, fail }: CodecDecodeInput): AsyncGenerator<StreamEvent> {
  let started = false;
  let done = false;
  let next = 0;
  let open: { kind: "text" | "thinking" | "tool"; index: number } | undefined;
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  let stopReason: StopReason = "endTurn";
  let usage = usageFromPromptTotal(0, 0, 0);
  for await (const frame of parseSse(body)) {
    let data = frame.data;
    if (data === "[DONE]") {
      done = true;
      break;
    }
    if (data === "[NOT_EXCEED_QUOTA]" || data.startsWith("[NOTIFICATIONS]#")) continue;
    if (data === "[EXCEED_QUOTA]") throw fail("RATE_LIMIT", "Qoder quota exceeded");
    let chunk: Record<string, unknown>;
    try {
      chunk = record(JSON.parse(data));
    } catch {
      throw fail("UPSTREAM", "Malformed Qoder stream");
    }
    if (chunk.statusCodeValue !== undefined) {
      if (chunk.statusCodeValue !== 200)
        throw fail(
          chunk.statusCodeValue === 429 ? "RATE_LIMIT" : "UPSTREAM",
          "Qoder stream rejected",
        );
      if (typeof chunk.body !== "string") throw fail("UPSTREAM", "Malformed Qoder envelope");
      data = chunk.body;
      if (data === "[DONE]") {
        done = true;
        break;
      }
      if (data === "[EXCEED_QUOTA]") throw fail("RATE_LIMIT", "Qoder quota exceeded");
      if (data === "[NOT_EXCEED_QUOTA]" || data.startsWith("[NOTIFICATIONS]#")) continue;
      try {
        chunk = record(JSON.parse(data));
      } catch {
        throw fail("UPSTREAM", "Malformed Qoder envelope");
      }
    }
    if (
      "error" in chunk ||
      chunk.success === false ||
      (chunk.code !== undefined &&
        !["0", "200"].includes(String(chunk.code)) &&
        !("choices" in chunk))
    ) {
      throw fail("UPSTREAM", "Qoder business error");
    }
    if (!Array.isArray(chunk.choices) && !chunk.usage)
      throw fail("UPSTREAM", "Unrecognized Qoder stream record");
    if (!started) {
      started = true;
      yield {
        type: "start",
        id: typeof chunk.id === "string" ? chunk.id : "",
        model: typeof chunk.model === "string" ? chunk.model : "",
      };
    }
    if (chunk.usage) {
      const u = record(chunk.usage),
        details = record(u.prompt_tokens_details);
      usage = usageFromPromptTotal(
        count(u.prompt_tokens),
        count(u.completion_tokens),
        count(details.cached_tokens ?? u.prompt_cache_hit_tokens),
        count(
          u.cache_creation_input_tokens ??
            details.cache_creation_tokens ??
            details.cache_write_tokens,
        ),
      );
    }
    const choice = record(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
    const delta = record(choice.delta);
    for (const [field, kind] of [
      ["reasoning_content", "thinking"],
      ["content", "text"],
    ] as const) {
      const text = delta[field];
      if (typeof text !== "string" || !text) continue;
      if (open?.kind !== kind) {
        if (open) yield { type: "blockEnd", index: open.index };
        open = { kind, index: next++ };
        yield {
          type: "blockStart",
          index: open.index,
          block: kind === "thinking" ? { type: "thinking", signed: false } : { type: "text" },
        };
      }
      yield { type: "blockDelta", index: open.index, delta: { type: kind, text } };
    }
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const c = record(raw),
        fn = record(c.function),
        wireIndex = count(c.index);
      let tool = tools.get(wireIndex);
      if (!tool) {
        tool = { id: "", name: "", arguments: "" };
        tools.set(wireIndex, tool);
      }
      if (typeof c.id === "string" && c.id) tool.id = c.id;
      if (typeof fn.name === "string" && fn.name) tool.name += fn.name;
      if (typeof fn.arguments === "string") tool.arguments += fn.arguments;
    }
    if (choice.finish_reason === "tool_calls") stopReason = "toolUse";
    else if (choice.finish_reason === "length") stopReason = "maxTokens";
    else if (choice.finish_reason === "content_filter") stopReason = "contentFilter";
  }
  if (!done) throw fail("UPSTREAM", "Truncated Qoder stream");
  if (!started) throw fail("UPSTREAM", "Empty Qoder stream");
  if (open) yield { type: "blockEnd", index: open.index };
  // Parallel calls interleave on the vendor wire. Buffer their arguments so every
  // IR block is contiguous; Anthropic-shaped clients cannot reopen a closed block.
  for (const tool of tools.values()) {
    if (!tool.id || !tool.name) throw fail("UPSTREAM", "Qoder tool call missing identity");
    const index = next++;
    try {
      JSON.parse(tool.arguments || "{}");
    } catch {
      throw fail("UPSTREAM", "Malformed Qoder tool arguments");
    }
    yield { type: "blockStart", index, block: { type: "toolUse", id: tool.id, name: tool.name } };
    yield {
      type: "blockDelta",
      index,
      delta: { type: "toolJson", partial: tool.arguments || "{}" },
    };
    yield { type: "blockEnd", index };
  }
  yield { type: "end", stopReason, usage };
}
