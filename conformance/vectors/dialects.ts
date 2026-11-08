#!/usr/bin/env bun
/**
 * Vectors for the three client dialects: ingress parsing and egress rendering.
 *
 *   TZ=UTC bun conformance/vectors/dialects.ts > conformance/vectors/dialects.json
 *
 * Written to its own file rather than appended to `vectors.json`, so that file
 * keeps its bytes. Every output is produced by calling the real TS function —
 * `parseAnthropicRequest`, `parseOpenAIRequest`, `parseResponsesRequest`,
 * `customToolNames`, `normalizeClientModel`, the three stream generators, the
 * buffered renderers, the error bodies and the rate-limit header renderers —
 * never by restating an algorithm here.
 *
 * Determinism. `validateRequest` mints `tu_${crypto.randomUUID()}` for a tool
 * call sent with an empty id; `crypto.randomUUID` is replaced below by a
 * counter reset before every case, so the minted ids are pinned rather than
 * masked. The renderers take their ids and clock as arguments, so those are
 * pinned by construction. Nothing in this file is masked.
 */
import { CONTEXT_1M_BETA, collect, GatewayError, HTTP_STATUS } from "../../packages/ir/src/index.ts";
import type { ErrorCode, StreamEvent } from "../../packages/ir/src/index.ts";
import {
  anthropicErrorBody,
  anthropicRateLimitHeaders,
  anthropicResponse,
  anthropicStream,
} from "../../apps/gateway/src/egress/anthropic.ts";
import {
  openaiErrorBody,
  openaiRateLimitHeaders,
  openaiResponse,
  openaiStream,
} from "../../apps/gateway/src/egress/openai.ts";
import {
  responsesErrorBody,
  responsesRateLimitHeaders,
  responsesResponse,
  responsesStream,
} from "../../apps/gateway/src/egress/responses.ts";
import { parseAnthropicRequest } from "../../apps/gateway/src/ingress/anthropic.ts";
import { normalizeClientModel } from "../../apps/gateway/src/ingress/model.ts";
import { parseOpenAIRequest } from "../../apps/gateway/src/ingress/openai.ts";
import { customToolNames, parseResponsesRequest } from "../../apps/gateway/src/ingress/responses.ts";

let uuidCounter = 0;
(globalThis.crypto as { randomUUID: () => string }).randomUUID = () =>
  `00000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;

type Case = { name: string; body: string; headers?: [string, string][] };

/** A body as the route hands it over: `request.json()` of these exact bytes. */
const j = (value: unknown): string => JSON.stringify(value);

function run(parse: (body: unknown, headers?: Headers) => unknown, cases: Case[]): unknown[] {
  const names = new Set<string>();
  return cases.map((c) => {
    if (names.has(c.name)) throw new Error(`duplicate case ${c.name}`);
    names.add(c.name);
    uuidCounter = 0;
    const body: unknown = JSON.parse(c.body);
    const headers = c.headers === undefined ? undefined : new Headers(c.headers);
    try {
      const ir = parse(body, headers);
      return { ...c, ok: JSON.parse(JSON.stringify(ir)) };
    } catch (error) {
      if (!(error instanceof GatewayError)) {
        throw new Error(`case ${c.name} threw a non-gateway error: ${String(error)}`);
      }
      return {
        ...c,
        error: { code: error.code, status: HTTP_STATUS[error.code], message: error.message },
      };
    }
  });
}

/** Values whose acceptance by a field exercises every zod type arm. */
const WRONG: unknown[] = [null, 0, 1, -1, 1.5, 2 ** 60, -(2 ** 60), "", "s", true, [], ["a"], [1], {}, { type: "x" }];

function mutate(base: Record<string, unknown>, field: string, values = WRONG): Case[] {
  return values.map((v, i) => ({ name: `mut.${field}.${i}`, body: j({ ...base, [field]: v }) }));
}

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: unknown) => ({ role: "assistant", content });
const PNG = "iVBORw0KGgoAAAANSUhEUg";

// ---------------------------------------------------------------- anthropic

const aBase = { model: "claude-sonnet-4-5", max_tokens: 1024, messages: [user("hi")] };
const aMsg = (...messages: unknown[]) => j({ ...aBase, messages });
const aBlocks = (role: string, ...content: unknown[]) => aMsg(...(role === "assistant" ? [user("q")] : []), { role, content }, ...(role === "system" ? [assistant("a")] : []));

const anthropicCases: Case[] = [
  { name: "minimal", body: j(aBase) },
  { name: "array.body", body: "[]" },
  { name: "string.body", body: '"x"' },
  { name: "number.body", body: "5" },
  { name: "null.body", body: "null" },
  { name: "empty.object", body: "{}" },
  { name: "no.model", body: j({ messages: [user("hi")] }) },
  { name: "model.empty", body: j({ ...aBase, model: "" }) },
  { name: "model.200", body: j({ ...aBase, model: "m".repeat(200) }) },
  { name: "model.201", body: j({ ...aBase, model: "m".repeat(201) }) },
  { name: "model.astral.200", body: j({ ...aBase, model: "😀".repeat(200) }) },
  { name: "model.astral.201", body: j({ ...aBase, model: "😀".repeat(201) }) },
  { name: "model.1m", body: j({ ...aBase, model: "claude-sonnet-4-5[1m]" }) },
  { name: "model.1M.spaces", body: j({ ...aBase, model: "  claude-sonnet-4-5 [1M] " }) },
  { name: "model.only.suffix", body: j({ ...aBase, model: "[1m]" }) },
  { name: "model.1m.with.beta", body: j({ ...aBase, model: "x[1m]" }), headers: [["anthropic-beta", `${CONTEXT_1M_BETA}, other`]] },
  { name: "messages.empty", body: j({ ...aBase, messages: [] }) },
  { name: "messages.missing", body: j({ model: "m" }) },
  { name: "messages.object", body: j({ ...aBase, messages: {} }) },
  { name: "message.role.bad", body: aMsg({ role: "tool", content: "x" }) },
  { name: "message.content.number", body: aMsg({ role: "user", content: 5 }) },
  { name: "message.content.missing", body: aMsg({ role: "user" }) },
  { name: "message.not.object", body: aMsg("hi") },
  { name: "message.extra.fields", body: aMsg({ role: "user", content: "x", name: "bob" }) },
  { name: "max_tokens.absent", body: j({ model: "m", messages: [user("x")] }) },
  ...mutate(aBase, "max_tokens"),
  ...mutate(aBase, "temperature"),
  ...mutate(aBase, "stream"),
  ...mutate(aBase, "stop_sequences"),
  ...mutate(aBase, "system"),
  ...mutate(aBase, "tool_choice"),
  ...mutate(aBase, "thinking"),
  ...mutate(aBase, "metadata"),
  ...mutate(aBase, "tools"),
  ...mutate(aBase, "model"),
  ...mutate(aBase, "messages"),
  { name: "stream.true", body: j({ ...aBase, stream: true }) },
  { name: "temperature.zero", body: j({ ...aBase, temperature: 0 }) },
  { name: "stop.sequences", body: j({ ...aBase, stop_sequences: ["\n\nHuman:", "END"] }) },
  { name: "stop.sequences.bad.item", body: j({ ...aBase, stop_sequences: ["a", 1] }) },
  { name: "system.string", body: j({ ...aBase, system: "be brief" }) },
  { name: "system.string.empty", body: j({ ...aBase, system: "" }) },
  { name: "system.blocks", body: j({ ...aBase, system: [{ type: "text", text: "a" }, { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } }] }) },
  { name: "system.block.bad.cache", body: j({ ...aBase, system: [{ type: "text", text: "a", cache_control: { type: "persistent" } }] }) },
  { name: "system.block.bad.ttl", body: j({ ...aBase, system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "2h" } }] }) },
  { name: "system.block.cache.extra", body: j({ ...aBase, system: [{ type: "text", text: "a", cache_control: { type: "ephemeral", x: 1 } }] }) },
  { name: "system.block.image", body: j({ ...aBase, system: [{ type: "image", text: "a" }] }) },
  { name: "system.block.citations", body: j({ ...aBase, system: [{ type: "text", text: "a", citations: [{ x: 1 }] }] }) },
  { name: "tool_choice.auto", body: j({ ...aBase, tool_choice: { type: "auto" } }) },
  { name: "tool_choice.any", body: j({ ...aBase, tool_choice: { type: "any", disable_parallel_tool_use: true } }) },
  { name: "tool_choice.none", body: j({ ...aBase, tool_choice: { type: "none" } }) },
  { name: "tool_choice.tool", body: j({ ...aBase, tool_choice: { type: "tool", name: "get_weather" } }) },
  { name: "tool_choice.tool.noname", body: j({ ...aBase, tool_choice: { type: "tool" } }) },
  { name: "tool_choice.tool.badname", body: j({ ...aBase, tool_choice: { type: "tool", name: 5 } }) },
  { name: "tool_choice.auto.extra.name", body: j({ ...aBase, tool_choice: { type: "auto", name: 5 } }) },
  { name: "thinking.adaptive", body: j({ ...aBase, thinking: { type: "adaptive" } }) },
  { name: "thinking.adaptive.display", body: j({ ...aBase, thinking: { type: "adaptive", display: "omitted" } }) },
  { name: "thinking.adaptive.display.bad", body: j({ ...aBase, thinking: { type: "adaptive", display: "full" } }) },
  { name: "thinking.adaptive.effort", body: j({ ...aBase, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } }) },
  { name: "thinking.adaptive.effort.unknown", body: j({ ...aBase, thinking: { type: "adaptive" }, output_config: { effort: "ultra" } }) },
  { name: "effort.alone", body: j({ ...aBase, output_config: { effort: "xhigh" } }) },
  { name: "effort.max", body: j({ ...aBase, output_config: { effort: "max", format: { type: "json_schema", schema: {} } } }) },
  { name: "output_config.string", body: j({ ...aBase, output_config: "high" }) },
  { name: "thinking.enabled", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 2048 } }) },
  { name: "thinking.enabled.zero", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 0 } }) },
  { name: "thinking.enabled.frac", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 1.5 } }) },
  { name: "thinking.enabled.huge", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 2 ** 60 } }) },
  { name: "thinking.enabled.max_safe", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 9007199254740991 } }) },
  { name: "thinking.enabled.max_safe.plus.one", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 9007199254740992 } }) },
  { name: "thinking.enabled.neg.max_safe", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: -9007199254740991 } }) },
  { name: "thinking.enabled.neg.beyond", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: -9007199254740993 } }) },
  { name: "max_tokens.max_safe", body: j({ ...aBase, max_tokens: 9007199254740991 }) },
  { name: "max_tokens.beyond.safe", body: j({ ...aBase, max_tokens: 9007199254740992 }) },
  { name: "max_tokens.exponent", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":1e3}' },
  { name: "max_tokens.fraction.zero", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":5.0}' },
  { name: "tools.web_search.max_uses.max_safe", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 9007199254740991 }] }) },
  { name: "tools.web_search.max_uses.beyond", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 9007199254740992 }] }) },
  { name: "tools.computer.display_number.neg.beyond", body: j({ ...aBase, tools: [{ type: "computer_20250124", name: "computer", display_width_px: 1, display_height_px: 1, display_number: -9007199254740992 }] }) },
  { name: "thinking.enabled.missing", body: j({ ...aBase, thinking: { type: "enabled" } }) },
  { name: "thinking.enabled.effort.ignored", body: j({ ...aBase, thinking: { type: "enabled", budget_tokens: 5 }, output_config: { effort: "low" } }) },
  { name: "thinking.disabled", body: j({ ...aBase, thinking: { type: "disabled" } }) },
  { name: "thinking.between_tools", body: j({ ...aBase, thinking: { type: "between_tools" } }) },
  { name: "thinking.extras", body: j({ ...aBase, thinking: { type: "adaptive", future: 1, display: "updates" } }) },
  { name: "thinking.unknown.type", body: j({ ...aBase, thinking: { type: "auto" } }) },
  { name: "metadata.user_id", body: j({ ...aBase, metadata: { user_id: '{"session_id":"abc"}' } }) },
  { name: "metadata.user_id.empty", body: j({ ...aBase, metadata: { user_id: "" } }), headers: [["x-session-id", "hdr"]] },
  { name: "metadata.user_id.null", body: j({ ...aBase, metadata: { user_id: null } }) },
  { name: "metadata.null", body: j({ ...aBase, metadata: null }) },
  { name: "metadata.user_id.512", body: j({ ...aBase, metadata: { user_id: "u".repeat(512) } }) },
  { name: "metadata.user_id.513", body: j({ ...aBase, metadata: { user_id: "u".repeat(513) } }) },
  { name: "metadata.user_id.number", body: j({ ...aBase, metadata: { user_id: 5 } }) },
  { name: "metadata.extra", body: j({ ...aBase, metadata: { user_id: "x", tier: 1 } }) },
  { name: "header.session", body: j(aBase), headers: [["X-Session-Id", "  sess-1  "]] },
  { name: "header.session.affinity", body: j(aBase), headers: [["x-session-affinity", "aff"], ["session-id", "bare"]] },
  { name: "header.session.precedence", body: j(aBase), headers: [["session-id", "bare"], ["x-deepseek-harness-session-id", "dsh"]] },
  { name: "header.session.blank", body: j(aBase), headers: [["x-session-id", "   "], ["session-id", "fallback"]] },
  { name: "header.session.long", body: j(aBase), headers: [["x-session-id", "s".repeat(513)], ["session-id", "fallback"]] },
  { name: "header.session.512", body: j(aBase), headers: [["x-session-id", "s".repeat(512)]] },
  { name: "header.betas", body: j(aBase), headers: [["anthropic-beta", " a , b,,a , "], ["Anthropic-Beta", "c"], ["anthropic-version", "2023-06-01"], ["x-other", "1"], ["anthropic-dangerous-direct-browser-access", "true"]] },
  { name: "header.beta.empty", body: j(aBase), headers: [["anthropic-beta", " , "]] },
  { name: "vendor.extras", body: j({ ...aBase, top_k: 5, top_p: 0.9, service_tier: "auto", container: null, context_management: { edits: [] } }) },
  { name: "vendor.extras.numeric.keys", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"zeta":1,"10":2,"2":3,"alpha":4}' },
  { name: "vendor.proto.key", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"__proto__":{"x":1}}' },
  { name: "safeguards.system.raw", body: j({ ...aBase, safeguards: [{ id: 1 }], system: [{ type: "text", text: "attr", extra: "kept" }] }) },
  { name: "safeguards.empty", body: j({ ...aBase, safeguards: [], system: "s" }) },
  { name: "safeguards.no.system", body: j({ ...aBase, safeguards: [1] }) },
  // content blocks
  { name: "block.text", body: aBlocks("user", { type: "text", text: "a" }, { type: "text", text: "b", cache_control: { type: "ephemeral" } }) },
  { name: "block.text.citations", body: aBlocks("user", { type: "text", text: "a", citations: [{ type: "char_location" }] }) },
  { name: "block.text.citations.null", body: aBlocks("user", { type: "text", text: "a", citations: null }) },
  { name: "block.text.missing.text", body: aBlocks("user", { type: "text" }) },
  { name: "block.text.text.number", body: aBlocks("user", { type: "text", text: 5 }) },
  { name: "block.text.bad.cache", body: aBlocks("user", { type: "text", text: "a", cache_control: { type: "nope" } }) },
  { name: "block.unknown.type", body: aBlocks("user", { type: "video", url: "x" }) },
  { name: "block.unknown.type.unprintable", body: aBlocks("user", { type: "has space" }) },
  { name: "block.no.type", body: aBlocks("user", { text: "a" }) },
  { name: "block.type.number", body: aBlocks("user", { type: 5 }) },
  { name: "block.string", body: aBlocks("user", "plain") },
  { name: "block.null", body: aBlocks("user", null) },
  { name: "block.array", body: aBlocks("user", []) },
  { name: "block.image", body: aBlocks("user", { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }) },
  { name: "block.image.cache", body: aBlocks("user", { type: "image", source: { type: "base64", media_type: "image/png", data: PNG }, cache_control: { type: "ephemeral", ttl: "5m" } }) },
  { name: "block.image.url", body: aBlocks("user", { type: "image", source: { type: "url", url: "https://x" } }) },
  { name: "block.image.no.source", body: aBlocks("user", { type: "image" }) },
  { name: "block.image.missing.data", body: aBlocks("user", { type: "image", source: { type: "base64", media_type: "image/png" } }) },
  { name: "block.thinking", body: aBlocks("assistant", { type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "a" }) },
  { name: "block.thinking.unsigned", body: aBlocks("assistant", { type: "thinking", thinking: "hmm" }) },
  { name: "block.thinking.bad", body: aBlocks("assistant", { type: "thinking" }) },
  { name: "block.redacted_thinking", body: aBlocks("assistant", { type: "redacted_thinking", data: "opaque" }) },
  { name: "block.redacted_thinking.user", body: aBlocks("user", { type: "redacted_thinking", data: "opaque" }) },
  { name: "block.redacted_thinking.extra", body: aBlocks("assistant", { type: "redacted_thinking", data: "opaque", zz: 1 }) },
  { name: "block.redacted_thinking.extra.unprintable", body: aBlocks("assistant", { type: "redacted_thinking", data: "opaque", "z z": 1 }) },
  { name: "block.redacted_thinking.bad.data.and.extra", body: aBlocks("assistant", { zz: 1, type: "redacted_thinking", data: 5 }) },
  { name: "block.document.bad.source.and.extra", body: aBlocks("user", { extra: 1, type: "document", source: { type: "url" } }) },
  { name: "tools.custom.null.cache.and.bad", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, cache_control: null, strict: 5 }] }) },
  { name: "block.redacted_thinking.no.data", body: aBlocks("assistant", { type: "redacted_thinking" }) },
  { name: "block.tool_use", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "tu1", name: "f", input: { b: 1, a: [2] } }]), user([{ type: "tool_result", tool_use_id: "tu1", content: "ok" }])) },
  { name: "block.tool_use.no.input", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "tu1", name: "f" }])) },
  { name: "block.tool_use.input.array", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "tu1", name: "f", input: [1] }])) },
  { name: "block.tool_use.input.numeric.keys", body: '{"model":"m","messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"f","input":{"z":1,"3":2,"__proto__":5,"a":{"__proto__":1}}}]}]}' },
  { name: "block.tool_use.empty.id", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "", name: "f", input: {} }, { type: "tool_use", id: "", name: "g", input: {} }]), user([{ type: "tool_result", tool_use_id: "", content: "orphan?" }])) },
  { name: "block.tool_use.cache", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "t", name: "f", input: {}, cache_control: { type: "ephemeral" } }])) },
  { name: "block.tool_use.no.name", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "t" }])) },
  { name: "block.tool_result.orphan", body: aMsg(user([{ type: "tool_result", tool_use_id: "nope", content: "x" }, { type: "text", text: "after" }])) },
  { name: "block.tool_result.orphan.only", body: aMsg(user([{ type: "tool_result", tool_use_id: "nope", content: "x" }])) },
  {
    name: "block.tool_result.blocks",
    body: aMsg(
      user("q"),
      assistant([{ type: "tool_use", id: "t", name: "f", input: {} }]),
      user([
        {
          type: "tool_result",
          tool_use_id: "t",
          is_error: true,
          cache_control: { type: "ephemeral" },
          content: [
            "bare string",
            { type: "text", text: "t1" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/" }, cache_control: { type: "ephemeral" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi" }, title: "doc.pdf" },
            { type: "document", source: { data: "plain", media_type: "text/plain", type: "text" }, title: "Notes" },
            { type: "document", source: { type: "text", media_type: "text/plain", data: "untitled" } },
            { type: "document", source: { type: "url", url: "https://x/y.pdf" } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi" }, citations: { enabled: true } },
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi" }, cache_control: { type: "ephemeral", ttl: "1h" } },
            { type: "document", source: { type: "content", content: [{ type: "text", text: "c" }] }, context: "ctx" },
            { type: "document", source: { type: "file", file_id: "file_1" } },
            { type: "document", source: { type: "base64", media_type: "image/png", data: "x" } },
            { type: "search_result", source: "https://s", title: "T", content: [{ type: "text", text: "r" }], citations: { enabled: false } },
            { type: "search_result", source: "https://s", title: "T", content: [], extra: 1 },
            { type: "text", text: 5 },
            { type: "image", source: { type: "url", url: "x" } },
            42,
            null,
            [1, 2],
            { no: "type" },
          ],
        },
      ]),
    ),
  },
  { name: "block.tool_result.content.object", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "t", name: "f", input: {} }]), user([{ type: "tool_result", tool_use_id: "t", content: { a: 1 } }])) },
  { name: "block.tool_result.no.content", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "t", name: "f", input: {} }]), user([{ type: "tool_result", tool_use_id: "t" }])) },
  { name: "block.tool_result.is_error.string", body: aMsg(user("q"), assistant([{ type: "tool_use", id: "t", name: "f", input: {} }]), user([{ type: "tool_result", tool_use_id: "t", is_error: "yes" }])) },
  { name: "block.server_tool_use", body: aBlocks("assistant", { type: "server_tool_use", id: "srv", name: "web_search", input: { query: "q" }, caller: { type: "direct" } }, { type: "web_search_tool_result", tool_use_id: "srv", content: [{ type: "web_search_result", url: "u" }], cache_control: { type: "ephemeral" } }) },
  { name: "block.server_tool_use.order", body: '{"model":"m","messages":[{"role":"user","content":"q"},{"role":"assistant","content":[{"input":{"q":1},"name":"web_fetch","id":"s","type":"server_tool_use","cache_control":null}]}]}' },
  { name: "block.server_tool_use.bad.name", body: aBlocks("assistant", { type: "server_tool_use", id: "srv", name: "my_tool", input: {} }) },
  { name: "block.server_tool_use.no.input", body: aBlocks("assistant", { type: "server_tool_use", id: "srv", name: "advisor" }) },
  { name: "block.server_tool_use.caller.code", body: aBlocks("assistant", { type: "server_tool_use", id: "srv", name: "code_execution", input: {}, caller: { type: "code_execution_20250825", tool_id: "c" } }) },
  { name: "block.server_tool_use.caller.bad", body: aBlocks("assistant", { type: "server_tool_use", id: "srv", name: "code_execution", input: {}, caller: { type: "other" } }) },
  { name: "block.server_tool_use.caller.extra", body: aBlocks("assistant", { type: "server_tool_use", id: "srv", name: "code_execution", input: {}, caller: { type: "direct", x: 1 } }) },
  { name: "block.web_search_result.null.content", body: aBlocks("assistant", { type: "web_search_tool_result", tool_use_id: "s", content: null }) },
  { name: "block.web_search_result.no.content", body: aBlocks("assistant", { type: "web_search_tool_result", tool_use_id: "s" }) },
  { name: "block.web_fetch.result", body: aBlocks("assistant", { type: "web_fetch_tool_result", tool_use_id: "s", content: { type: "web_fetch_result" }, caller: { type: "direct" } }) },
  { name: "block.code_exec.result.caller", body: aBlocks("assistant", { type: "code_execution_tool_result", tool_use_id: "s", content: {}, caller: { type: "direct" } }) },
  { name: "block.bash.result", body: aBlocks("assistant", { type: "bash_code_execution_tool_result", tool_use_id: "s", content: {} }) },
  { name: "block.text_editor.result", body: aBlocks("assistant", { type: "text_editor_code_execution_tool_result", tool_use_id: "s", content: "x" }) },
  { name: "block.tool_search.result", body: aBlocks("assistant", { type: "tool_search_tool_result", tool_use_id: "s", content: [] }) },
  { name: "block.advisor.result", body: aBlocks("assistant", { type: "advisor_tool_result", tool_use_id: "s", content: 0 }) },
  { name: "block.advisor_result.illegal", body: aBlocks("assistant", { type: "advisor_result" }) },
  { name: "block.tool_reference.illegal", body: aBlocks("user", { type: "tool_reference", name: "x" }) },
  { name: "block.mcp_tool_use", body: aBlocks("assistant", { type: "mcp_tool_use", id: "m", name: "n", server_name: "s", input: { a: 1 } }) },
  { name: "block.mcp_tool_use.user", body: aBlocks("user", { type: "mcp_tool_use", id: "m", name: "n", server_name: "s", input: {} }) },
  { name: "block.mcp_tool_result", body: aBlocks("user", { type: "mcp_tool_result", tool_use_id: "m", content: [{ type: "text", text: "r" }], is_error: false }) },
  { name: "block.mcp_tool_result.bad.content", body: aBlocks("user", { type: "mcp_tool_result", tool_use_id: "m", content: 5 }) },
  { name: "block.container_upload", body: aBlocks("user", { type: "container_upload", file_id: "f", cache_control: { type: "ephemeral", ttl: "1h" } }) },
  { name: "block.container_upload.bad.cache", body: aBlocks("user", { type: "container_upload", file_id: "f", cache_control: { type: "x" } }) },
  { name: "block.compaction", body: aBlocks("assistant", { type: "compaction", content: null, encrypted_content: "enc" }) },
  { name: "block.compaction.missing", body: aBlocks("assistant", { type: "compaction" }) },
  { name: "block.search_result", body: aBlocks("user", { type: "search_result", source: "s", title: "t", content: [], citations: {} }) },
  { name: "block.search_result.citations.extra", body: aBlocks("user", { type: "search_result", source: "s", title: "t", content: [], citations: { enabled: true, x: 1 } }) },
  { name: "block.document", body: aBlocks("user", { type: "document", source: { type: "url", url: "https://d" }, title: null, context: null, citations: null }) },
  { name: "block.document.text.source", body: aBlocks("user", { type: "document", source: { type: "text", media_type: "text/plain", data: "d" } }) },
  { name: "block.document.bad.source", body: aBlocks("user", { type: "document", source: { type: "base64", media_type: "image/png", data: "d" } }) },
  { name: "block.document.source.extra", body: aBlocks("user", { type: "document", source: { type: "url", url: "u", extra: 1 } }) },
  { name: "block.document.source.unknown", body: aBlocks("user", { type: "document", source: { type: "s3" } }) },
  { name: "block.document.assistant", body: aBlocks("assistant", { type: "document", source: { type: "url", url: "u" } }) },
  { name: "block.fallback", body: aBlocks("assistant", { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { reason: "x" } }) },
  { name: "block.fallback.bad", body: aBlocks("assistant", { type: "fallback", from: { model: "a", x: 1 }, to: { model: "b" } }) },
  { name: "system.message", body: aMsg(user("q"), { role: "system", content: "mid" }, assistant("a")) },
  { name: "system.message.last", body: aMsg(user("q"), { role: "system", content: [{ type: "mid_conv_system", content: [{ type: "text", text: "x", cache_control: null, citations: null }, { type: "tool_addition", tool: { type: "tool_reference", name: "t" } }, { type: "tool_removal", tool: { type: "mcp_toolset_reference", server_name: "s" }, cache_control: { type: "ephemeral" } }] }] }) },
  { name: "system.message.first", body: aMsg({ role: "system", content: "x" }, user("q")) },
  { name: "system.message.before.user", body: aMsg(user("q"), { role: "system", content: "x" }, user("q2")) },
  { name: "mid_conv_system.bad.item", body: aMsg(user("q"), { role: "system", content: [{ type: "mid_conv_system", content: [{ type: "image" }] }] }) },
  { name: "mid_conv_system.text.extra", body: aMsg(user("q"), { role: "system", content: [{ type: "mid_conv_system", content: [{ type: "text", text: "x", y: 1 }] }] }) },
  { name: "mid_conv_system.tool.bad", body: aMsg(user("q"), { role: "system", content: [{ type: "tool_addition", tool: { type: "mcp_tool_reference", server_name: "s" } }] }) },
  { name: "mid_conv_system.in.user", body: aBlocks("user", { type: "mid_conv_system", content: [] }) },
  { name: "messages.merge.same.role", body: aMsg(user("a"), user([{ type: "text", text: "b" }]), assistant("c"), assistant("d")) },
  { name: "messages.empty.content", body: aMsg(user([]), user("x")) },
  { name: "block.error.second.message", body: aMsg(user("a"), assistant([{ type: "text" }])) },
  // tools
  { name: "tools.empty", body: j({ ...aBase, tools: [] }) },
  { name: "tools.custom", body: j({ ...aBase, tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: { "2": {}, b: {} } } }] }) },
  { name: "tools.custom.typed", body: j({ ...aBase, tools: [{ type: "custom", name: "f", input_schema: {}, cache_control: { type: "ephemeral", ttl: "1h" } }] }) },
  { name: "tools.custom.null.type", body: j({ ...aBase, tools: [{ type: null, name: "f", input_schema: {}, cache_control: null }] }) },
  { name: "tools.custom.options", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, strict: true, defer_loading: null, allowed_callers: ["direct", "code_execution_20250825"], input_examples: [{ a: 1 }], eager_input_streaming: false }] }) },
  { name: "tools.custom.bad.caller", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, allowed_callers: ["me"] }] }) },
  { name: "tools.custom.bad.examples", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, input_examples: [1] }] }) },
  { name: "tools.custom.unsupported", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, max_uses: 1 }] }) },
  { name: "tools.custom.unsupported.unprintable", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, "bad key": 1 }] }) },
  { name: "tools.custom.numeric.key.first", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"tools":[{"name":"f","input_schema":{},"zzz":1,"7":2}]}' },
  { name: "tools.custom.no.name", body: j({ ...aBase, tools: [{ input_schema: {} }] }) },
  { name: "tools.custom.empty.name", body: j({ ...aBase, tools: [{ name: "", input_schema: {} }] }) },
  { name: "tools.custom.no.schema", body: j({ ...aBase, tools: [{ name: "f" }] }) },
  { name: "tools.custom.schema.array", body: j({ ...aBase, tools: [{ name: "f", input_schema: [] }] }) },
  { name: "tools.custom.bad.desc", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, description: 5 }] }) },
  { name: "tools.custom.bad.cache", body: j({ ...aBase, tools: [{ name: "f", input_schema: {}, cache_control: { type: "x" } }] }) },
  { name: "tools.custom.schema.proto", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"tools":[{"name":"f","input_schema":{"__proto__":{"a":1},"type":"object"}}]}' },
  { name: "tools.entry.string", body: j({ ...aBase, tools: ["f"] }) },
  { name: "tools.entry.array", body: j({ ...aBase, tools: [[]] }) },
  { name: "tools.entry.null", body: j({ ...aBase, tools: [null] }) },
  { name: "tools.type.number", body: j({ ...aBase, tools: [{ type: 5, name: "x" }] }) },
  { name: "tools.type.unknown", body: j({ ...aBase, tools: [{ type: "web_search_20990101", name: "web_search" }] }) },
  { name: "tools.type.proto", body: j({ ...aBase, tools: [{ type: "constructor" }] }) },
  { name: "tools.web_search", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5, allowed_domains: ["a.com"], user_location: { type: "approximate", city: "SF", extra: 1 }, cache_control: { type: "ephemeral" }, strict: null }] }) },
  { name: "output_config.array", body: j({ ...aBase, output_config: ["high"] }) },
  { name: "thinking.array", body: j({ ...aBase, thinking: [] }) },
  { name: "tools.web_search.both.domains", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: [], blocked_domains: [] }] }) },
  { name: "tools.web_search.null.domains", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["a"], blocked_domains: null }] }) },
  { name: "tools.web_search.wrong.name", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "search" }] }) },
  { name: "tools.web_search.no.name", body: j({ ...aBase, tools: [{ type: "web_search_20250305" }] }) },
  { name: "tools.web_search.max_uses.zero", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 0 }] }) },
  { name: "tools.web_search.bad.location", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", user_location: { type: "exact" } }] }) },
  { name: "tools.web_search.response_inclusion", body: j({ ...aBase, tools: [{ type: "web_search_20260318", name: "web_search", response_inclusion: "excluded" }] }) },
  { name: "tools.web_search.response_inclusion.old", body: j({ ...aBase, tools: [{ type: "web_search_20250305", name: "web_search", response_inclusion: "excluded" }] }) },
  { name: "tools.web_fetch", body: j({ ...aBase, tools: [{ type: "web_fetch_20260309", name: "web_fetch", citations: { enabled: true, x: 1 }, max_content_tokens: 100, use_cache: true }] }) },
  { name: "tools.web_fetch.citations.bad", body: j({ ...aBase, tools: [{ type: "web_fetch_20250910", name: "web_fetch", citations: {} }] }) },
  { name: "tools.bash", body: j({ ...aBase, tools: [{ type: "bash_20250124", name: "bash", input_examples: [{ command: "ls" }], defer_loading: true }] }) },
  { name: "tools.text_editor.old.name", body: j({ ...aBase, tools: [{ type: "text_editor_20250728", name: "str_replace_editor" }] }) },
  { name: "tools.text_editor.max_chars", body: j({ ...aBase, tools: [{ type: "text_editor_20250728", name: "str_replace_based_edit_tool", max_characters: 1000 }] }) },
  { name: "tools.computer", body: j({ ...aBase, tools: [{ type: "computer_20251124", name: "computer", display_width_px: 1024, display_height_px: 768, display_number: -1, enable_zoom: true }] }) },
  { name: "tools.computer.missing.height", body: j({ ...aBase, tools: [{ type: "computer_20250124", name: "computer", display_width_px: 1024 }] }) },
  { name: "tools.computer.null.width", body: j({ ...aBase, tools: [{ type: "computer_20250124", name: "computer", display_width_px: null, display_height_px: 1 }] }) },
  { name: "tools.computer.zoom.old", body: j({ ...aBase, tools: [{ type: "computer_20250124", name: "computer", display_width_px: 1, display_height_px: 1, enable_zoom: true }] }) },
  { name: "tools.memory", body: j({ ...aBase, tools: [{ type: "memory_20250818", name: "memory", cache_control: null }] }) },
  { name: "tools.tool_search", body: j({ ...aBase, tools: [{ type: "tool_search_tool_regex", name: "tool_search_tool_regex" }, { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" }] }) },
  { name: "tools.advisor", body: j({ ...aBase, tools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus", caching: { type: "ephemeral", ttl: "5m" }, max_tokens: 100 }] }) },
  { name: "tools.advisor.no.model", body: j({ ...aBase, tools: [{ type: "advisor_20260301", name: "advisor" }] }) },
  { name: "tools.advisor.empty.model", body: j({ ...aBase, tools: [{ type: "advisor_20260301", name: "advisor", model: "" }] }) },
  { name: "tools.mcp_toolset", body: j({ ...aBase, mcp_servers: [{ name: "srv", url: "u" }, null, { name: 5 }], tools: [{ type: "mcp_toolset", mcp_server_name: "srv", configs: { a: {} }, default_config: null }] }) },
  { name: "tools.mcp_toolset.unknown.server", body: j({ ...aBase, mcp_servers: [{ name: "srv" }], tools: [{ type: "mcp_toolset", mcp_server_name: "other" }] }) },
  { name: "tools.mcp_toolset.no.servers", body: j({ ...aBase, tools: [{ type: "mcp_toolset", mcp_server_name: "srv" }] }) },
  { name: "tools.mcp_toolset.with.name", body: j({ ...aBase, tools: [{ type: "mcp_toolset", name: "x", mcp_server_name: "srv" }] }) },
  { name: "tools.mcp_toolset.bad.configs", body: j({ ...aBase, mcp_servers: [{ name: "srv" }], tools: [{ type: "mcp_toolset", mcp_server_name: "srv", configs: [] }] }) },
  { name: "tools.code_execution.foreign.field", body: j({ ...aBase, tools: [{ type: "code_execution_20250825", name: "code_execution", input_examples: [] }] }) },
  { name: "tools.mixed.order", body: j({ ...aBase, tools: [{ name: "a", input_schema: {} }, { type: "code_execution_20250825", name: "code_execution" }, { type: "custom", name: "b", input_schema: { type: "object" } }] }) },
  { name: "tools.error.after.messages", body: j({ ...aBase, messages: [user([{ type: "bogus" }])], tools: [5] }) },
  { name: "tools.second.bad", body: j({ ...aBase, tools: [{ name: "a", input_schema: {} }, { type: "bash_20250124", name: "bash", strict: "yes" }] }) },
];

// ---------------------------------------------------------------- openai

const oBase = { model: "gpt-5", messages: [user("hi")] };
const oMsg = (...messages: unknown[]) => j({ ...oBase, messages });

const openaiCases: Case[] = [
  { name: "minimal", body: j(oBase) },
  { name: "array.body", body: "[]" },
  { name: "null.body", body: "null" },
  { name: "string.body", body: '"x"' },
  { name: "empty.object", body: "{}" },
  { name: "model.1m", body: j({ ...oBase, model: "claude[1m]" }) },
  { name: "model.long", body: j({ ...oBase, model: "x".repeat(201) }) },
  ...mutate(oBase, "model"),
  ...mutate(oBase, "messages"),
  ...mutate(oBase, "max_tokens"),
  ...mutate(oBase, "max_completion_tokens"),
  ...mutate(oBase, "temperature"),
  ...mutate(oBase, "stop"),
  ...mutate(oBase, "stream"),
  ...mutate(oBase, "tools"),
  ...mutate(oBase, "tool_choice"),
  ...mutate(oBase, "reasoning_effort"),
  { name: "n.two", body: j({ ...oBase, n: 2 }) },
  { name: "legacy.functions", body: j({ ...oBase, functions: [{ name: "f", parameters: { type: "object" } }], function_call: { name: "f" } }) },
  { name: "legacy.function_call.auto", body: j({ ...oBase, function_call: "auto" }) },
  { name: "legacy.function.message", body: oMsg(user("q"), { role: "assistant", content: null, function_call: { name: "f", arguments: "{}" } }, { role: "function", name: "f", content: "r" }) },
  { name: "response_format.json_object", body: j({ ...oBase, response_format: { type: "json_object" } }) },
  { name: "max_tokens.max_safe", body: j({ ...oBase, max_tokens: 9007199254740991 }) },
  { name: "max_tokens.max_safe.plus.one", body: j({ ...oBase, max_tokens: 9007199254740992 }) },
  { name: "max_tokens.max_safe.plus.two", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":9007199254740993}' },
  { name: "temperature.huge", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"temperature":1e308}' },
  { name: "temperature.neg.max.safe", body: j({ ...oBase, temperature: -9007199254740991 }) },
  { name: "max_tokens.both", body: j({ ...oBase, max_tokens: 10, max_completion_tokens: 20 }) },
  { name: "max_tokens.legacy", body: j({ ...oBase, max_tokens: 10 }) },
  { name: "stop.string", body: j({ ...oBase, stop: "END" }) },
  { name: "stop.array", body: j({ ...oBase, stop: ["a", "b"] }) },
  { name: "stop.array.bad", body: j({ ...oBase, stop: ["a", 2] }) },
  { name: "stream.options", body: j({ ...oBase, stream: true, stream_options: { include_usage: true }, user: "u", n: 1 }) },
  { name: "reasoning_effort.all", body: j({ ...oBase, reasoning_effort: "minimal" }) },
  { name: "reasoning_effort.none", body: j({ ...oBase, reasoning_effort: "none" }) },
  { name: "reasoning_effort.bad", body: j({ ...oBase, reasoning_effort: "ultra" }) },
  { name: "response_format.json_schema", body: j({ ...oBase, response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" }, strict: true } } }) },
  { name: "vendor.extras", body: j({ ...oBase, seed: 1, logprobs: true, prompt_cache_key: "k", parallel_tool_calls: false }) },
  { name: "tool_choice.auto", body: j({ ...oBase, tool_choice: "auto" }) },
  { name: "tool_choice.none", body: j({ ...oBase, tool_choice: "none" }) },
  { name: "tool_choice.required", body: j({ ...oBase, tool_choice: "required" }) },
  { name: "tool_choice.function", body: j({ ...oBase, tool_choice: { type: "function", function: { name: "f" } } }) },
  { name: "tool_choice.function.noname", body: j({ ...oBase, tool_choice: { type: "function", function: {} } }) },
  { name: "tool_choice.bad.string", body: j({ ...oBase, tool_choice: "any" }) },
  { name: "tools.function", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object", properties: {} } } }] }) },
  { name: "tools.function.no.params", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f" } }] }) },
  { name: "tools.function.params.array", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f", parameters: [] } }] }) },
  { name: "tools.function.bad.type", body: j({ ...oBase, tools: [{ type: "custom", function: { name: "f" } }] }) },
  { name: "tools.function.no.name", body: j({ ...oBase, tools: [{ type: "function", function: {} }] }) },
  { name: "tools.cache.outer", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f", cache_control: { type: "ephemeral", ttl: "5m" } }, cache_control: { type: "ephemeral", ttl: "1h" } }] }) },
  { name: "tools.cache.inner", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f", cache_control: { type: "ephemeral" } } }] }) },
  { name: "tools.cache.garbage.outer", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f", cache_control: { type: "ephemeral" } }, cache_control: "yes" }] }) },
  { name: "tools.cache.bad.ttl", body: j({ ...oBase, tools: [{ type: "function", function: { name: "f" }, cache_control: { type: "ephemeral", ttl: "2h" } }] }) },
  { name: "system.developer", body: oMsg({ role: "system", content: "s1" }, { role: "developer", content: [{ type: "text", text: "s2" }] }, user("q")) },
  { name: "system.empty.string", body: oMsg({ role: "system", content: "" }, user("q")) },
  { name: "system.cache", body: oMsg({ role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], cache_control: { type: "ephemeral" } }, { role: "system", content: "c", cache_control: { type: "ephemeral", ttl: "1h" } }, user("q")) },
  { name: "system.cache.block.wins", body: oMsg({ role: "system", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }], cache_control: { type: "ephemeral" } }, user("q")) },
  { name: "system.only", body: oMsg({ role: "system", content: "s" }) },
  { name: "messages.empty.content", body: oMsg(user(""), assistant(null)) },
  { name: "message.content.absent", body: oMsg({ role: "user" }, user("x")) },
  { name: "message.role.bad", body: oMsg({ role: "function", content: "x" }) },
  { name: "message.content.number", body: oMsg({ role: "user", content: 5 }) },
  { name: "message.part.bad", body: oMsg(user([{ type: "input_audio" }])) },
  { name: "message.part.text.bad", body: oMsg(user([{ type: "text" }])) },
  { name: "message.parts", body: oMsg(user([{ type: "text", text: "look", cache_control: { type: "ephemeral" } }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}`, detail: "high" } }])) },
  { name: "message.image.remote", body: oMsg(user([{ type: "image_url", image_url: { url: "https://x/y.png" } }])) },
  { name: "message.image.data.bad", body: oMsg(user([{ type: "image_url", image_url: { url: "data:image/png,xyz" } }])) },
  { name: "message.image.no.url", body: oMsg(user([{ type: "image_url", image_url: {} }])) },
  { name: "message.cache.last.block", body: oMsg(user([{ type: "text", text: "a" }, { type: "text", text: "b" }]), { role: "user", content: "c", cache_control: { type: "ephemeral" } }) },
  { name: "message.cache.bad", body: oMsg({ role: "user", content: "c", cache_control: { type: "ephemeral", ttl: "9h" } }) },
  { name: "assistant.tool_calls", body: oMsg(user("q"), { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }, { id: "c2", type: "function", function: { name: "g", arguments: "not json" } }, { id: "c3", type: "function", function: { name: "h", arguments: "[1]" } }, { id: "c4", type: "function", function: { name: "i", arguments: "5" } }], cache_control: { type: "ephemeral" } }, { role: "tool", tool_call_id: "c1", content: "r1" }, { role: "tool", tool_call_id: "c2", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "image_url", image_url: { url: "https://remote" } }, { type: "image_url", image_url: { url: `data:image/gif;base64,R0lGOD` } }], cache_control: { type: "ephemeral" } }) },
  { name: "assistant.tool_calls.empty.id", body: oMsg(user("q"), { role: "assistant", tool_calls: [{ id: "", type: "function", function: { name: "f", arguments: "{}" } }] }) },
  { name: "assistant.tool_calls.bad", body: oMsg(user("q"), { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f" } }] }) },
  { name: "assistant.tool_calls.bad.type", body: oMsg(user("q"), { role: "assistant", tool_calls: [{ id: "c", type: "custom", function: { name: "f", arguments: "" } }] }) },
  { name: "tool.no.id", body: oMsg(user("q"), { role: "tool", content: "x" }) },
  { name: "tool.orphan", body: oMsg(user("q"), { role: "tool", tool_call_id: "nope", content: "x" }) },
  { name: "tool.null.content", body: oMsg(user("q"), { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "" } }] }, { role: "tool", tool_call_id: "c", content: null }) },
  { name: "tool.data.image.bad", body: oMsg(user("q"), { role: "tool", tool_call_id: "c", content: [{ type: "image_url", image_url: { url: "data:nope" } }] }) },
  { name: "images.ollama", body: oMsg({ role: "user", content: "what", images: [PNG, "/9j/4AAQ", "R0lGODlh", "UklGRiIA", `data:image/webp;base64,UklGR`] }) },
  { name: "images.ollama.remote", body: oMsg({ role: "user", content: "x", images: ["https://x/y.png"] }) },
  { name: "images.ollama.unrecognized", body: oMsg({ role: "user", content: "x", images: ["AAAA"] }) },
  { name: "images.ollama.not.image", body: oMsg({ role: "user", content: "x", images: ["data:application/pdf;base64,JVBERi"] }) },
  { name: "images.ollama.not.image.unprintable", body: oMsg({ role: "user", content: "x", images: ["data:text/plain charset;base64,abc"] }) },
  { name: "images.ollama.bad.dataurl", body: oMsg({ role: "user", content: "x", images: ["data:image/png,abc"] }) },
  { name: "images.ollama.system", body: oMsg({ role: "system", content: "x", images: [PNG] }, user("q")) },
  { name: "images.ollama.tool", body: oMsg(user("q"), { role: "tool", tool_call_id: "c", content: "x", images: [PNG] }) },
  { name: "images.ollama.empty.system", body: oMsg({ role: "system", content: "x", images: [] }, user("q")) },
  { name: "images.ollama.assistant", body: oMsg(user("q"), { role: "assistant", content: "x", images: [PNG] }) },
  { name: "images.ollama.not.strings", body: oMsg({ role: "user", content: "x", images: [1] }) },
  { name: "images.only", body: oMsg({ role: "user", images: [PNG] }) },
  { name: "attachments", body: oMsg({ role: "user", content: "x", attachments: [{ url: `data:image/png;base64,${PNG}`, contentType: "image/jpeg", name: "a.png" }, { url: "https://x/a.pdf", contentType: "application/pdf" }, { url: "data:application/pdf;base64,JVBER" }, { url: "AAAA", mediaType: "image/heic" }, { url: "AAAA" }, { url: "AAAA", contentType: "text/plain" }], experimental_attachments: [{ url: PNG }], cache_control: { type: "ephemeral" } }) },
  { name: "attachments.bad", body: oMsg({ role: "user", content: "x", attachments: [{ contentType: "image/png" }] }) },
  { name: "attachments.system.ignored", body: oMsg({ role: "system", content: "s", attachments: [{ url: PNG }] }, user("q")) },
  { name: "header.session", body: j(oBase), headers: [["x-session-affinity", "aff-1"]] },
  { name: "header.anthropic.ignored", body: j(oBase), headers: [["anthropic-beta", "b"]] },
  { name: "merge.roles", body: oMsg(user("a"), user("b"), assistant("c")) },
  { name: "vendor.numeric.keys", body: '{"model":"m","messages":[{"role":"user","content":"x"}],"z":1,"1":2,"__proto__":3}' },
];

// ---------------------------------------------------------------- responses

const rBase = { model: "gpt-5-codex", input: "hi" };
const rItems = (...input: unknown[]) => j({ ...rBase, input });

const responsesCases: Case[] = [
  { name: "minimal", body: j(rBase) },
  { name: "array.body", body: "[]" },
  { name: "null.body", body: "null" },
  { name: "empty.object", body: "{}" },
  { name: "input.empty.string", body: j({ ...rBase, input: "" }) },
  { name: "input.empty.array", body: rItems() },
  ...mutate(rBase, "model"),
  ...mutate(rBase, "input"),
  ...mutate(rBase, "tools"),
  ...mutate(rBase, "instructions"),
  ...mutate(rBase, "max_output_tokens"),
  ...mutate(rBase, "temperature"),
  ...mutate(rBase, "stream"),
  ...mutate(rBase, "reasoning"),
  ...mutate(rBase, "tool_choice"),
  ...mutate(rBase, "previous_response_id"),
  ...mutate(rBase, "store"),
  ...mutate(rBase, "background"),
  ...mutate(rBase, "prompt_cache_key"),
  { name: "model.1m", body: j({ ...rBase, model: "gpt[1m]" }) },
  { name: "instructions", body: j({ ...rBase, instructions: "be terse" }) },
  { name: "instructions.empty", body: j({ ...rBase, instructions: "" }) },
  { name: "store.false", body: j({ ...rBase, store: false, previous_response_id: null, background: false }) },
  { name: "store.true", body: j({ ...rBase, store: true }) },
  { name: "previous_response_id", body: j({ ...rBase, previous_response_id: "resp_1" }) },
  { name: "previous_response_id.empty", body: j({ ...rBase, previous_response_id: "" }) },
  { name: "reasoning.effort", body: j({ ...rBase, reasoning: { effort: "high", summary: "auto" } }) },
  { name: "reasoning.summary.none", body: j({ ...rBase, reasoning: { summary: "none" } }) },
  { name: "reasoning.empty", body: j({ ...rBase, reasoning: {} }) },
  { name: "reasoning.bad.effort", body: j({ ...rBase, reasoning: { effort: "extreme" } }) },
  { name: "tool_choice.auto", body: j({ ...rBase, tool_choice: "auto" }) },
  { name: "tool_choice.required", body: j({ ...rBase, tool_choice: "required" }) },
  { name: "tool_choice.function", body: j({ ...rBase, tool_choice: { type: "function", name: "f" } }) },
  { name: "tool_choice.custom", body: j({ ...rBase, tool_choice: { type: "custom", name: "apply_patch" } }) },
  { name: "tool_choice.hosted", body: j({ ...rBase, tool_choice: { type: "web_search" } }) },
  { name: "prompt_cache_key", body: j({ ...rBase, prompt_cache_key: "  key-1  " }), headers: [["session-id", "hdr"]] },
  { name: "prompt_cache_key.blank", body: j({ ...rBase, prompt_cache_key: "   " }), headers: [["session-id", "hdr"]] },
  { name: "prompt_cache_key.long", body: j({ ...rBase, prompt_cache_key: "k".repeat(513) }) },
  { name: "header.session", body: j(rBase), headers: [["session-id", "codex-sess"]] },
  { name: "vendor.extras", body: j({ ...rBase, include: ["reasoning.encrypted_content"], text: { format: { type: "json_schema", name: "x", schema: {} } }, service_tier: "priority", metadata: { a: 1 }, user: "u", parallel_tool_calls: true }) },
  { name: "items.message", body: rItems({ type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_image", image_url: `data:image/png;base64,${PNG}` }, { type: "input_image", image_url: "https://remote" }, { type: "input_image" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "b", annotations: [] }] }, { type: "message", role: "developer", content: "dev" }, { type: "message", role: "system", content: "sys" }, { role: "user", content: "no type" }) },
  { name: "items.message.text.coerced", body: rItems({ type: "message", role: "user", content: [{ type: "input_text", text: 5 }, { type: "input_text" }, { type: "output_text", text: null }] }) },
  { name: "items.message.string.content", body: rItems({ type: "message", role: "user", content: "s" }) },
  { name: "items.message.content.null", body: rItems({ type: "message", role: "user", content: null }, { type: "message", role: "user", content: "x" }) },
  { name: "items.message.role.unknown", body: rItems({ type: "message", role: "tool", content: "x" }) },
  { name: "items.message.bad.part", body: rItems({ type: "message", role: "user", content: [{ type: "input_audio" }] }) },
  { name: "items.message.bad.part.unprintable", body: rItems({ type: "message", role: "user", content: [{ type: { a: 1 } }] }) },
  { name: "items.message.part.not.object", body: rItems({ type: "message", role: "user", content: ["x"] }) },
  { name: "items.message.part.array", body: rItems({ type: "message", role: "user", content: [[]] }) },
  { name: "items.message.image.bad.dataurl", body: rItems({ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png,abc" }] }) },
  { name: "items.not.object", body: rItems("x") },
  { name: "items.array.item", body: rItems([]) },
  { name: "items.array.item.nonempty", body: rItems(["message"]) },
  { name: "items.output.array.part", body: rItems(user("q"), { type: "function_call", call_id: "c", name: "f", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: [["input_text"], { type: "input_text", text: ["a", null, 1] }] }) },
  { name: "items.message.text.array", body: rItems({ type: "message", role: "user", content: [{ type: "input_text", text: [1, [2, 3], null, { a: 1 }] }] }) },
  { name: "items.reasoning.numeric.keys", body: '{"model":"m","input":[{"role":"user","content":"q"},{"type":"reasoning","z":1,"5":2,"id":"r"}]}' },
  { name: "items.unknown.type", body: rItems({ type: "computer_call" }) },
  { name: "items.null.type.no.role", body: rItems({ type: null }) },
  { name: "items.null.type.role", body: rItems({ type: null, role: "user", content: "x" }) },
  { name: "items.no.type.no.role", body: rItems({ content: "x" }) },
  { name: "items.item_reference", body: rItems({ type: "item_reference", id: "x" }) },
  {
    name: "items.function_call",
    body: rItems(
      user("q"),
      { type: "function_call", call_id: "call_1", name: "f", arguments: '{"a":1}', id: "fc_1" },
      { type: "function_call_output", call_id: "call_1", output: "result" },
      { type: "function_call", call_id: "call_2", name: "g", arguments: "" },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "t" }, { type: "output_text", text: 7 }, { type: "input_image", image_url: `data:image/jpeg;base64,/9j/` }, { type: "input_image", image_url: "https://r" }, { type: "input_file", file_data: "data:application/pdf;base64,JVBERi", filename: "a.pdf" }, { type: "input_file", file_data: "JVBERi0x" }, { type: "input_file", file_data: "AAAA", filename: 5 }, { type: "input_file", file_id: "file_1" }, 5, null] },
      { type: "function_call", call_id: "call_3", name: "h", arguments: "[1,2]" },
      { type: "function_call", call_id: "call_4", name: "i", arguments: "3" },
      { type: "function_call_output", call_id: "call_3", output: { a: 1 } },
      { type: "function_call_output", call_id: "call_4" },
    ),
  },
  { name: "items.function_call.bad.json", body: rItems(user("q"), { type: "function_call", call_id: "call_1", name: "f", arguments: "{" }) },
  { name: "items.function_call.bad.json.long.id", body: rItems(user("q"), { type: "function_call", call_id: "c".repeat(65), name: "f", arguments: "{" }) },
  { name: "items.function_call.args.object", body: rItems(user("q"), { type: "function_call", call_id: "c", name: "f", arguments: { a: 1 } }) },
  { name: "items.function_call.long.id", body: rItems(user("q"), { type: "function_call", call_id: "x".repeat(64), name: "f", arguments: "{}" }, { type: "function_call", call_id: `${"y".repeat(64)}z`, name: "f", arguments: "{}" }, { type: "function_call_output", call_id: `${"y".repeat(64)}z`, output: "ok" }) },
  ...[63, 64, 65].flatMap((units) => {
    // `units` UTF-16 units: one astral char (2 units) and BMP fill, and all-astral where even.
    const mixed = `😀${"é".repeat(units - 2)}`;
    const astral = units % 2 === 0 ? "😀".repeat(units / 2) : `${"😀".repeat((units - 1) / 2)}a`;
    return [mixed, astral].map((id, k) => ({
      name: `items.call_id.unicode.${units}.${k}`,
      body: rItems(user("q"), { type: "function_call", call_id: id, name: "f", arguments: "{}" }, { type: "function_call_output", call_id: id, output: "ok" }),
    }));
  }),
  { name: "items.call_id.unicode.bad.json.65", body: rItems(user("q"), { type: "function_call", call_id: `😀${"é".repeat(63)}`, name: "f", arguments: "{" }) },
  { name: "max_output_tokens.max_safe", body: j({ ...rBase, max_output_tokens: 9007199254740991 }) },
  { name: "max_output_tokens.beyond", body: j({ ...rBase, max_output_tokens: 9007199254740992 }) },
  { name: "items.function_call.dropped", body: rItems(user("q"), { type: "function_call", call_id: "c1", name: "", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "dropped" }, { type: "function_call", call_id: "", name: "f" }, { type: "function_call_output", output: "also dropped" }, { type: "function_call_output", call_id: "orphan", output: "orphan" }) },
  { name: "items.custom_tool_call", body: rItems(user("q"), { type: "custom_tool_call", call_id: "ct", name: "apply_patch", input: "*** Begin Patch" }, { type: "custom_tool_call_output", call_id: "ct", output: "done" }, { type: "custom_tool_call", call_id: "ct2", name: "apply_patch", input: 5 }) },
  { name: "items.reasoning", body: rItems(user("q"), { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "s" }], encrypted_content: "enc" }, { type: "local_shell_call", id: "ls", call_id: "c", action: { type: "exec" } }, { type: "local_shell_call_output", id: "lso", output: "o" }) },
  { name: "tools.function", body: j({ ...rBase, tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" }, strict: true }] }) },
  { name: "tools.function.no.params", body: j({ ...rBase, tools: [{ type: "function", name: "f", parameters: null }] }) },
  { name: "tools.custom", body: j({ ...rBase, tools: [{ type: "custom", name: "apply_patch", description: "p", format: { type: "grammar" } }] }) },
  { name: "tools.function.bad.name", body: j({ ...rBase, tools: [{ type: "function", name: "has space" }] }) },
  { name: "tools.function.long.name", body: j({ ...rBase, tools: [{ type: "function", name: "a".repeat(129) }] }) },
  { name: "tools.function.no.name", body: j({ ...rBase, tools: [{ type: "function" }] }) },
  { name: "tools.hosted", body: j({ ...rBase, tools: [{ type: "web_search", search_context_size: "low" }, { type: "image_generation", name: "img", size: "auto" }, { type: "mcp", server_label: "s" }] }) },
  { name: "tools.hosted.bad.type", body: j({ ...rBase, tools: [{ type: "web search" }] }) },
  { name: "tools.no.type", body: j({ ...rBase, tools: [{ name: "x" }] }) },
  { name: "tools.no.type.no.name", body: j({ ...rBase, tools: [{}] }) },
  { name: "tools.not.object", body: j({ ...rBase, tools: ["x"] }) },
  { name: "tools.hosted.proto", body: '{"model":"m","input":"q","tools":[{"type":"web_search","__proto__":{"a":1},"z":1}]}' },
  { name: "items.reasoning.proto", body: '{"model":"m","input":[{"role":"user","content":"q"},{"type":"reasoning","__proto__":{"a":1},"id":"r"}]}' },
  { name: "tools.array.entry", body: j({ ...rBase, tools: [["function", "f"]] }) },
  { name: "tools.null.entry", body: j({ ...rBase, tools: [null] }) },
  { name: "tools.empty", body: j({ ...rBase, tools: [] }) },
  { name: "merge.roles", body: rItems(user("a"), user("b"), { type: "message", role: "assistant", content: [] }, assistant("c")) },
];

// ---------------------------------------------------------------- customToolNames, normalizeClientModel

const customToolNameCases = [
  null,
  5,
  {},
  { tools: "x" },
  { tools: [{ type: "custom", name: "a" }, { type: "function", name: "b" }, { type: "custom", name: 5 }, null, { type: "custom", name: "a" }, { type: "custom", name: "c" }] },
].map((body) => ({ body, names: [...customToolNames(body)] }));

const normalizeCases = [
  ["m", []],
  ["  m  ", []],
  ["m[1m]", []],
  ["m[1M]", [CONTEXT_1M_BETA]],
  ["m [1m]", ["a"]],
  ["[1m]", []],
  ["  [1m]  ", []],
  ["m[1m][1m]", []],
  ["m[2m]", []],
  ["\u00a0m\u2028", []],
].map(([raw, betas]) => ({ raw, betas, output: normalizeClientModel(raw as string, betas as string[]) }));

// ---------------------------------------------------------------- egress

type Seq = { name: string; events: StreamEvent[] };
const usage = (input = 10, output = 5, read = 0, write = 0, extra: Record<string, number> = {}) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheWriteTokens: write, ...extra });
const start = (model = "claude-x", id = "up_1"): StreamEvent => ({ type: "start", id, model });
const end = (stopReason: string, u = usage(), vendor?: Record<string, Record<string, unknown>>): StreamEvent => ({ type: "end", stopReason, usage: u, ...(vendor === undefined ? {} : { vendor }) }) as StreamEvent;
const text = (index: number, ...parts: string[]): StreamEvent[] => [
  { type: "blockStart", index, block: { type: "text" } },
  ...parts.map((t): StreamEvent => ({ type: "blockDelta", index, delta: { type: "text", text: t } })),
  { type: "blockEnd", index },
];
const thinking = (index: number, signed: boolean | undefined, parts: string[], signature?: string): StreamEvent[] => [
  { type: "blockStart", index, block: signed === undefined ? { type: "thinking" } : { type: "thinking", signed } },
  ...parts.map((t): StreamEvent => ({ type: "blockDelta", index, delta: { type: "thinking", text: t } })),
  ...(signature === undefined ? [] : [{ type: "blockDelta", index, delta: { type: "thinkingSignature", signature } } as StreamEvent]),
  { type: "blockEnd", index },
];
const tool = (index: number, id: string, name: string, ...parts: string[]): StreamEvent[] => [
  { type: "blockStart", index, block: { type: "toolUse", id, name } },
  ...parts.map((p): StreamEvent => ({ type: "blockDelta", index, delta: { type: "toolJson", partial: p } })),
  { type: "blockEnd", index },
];
const err = (code: ErrorCode, message: string): StreamEvent => ({ type: "error", code, message, retryable: false });

const sequences: Seq[] = [
  { name: "text", events: [start(), ...text(0, "Hel", "lo"), end("endTurn")] },
  { name: "empty", events: [] },
  { name: "start.only", events: [start()] },
  { name: "no.start", events: [...text(0, "x"), end("endTurn")] },
  { name: "awkward.text", events: [start("m\"x"), ...text(0, "quote \" \\ \n \u2028 😀 \u0001"), end("stopSequence", usage(1, 2, 3, 4, { cacheWrite5mTokens: 4 }))] },
  { name: "max.tokens", events: [start(), ...text(0, "partial"), end("maxTokens", usage(100, 4096, 50, 25))] },
  { name: "content.filter", events: [start(), ...text(0, "x"), end("contentFilter")] },
  { name: "pause.turn", events: [start(), end("pauseTurn")] },
  { name: "fractional.usage", events: [start(), ...text(0, "x"), end("endTurn", usage(1.5, 0.25, 1e21, 0))] },
  { name: "thinking.signed", events: [start(), ...thinking(0, true, ["think ", "more"], "sig=="), ...text(1, "answer"), end("endTurn")] },
  { name: "thinking.unsigned", events: [start(), ...thinking(0, false, ["summary"]), ...text(1, "answer"), end("endTurn")] },
  { name: "thinking.absent.signed", events: [start(), ...thinking(0, undefined, ["s"], "late-sig"), ...thinking(1, true, [], ""), ...text(2, "a"), end("endTurn")] },
  { name: "thinking.split.signature", events: [start(), { type: "blockStart", index: 0, block: { type: "thinking", signed: true } }, { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "ab" } }, { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "cd" } }, { type: "blockEnd", index: 0 }, end("endTurn")] },
  { name: "tool.calls", events: [start(), ...text(0, "Let me check."), ...tool(1, "toolu_1", "get_weather", '{"ci', 'ty":"SF"}'), ...tool(2, "toolu_2", "apply_patch", '{"input":"*** Begin"}'), end("toolUse")] },
  { name: "tool.only", events: [start(), ...tool(0, "call_1", "f", "{}"), end("toolUse")] },
  { name: "tool.bad.json", events: [start(), ...tool(0, "call_1", "f", '{"a":'), end("toolUse")] },
  { name: "tool.empty.args", events: [start(), ...tool(0, "", "f"), end("toolUse")] },
  { name: "tool.custom.not.envelope", events: [start(), ...tool(0, "c1", "apply_patch", '{"other":1}'), ...tool(1, "c2", "apply_patch", '{"input":5}'), ...tool(2, "c3", "apply_patch", "raw text"), ...tool(3, "c4", "apply_patch", "[1]"), end("toolUse")] },
  { name: "thinking.then.tool", events: [start(), ...thinking(0, false, ["plan"]), ...tool(1, "call_9", "f", '{"x":1}'), end("toolUse")] },
  { name: "tool.then.text", events: [start(), ...tool(0, "c", "f", "{}"), ...text(1, "after"), end("endTurn")] },
  { name: "error.midstream", events: [start(), ...text(0, "partial"), err("UPSTREAM", "upstream died")] },
  { name: "error.open.block", events: [start(), { type: "blockStart", index: 0, block: { type: "text" } }, { type: "blockDelta", index: 0, delta: { type: "text", text: "x" } }, err("TIMEOUT", "deadline")] },
  { name: "error.first", events: [err("NO_CANDIDATES", "no route")] },
  { name: "unterminated", events: [start(), ...text(0, "cut")] },
  { name: "unterminated.open", events: [start(), { type: "blockStart", index: 0, block: { type: "toolUse", id: "c", name: "f" } }, { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: '{"a"' } }] },
  {
    name: "native.anthropic",
    events: [
      start(),
      { type: "blockStart", index: 0, block: { type: "providerNative", provider: "anthropic", blockType: "server_tool_use", data: { id: "srv", name: "web_search", input: {} } } },
      { type: "blockDelta", index: 0, delta: { type: "providerNativeJson", provider: "anthropic", partial: '{"query":"q"}' } },
      { type: "blockEnd", index: 0 },
      { type: "blockStart", index: 1, block: { type: "providerNative", provider: "anthropic", blockType: "web_search_tool_result", data: { type: "ignored", tool_use_id: "srv", content: [{ "2": "b", a: 1 }] } } },
      { type: "blockEnd", index: 1 },
      { type: "blockStart", index: 2, block: { type: "text" } },
      { type: "blockDelta", index: 2, delta: { type: "text", text: "cited" } },
      { type: "blockDelta", index: 2, delta: { type: "providerNative", provider: "anthropic", deltaType: "citations_delta", fold: "citation", data: { citation: { url: "u" } } } },
      { type: "blockEnd", index: 2 },
      end("endTurn", usage(), { anthropic: { safeguard_results: { ok: true }, other: 1 } }),
    ],
  },
  { name: "native.vendor.no.safeguard", events: [start(), ...text(0, "x"), end("endTurn", usage(), { anthropic: { other: 1 }, openai: { safeguard_results: 1 } })] },
  {
    name: "native.openai",
    events: [
      start("gpt-5"),
      { type: "blockStart", index: 0, block: { type: "providerNative", provider: "openai", blockType: "reasoning", data: { id: "rs_up", summary: [] } } },
      { type: "blockDelta", index: 0, delta: { type: "providerNative", provider: "openai", deltaType: "reasoning_summary_text.delta", data: { text: "thinking..." } } },
      { type: "blockDelta", index: 0, delta: { type: "providerNative", provider: "openai", deltaType: "reasoning_summary_text.delta", data: {} } },
      { type: "blockDelta", index: 0, delta: { type: "providerNative", provider: "openai", deltaType: "output_item.done", fold: "merge", data: { encrypted_content: "enc", summary: [{ type: "summary_text", text: "thinking..." }] } } },
      { type: "blockEnd", index: 0 },
      ...text(1, "done"),
      end("endTurn", usage(20, 3, 10, 0)),
    ],
  },
  {
    name: "native.merge.proto",
    events: [
      start("gpt-5"),
      { type: "blockStart", index: 0, block: { type: "providerNative", provider: "openai", blockType: "reasoning", data: JSON.parse('{"id":"rs","__proto__":{"a":1}}') } },
      { type: "blockDelta", index: 0, delta: { type: "providerNative", provider: "openai", deltaType: "output_item.done", fold: "merge", data: JSON.parse('{"__proto__":{"b":2},"encrypted_content":"e","type":"collide"}') } },
      { type: "blockEnd", index: 0 },
      { type: "blockStart", index: 1, block: { type: "providerNative", provider: "anthropic", blockType: "server_tool_use", data: JSON.parse('{"__proto__":{"c":3},"id":"s"}') } },
      { type: "blockDelta", index: 1, delta: { type: "providerNative", provider: "anthropic", deltaType: "citations_delta", data: JSON.parse('{"__proto__":{"d":4},"x":1}') } },
      { type: "blockEnd", index: 1 },
      end("endTurn"),
    ],
  },
  {
    name: "native.reasoning.text.coercion",
    events: [
      start("gpt-5"),
      { type: "blockStart", index: 0, block: { type: "providerNative", provider: "openai", blockType: "reasoning", data: {} } },
      ...[5, 1.5e21, true, false, null, [1, [2, null], "x"], { a: 1 }, "", "\u2028"].map(
        (text): StreamEvent => ({ type: "blockDelta", index: 0, delta: { type: "providerNative", provider: "openai", deltaType: "reasoning_summary_text.delta", data: { text } } }),
      ),
      { type: "blockEnd", index: 0 },
      end("endTurn"),
    ],
  },
  {
    name: "native.type.collisions",
    events: [
      start(),
      { type: "blockStart", index: 0, block: { type: "providerNative", provider: "anthropic", blockType: "web_search_tool_result", data: { type: "inner", "7": "seven", tool_use_id: "s" } } },
      { type: "blockDelta", index: 0, delta: { type: "providerNative", provider: "anthropic", deltaType: "citations_delta", data: { type: "inner_delta", "3": "three", citation: {} } } },
      { type: "blockEnd", index: 0 },
      { type: "blockStart", index: 1, block: { type: "providerNative", provider: "openai", blockType: "local_shell_call", data: { type: "overridden", "2": 2, id: "ls" } } },
      { type: "blockDelta", index: 1, delta: { type: "providerNative", provider: "openai", deltaType: "output_item.done", fold: "merge", data: { type: "merged_type", "1": 1 } } },
      { type: "blockEnd", index: 1 },
      end("endTurn"),
    ],
  },
  { name: "native.other.provider", events: [start(), { type: "blockStart", index: 0, block: { type: "providerNative", provider: "anthropic", blockType: "compaction", data: { content: "c" } } }, { type: "blockEnd", index: 0 }, ...text(1, "t"), end("endTurn")] },
  { name: "duplicate.start", events: [start(), { type: "blockStart", index: 0, block: { type: "text" } }, { type: "blockStart", index: 0, block: { type: "text" } }, { type: "blockDelta", index: 0, delta: { type: "text", text: "once" } }, { type: "blockEnd", index: 0 }, { type: "blockEnd", index: 0 }, end("endTurn")] },
  { name: "reused.index", events: [start(), ...thinking(0, false, ["r"]), ...text(0, "answer"), end("endTurn")] },
  { name: "unclosed.blocks", events: [start(), { type: "blockStart", index: 0, block: { type: "text" } }, { type: "blockDelta", index: 0, delta: { type: "text", text: "a" } }, { type: "blockStart", index: 1, block: { type: "toolUse", id: "c", name: "f" } }, { type: "blockDelta", index: 0, delta: { type: "text", text: "stale" } }, { type: "blockDelta", index: 1, delta: { type: "toolJson", partial: "{}" } }, { type: "blockEnd", index: 0 }, end("toolUse")] },
  {
    name: "stale.block.end",
    events: [
      start(),
      { type: "blockStart", index: 0, block: { type: "text" } },
      { type: "blockDelta", index: 0, delta: { type: "text", text: "a" } },
      { type: "blockStart", index: 1, block: { type: "toolUse", id: "call_s", name: "f" } },
      { type: "blockDelta", index: 1, delta: { type: "toolJson", partial: '{"a":' } },
      { type: "blockEnd", index: 0 },
      { type: "blockDelta", index: 1, delta: { type: "toolJson", partial: "1}" } },
      { type: "blockEnd", index: 1 },
      end("toolUse"),
    ],
  },
  { name: "delta.before.start", events: [start(), { type: "blockDelta", index: 3, delta: { type: "text", text: "orphan" } }, { type: "blockEnd", index: 3 }, ...text(0, "x"), end("endTurn")] },
  { name: "mismatched.deltas", events: [start(), { type: "blockStart", index: 0, block: { type: "text" } }, { type: "blockDelta", index: 0, delta: { type: "thinking", text: "t" } }, { type: "blockDelta", index: 0, delta: { type: "toolJson", partial: "j" } }, { type: "blockDelta", index: 0, delta: { type: "thinkingSignature", signature: "s" } }, { type: "blockEnd", index: 0 }, end("endTurn")] },
  { name: "events.after.end", events: [start(), ...text(0, "x"), end("endTurn"), ...text(1, "y"), end("maxTokens")] },
  { name: "repeated.tool.index", events: [start(), ...tool(5, "a", "f", "{}"), ...tool(5, "b", "g", "{}"), ...tool(2, "c", "h", "{}"), end("toolUse")] },
  { name: "every.error.code", events: [start(), err("AUTH", "a"), err("RATE_LIMIT", "b"), err("QUOTA_EXHAUSTED", "c"), err("OVERLOADED", "d"), err("BAD_REQUEST", "e"), err("CONFLICT", "f"), err("CONTENT_FILTER", "g"), err("CAPABILITY_MISMATCH", "h"), err("FINGERPRINT_REFUSED", "i"), err("MODEL_UNAVAILABLE", "j"), err("NETWORK", "k"), err("ALL_CANDIDATES_FAILED", "l"), err("INTERNAL", "m")] },
];

async function frames(gen: AsyncGenerator<{ event: string; data: string }, void, undefined>) {
  const out: { event: string; data: string }[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

async function* replay(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield structuredClone(e);
}

/** What `sseResponse` in `routes/proxy.ts` writes for each frame. */
/**
 * Buffered bodies are recorded as the exact `JSON.stringify` bytes `jsonResponse`
 * sends, so the Rust side compares bytes rather than re-serializing both sides.
 */
const sseBytes = (fs: { event: string; data: string }[]) => fs.map((f) => `event: ${f.event}\ndata: ${f.data}\n\n`).join("");

const REQUEST_ID = "req_01JABCDEF";
const CREATED = 1794026194;
const CUSTOM = new Set(["apply_patch"]);

async function egress() {
  const out = { anthropic: [] as unknown[], openai: [] as unknown[], responses: [] as unknown[] };
  for (const seq of sequences) {
    const a = await frames(anthropicStream(replay(seq.events), REQUEST_ID));
    const o = await frames(openaiStream(replay(seq.events), REQUEST_ID, CREATED));
    const r = await frames(responsesStream(replay(seq.events), { requestId: REQUEST_ID, created: CREATED, customToolNames: CUSTOM }));
    const collected = collect(structuredClone(seq.events));
    out.anthropic.push({ name: seq.name, events: seq.events, frames: a, bytes: sseBytes(a), responseJson: JSON.stringify(anthropicResponse(collected, REQUEST_ID)) });
    out.openai.push({ name: seq.name, events: seq.events, frames: o, bytes: sseBytes(o), responseJson: JSON.stringify(openaiResponse(collected, REQUEST_ID, CREATED)) });
    out.responses.push({ name: seq.name, events: seq.events, frames: r, bytes: sseBytes(r), responseJson: JSON.stringify(responsesResponse(collected, { requestId: REQUEST_ID, created: CREATED, customToolNames: CUSTOM })) });
  }
  return out;
}

const CODES: ErrorCode[] = ["AUTH", "RATE_LIMIT", "QUOTA_EXHAUSTED", "OVERLOADED", "BAD_REQUEST", "CONFLICT", "CONTENT_FILTER", "CAPABILITY_MISMATCH", "MODEL_UNAVAILABLE", "FINGERPRINT_REFUSED", "UPSTREAM", "TIMEOUT", "NETWORK", "NO_CANDIDATES", "ALL_CANDIDATES_FAILED", "INTERNAL"];
const errorBodies = CODES.flatMap((code) =>
  ["msg", 'quote " \n 😀'].map((message) => ({
    code,
    message,
    status: HTTP_STATUS[code],
    anthropic: JSON.stringify(anthropicErrorBody(code, message)),
    openai: JSON.stringify(openaiErrorBody(code, message)),
    responses: JSON.stringify(responsesErrorBody(code, message)),
  })),
);

const NOW = 1794026194123;
const h = (limit: number, remaining: number, resetAt: number, window = "1m", used = limit - remaining) => ({ window, limit, used, remaining, resetAt });
/**
 * `anthropicRateLimitHeaders`, or — where `toISOString` throws on a reset
 * outside `Date`'s range, failing the TS response — the documented Rust rule:
 * that dimension's reset header is omitted and the rest render as TS renders
 * them (computed here by the real function with the reset neutralised).
 */
function anthropicHeadersOrOmitted(headroom: Record<string, { resetAt: number }>) {
  try {
    return { anthropic: anthropicRateLimitHeaders(headroom as never) };
  } catch (error) {
    const omitted: string[] = [];
    const safe = Object.fromEntries(
      Object.entries(headroom).map(([dim, e]) => {
        const ok = (() => {
          try {
            new Date(Math.ceil(e.resetAt / 1000) * 1000).toISOString();
            return true;
          } catch {
            return false;
          }
        })();
        if (!ok) omitted.push(`anthropic-ratelimit-${dim}-reset`);
        return [dim, ok ? e : { ...e, resetAt: 0 }];
      }),
    );
    const rendered = anthropicRateLimitHeaders(safe as never);
    for (const name of omitted) delete rendered[name];
    return { anthropic: rendered, anthropicTsThrew: String(error) };
  }
}

const headroomCases = [
  {},
  { requests: h(60, 59, NOW + 30_000) },
  { tokens: h(100000, 0, NOW + 5 * 3600_000 + 1, "5h") },
  { requests: h(60, 0, NOW), tokens: h(1.5e6, 1234.5, NOW + 7 * 86400_000, "1w"), spend: h(10, 5, NOW + 1000) },
  { requests: h(1, 1, NOW - 5000) },
  { requests: h(1, 1, NOW + 1) },
  { requests: h(1, 1, NOW + 59_001) },
  { requests: h(1, 1, NOW + 3600_000) },
  { requests: h(1, 1, NOW + 3599_999) },
  { requests: h(1e21, 1e-7, 0) },
  { spend: h(10, 5, NOW + 1000) },
  { tokens: h(5, 5, 253402300799000), requests: h(3, 2, 946684800000) },
  { requests: h(1, 1, 253402300800000), tokens: h(1, 1, -62198755200001) },
  { requests: h(1, 0, -1), tokens: h(0, 0, 999.5) },
  { requests: h(Number.POSITIVE_INFINITY, Number.NaN, NOW + 1000), tokens: h(-0, -5, NOW) },
  { requests: h(1, 1, 8.64e15), tokens: h(1, 1, -8.64e15) },
  { requests: h(1, 1, 8.64e15 - 999) },
  { requests: h(1, 1, 8.64e15 + 1), tokens: h(2, 2, NOW) },
  { requests: h(3, 3, NOW), tokens: h(1, 1, Number.NaN) },
  { tokens: h(1, 1, Number.POSITIVE_INFINITY), requests: h(1, 1, Number.NEGATIVE_INFINITY) },
].map((headroom) => ({
  // Numbers as `String(n)` (with `-0` kept), so NaN and the infinities survive JSON.
  headroom: Object.fromEntries(
    Object.entries(headroom).map(([dim, e]) => [
      dim,
      Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === "number" ? (Object.is(v, -0) ? "-0" : String(v)) : v])),
    ]),
  ),
  now: NOW,
  ...anthropicHeadersOrOmitted(headroom),
  openai: openaiRateLimitHeaders(headroom as never, NOW),
  responses: responsesRateLimitHeaders(headroom as never, NOW),
}));

/**
 * Deep nesting at the bound Rust enforces (`omni_ir::deep::MAX_DEPTH`).
 *
 * Measured, not assumed: TS parses every one of these and keeps the full
 * nesting in the IR, then `JSON.stringify` of the request throws `RangeError`
 * at any of them, because the request object adds levels above the value.
 * The stringify at exactly the bound is recorded on the bare value. Recorded
 * as counts, not bodies, so the file stays small.
 */
const DEPTH_BOUND = 40_000;
const nestDeep = (d: number) => "[".repeat(d) + "0" + "]".repeat(d);
const depthOf = (v: unknown): number => {
  let d = 0;
  while (Array.isArray(v)) {
    d++;
    v = v[0];
  }
  return d;
};
const throws = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return String(e);
  }
};
const depthCases = [DEPTH_BOUND - 1, DEPTH_BOUND, DEPTH_BOUND + 1].map((d) => {
  const chat = parseOpenAIRequest({ model: "m", messages: [user("q"), { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: nestDeep(d) } }] }] });
  const resp = parseResponsesRequest({ model: "m", input: [user("q"), { type: "function_call", call_id: "c", name: "f", arguments: nestDeep(d) }] });
  const body: unknown = JSON.parse(`{"model":"m","messages":[{"role":"user","content":"hi"}],"x":${nestDeep(d - 1)}}`);
  const anth = parseAnthropicRequest(body);
  return {
    depth: d,
    chatArgumentsDepth: depthOf((chat.messages[1]?.content[0] as { input: unknown }).input),
    responsesArgumentsDepth: depthOf((resp.messages[1]?.content[0] as { input: unknown }).input),
    bodyDepth: depthOf((anth.vendor?.anthropic as { x: unknown }).x) + 1,
    stringifyValue: throws(() => JSON.stringify(JSON.parse(nestDeep(d)))),
    stringifyRequest: throws(() => JSON.stringify(chat)),
  };
});

const doc = {
  generatedBy: "conformance/vectors/dialects.ts",
  bunVersion: Bun.version,
  ingress: {
    anthropic: run(parseAnthropicRequest, anthropicCases),
    openai: run(parseOpenAIRequest, openaiCases),
    responses: run(parseResponsesRequest, responsesCases),
  },
  customToolNames: customToolNameCases,
  normalizeClientModel: normalizeCases,
  egress: { requestId: REQUEST_ID, created: CREATED, customToolNames: [...CUSTOM], ...(await egress()) },
  errorBodies,
  rateLimitHeaders: headroomCases,
  depth: { bound: DEPTH_BOUND, cases: depthCases },
};
process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
