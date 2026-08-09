import type { ChatRequest, ContentBlock, Message, ToolDef } from "./request.ts";

/**
 * Characters per token.
 *
 * Four is the ratio Claude Code's own fallback estimator uses, and it is close
 * enough across English prose, code and JSON for the purpose this serves. The
 * number is deliberately one constant rather than a per-provider table: this
 * estimate paces a client's compaction, and a client asks one endpoint whatever
 * the request would eventually route to.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Tokens a single image is counted as.
 *
 * The real figure depends on the image's dimensions, which the canonical form
 * does not carry — it holds base64 bytes, and counting those as text would
 * report a small photograph as a hundred thousand tokens. A flat, deliberately
 * conservative constant is less wrong than either alternative.
 */
const IMAGE_TOKENS = 1_600;

/** Per-block framing: the wire keys around the payload, not the payload. */
const BLOCK_OVERHEAD = 4;

/** Per-message framing: role, delimiters, the shape around the content. */
const MESSAGE_OVERHEAD = 4;

function fromText(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * A block's contribution.
 *
 * Every class is counted, and that is the whole point of this function. A
 * real agentic conversation keeps most of its tokens inside `toolResult`
 * content and `toolUse` arguments, not inside prose: an estimator that walked
 * only `text` would return near-zero for a session minutes from its context
 * limit, and the client pacing itself against that number would never compact.
 */
function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return BLOCK_OVERHEAD + fromText(block.text);
    case "image":
      return BLOCK_OVERHEAD + IMAGE_TOKENS;
    case "thinking":
      // Replayed thinking is sent upstream and charged for like any other
      // block, so it is counted like any other block.
      return BLOCK_OVERHEAD + fromText(block.text);
    case "toolUse":
      return BLOCK_OVERHEAD + fromText(block.name) + fromText(safeJson(block.input));
    case "toolResult":
      return BLOCK_OVERHEAD + fromText(block.toolUseId) + fromText(block.content);
  }
}

function messageTokens(message: Message): number {
  let total = MESSAGE_OVERHEAD;
  for (const block of message.content) total += blockTokens(block);
  return total;
}

/**
 * A tool definition's contribution, schema included.
 *
 * A large tool set is a fixed cost on every turn of a session, and JSON Schema
 * is verbose. Counting only names would under-report a request by more than the
 * conversation itself in the early turns.
 */
function toolTokens(tool: ToolDef): number {
  return (
    BLOCK_OVERHEAD +
    fromText(tool.name) +
    fromText(tool.description ?? "") +
    fromText(safeJson(tool.inputSchema))
  );
}

/** Tool arguments are `unknown`; a value that cannot be serialized counts zero. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Estimates the prompt tokens a request would send.
 *
 * This is an estimate and is never billed from — dispatch prices a request from
 * what the provider reported. It exists so a client that paces its own context
 * has a number to pace against, which is why it errs toward counting everything
 * the request carries rather than toward a tight lower bound.
 */
export function estimateInputTokens(request: ChatRequest): number {
  let total = 0;
  for (const block of request.system ?? []) total += blockTokens(block);
  for (const message of request.messages) total += messageTokens(message);
  for (const tool of request.tools ?? []) total += toolTokens(tool);
  return total;
}
