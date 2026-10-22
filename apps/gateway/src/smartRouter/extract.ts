import type { ChatRequest, ContentBlock, Message, ToolDef } from "@omni/ir";

/** Longest text one classifier call is asked to judge. */
export const SEGMENT_CHARS = 8_000;

const JOIN = "\n\n";

/**
 * Serialised tool-call arguments. `JSON.stringify` yields `undefined` for an
 * absent input and throws on a value JSON cannot hold; the first contributes
 * nothing, the second must still be judged, so it falls back to `String`.
 */
function serialise(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
    case "thinking":
      return block.text;
    case "toolUse": {
      const args = serialise(block.input);
      return args === "" ? `tool call ${block.name}` : `tool call ${block.name}: ${args}`;
    }
    case "toolResult":
      return block.content;
    // Images, tool-result images/files/native and provider-native payloads are
    // outside the threat model (spec, "What is judged").
    case "image":
    case "providerNative":
      return "";
  }
}

const joinNonEmpty = (parts: string[], separator: string): string =>
  parts.filter((part) => part !== "").join(separator);

function systemUnit(system: ContentBlock[] | undefined): string {
  // Only text: an image or native block in `system` contributes nothing.
  return joinNonEmpty(
    (system ?? []).map((block) => (block.type === "text" ? block.text : "")),
    JOIN,
  );
}

function toolText(tool: ToolDef): string {
  return tool.kind === "portable"
    ? joinNonEmpty([tool.name, tool.description ?? ""], "\n")
    : tool.name;
}

function toolsUnit(tools: ToolDef[] | undefined): string {
  return joinNonEmpty((tools ?? []).map(toolText), JOIN);
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
    ...slices(toolsUnit(request.tools)),
    ...pack(request.messages.map(messageUnit).filter((unit) => unit !== "")),
  ];
}
