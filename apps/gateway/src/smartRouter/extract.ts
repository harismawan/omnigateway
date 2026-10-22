import type {
  ChatRequest,
  ContentBlock,
  Message,
  ProviderNativeBlock,
  TextBlock,
  ToolDef,
} from "@omni/ir";

/** Longest text one classifier call is asked to judge. */
export const SEGMENT_CHARS = 8_000;

const JOIN = "\n\n";

/**
 * Serialised structured value: tool-call arguments, tool schemas and options,
 * provider tool wire, citations. `JSON.stringify` yields `undefined` for an
 * absent value and throws on one JSON cannot hold; the first contributes
 * nothing, the second must still be judged, so it falls back to `String`.
 */
function serialise(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

/**
 * A text block's text plus its citations (Anthropic citation payloads quote the
 * source and are sent upstream with the block), when present and non-empty.
 */
function textOf(block: TextBlock): string {
  const citations = block.citations?.length ? serialise(block.citations) : "";
  return joinNonEmpty([block.text, citations], "\n");
}

/**
 * Keys of a native payload that never carry text a person wrote: opaque
 * provider state, identifiers, discriminators and cache markers. Judging them
 * would spend classifier tokens on noise.
 */
const OPAQUE_KEYS: ReadonlySet<string> = new Set([
  "signature",
  "encrypted_content",
  "encrypted_index",
  "id",
  "tool_use_id",
  "type",
  "cache_control",
  "media_type",
]);

const BASE64_FLOOR = 1_000;
const BASE64 = /^[A-Za-z0-9+/=\r\n]+$/;

/** A long run of the base64 alphabet alone: an encoded payload, not prose. */
const isBase64Payload = (text: string): boolean => text.length > BASE64_FLOOR && BASE64.test(text);

/**
 * Every string in a native payload, depth first, minus `OPAQUE_KEYS`, a base64
 * source's `data`, and obvious base64 payloads. Text a provider-owned block
 * carries (a text document, a search result, an MCP result, a compaction, a
 * shell output) is sent upstream like any other text, so it is judged.
 */
function nativeStrings(value: unknown, out: string[], seen: Set<object>): void {
  if (typeof value === "string") {
    if (value !== "" && !isBase64Payload(value)) out.push(value);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) nativeStrings(item, out, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  const base64Source = record.type === "base64";
  for (const [key, item] of Object.entries(record)) {
    if (OPAQUE_KEYS.has(key) || (base64Source && key === "data")) continue;
    nativeStrings(item, out, seen);
  }
}

function nativeText(block: ProviderNativeBlock): string {
  const out: string[] = [];
  nativeStrings(block.data, out, new Set());
  return out.length === 0 ? "" : `[${block.blockType}]\n${out.join("\n")}`;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return textOf(block);
    case "thinking":
      return block.text;
    case "toolUse": {
      const args = serialise(block.input);
      return args === "" ? `tool call ${block.name}` : `tool call ${block.name}: ${args}`;
    }
    // A result's images and files are outside the threat model (spec, "What
    // is judged"); its native parts carry text and are judged.
    case "toolResult":
      return joinNonEmpty([block.content, ...(block.native ?? []).map(nativeText)], "\n");
    case "providerNative":
      return nativeText(block);
    case "image":
      return "";
  }
}

const joinNonEmpty = (parts: string[], separator: string): string =>
  parts.filter((part) => part !== "").join(separator);

function systemUnit(system: ContentBlock[] | undefined): string {
  // Text with its citations, and native blocks' text; an image contributes nothing.
  return joinNonEmpty(
    (system ?? []).map((block) =>
      block.type === "text"
        ? textOf(block)
        : block.type === "providerNative"
          ? nativeText(block)
          : "",
    ),
    JOIN,
  );
}

/**
 * Everything a tool definition sends upstream that can carry text: name,
 * description, the input schema (property-level descriptions live there), and
 * `options` (`input_examples`) for a portable tool; name and `wire` for a
 * provider tool.
 */
function toolText(tool: ToolDef): string {
  if (tool.kind === "provider") return joinNonEmpty([tool.name, serialise(tool.wire)], "\n");
  return joinNonEmpty(
    [
      tool.name,
      tool.description ?? "",
      serialise(tool.inputSchema),
      tool.options === undefined ? "" : serialise(tool.options),
    ],
    "\n",
  );
}

/**
 * Tool definitions, then the vendor bag when it holds anything: pass-through
 * fields such as `prediction.content` and structured-output schema
 * descriptions are sent upstream too. Both are request-level and change rarely,
 * so they share a run.
 */
function toolsUnit(tools: ToolDef[] | undefined, vendor: ChatRequest["vendor"]): string {
  const bag = vendor !== undefined && Object.keys(vendor).length > 0 ? serialise(vendor) : "";
  return joinNonEmpty([...(tools ?? []).map(toolText), bag], JOIN);
}

function messageUnit(message: Message): string {
  const body = joinNonEmpty(message.content.map(blockText), "\n");
  return body === "" ? "" : `[${message.role}]\n${body}`;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * Consecutive slices of at most `SEGMENT_CHARS`, concatenating back to `text`.
 * A cut never lands between the halves of a surrogate pair, so a slice stays
 * valid text for the classifier; that can make a slice one unit short.
 */
function slices(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + SEGMENT_CHARS, text.length);
    if (end < text.length && isHigh(text.charCodeAt(end - 1))) end -= 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/** Pack from the start: a unit joins the open segment while it fits. */
function pack(units: string[]): string[] {
  const out: string[] = [];
  let open = "";
  for (const unit of units.flatMap(slices)) {
    if (open === "") {
      open = unit;
    } else if (open.length + JOIN.length + unit.length <= SEGMENT_CHARS) {
      open += JOIN + unit;
    } else {
      out.push(open);
      open = unit;
    }
  }
  if (open !== "") out.push(open);
  return out;
}

/**
 * Every text the request would send an external provider, as segments of at
 * most `SEGMENT_CHARS`: system, then tool definitions, then the whole history.
 * Tool definitions are judged in full (name, description, input schema,
 * options, provider-tool wire), the vendor bag rides with them, a text block's
 * citations ride with its text, and native blocks and tool-result native parts
 * contribute their strings (`nativeStrings`). Only images, files and base64
 * payloads are left out.
 *
 * Nothing is truncated — text left out of a segment is text sent unjudged. The
 * system and tools runs are never packed with messages, and messages pack
 * greedily from the first turn, so a changed system prompt moves no message
 * segment and appending a turn changes only the last open one. That is what lets
 * a verdict cache hit across turns.
 */
export function segments(request: ChatRequest): string[] {
  return [
    ...slices(systemUnit(request.system)),
    ...slices(toolsUnit(request.tools, request.vendor)),
    ...pack(request.messages.map(messageUnit).filter((unit) => unit !== "")),
  ];
}
