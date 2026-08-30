import {
  type ChatRequest,
  type ContentBlock,
  cacheControlOf,
  type Message,
  type ToolDef,
} from "./request.ts";

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
    case "providerNative":
      // A web-search result block is mostly its payload, and a session that
      // searches repeatedly carries several. Counting only the discriminator
      // would under-report those turns by thousands of tokens.
      return BLOCK_OVERHEAD + fromText(block.blockType) + fromText(safeJson(block.data));
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
  if (tool.kind === "provider") {
    // A provider-defined tool sends a versioned type and its options, not a
    // schema — the schema lives on the provider's side and is charged for, but
    // its size is not something the request carries or this side can know.
    return (
      BLOCK_OVERHEAD + fromText(tool.name) + fromText(tool.type) + fromText(safeJson(tool.wire))
    );
  }
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

/**
 * The three cumulative prefixes a cache breakpoint can cover, in one walk.
 *
 * A prompt is assembled tools, then system, then the conversation, so the three
 * places a marker can go are nested by construction: `tools` is a prefix of
 * `toolsAndSystem`, which is a prefix of `total`. Asking `estimateInputTokens`
 * for each one separately re-sums the tools three times and the system blocks
 * twice, on every attempt of every request eligible for a marker.
 *
 * `total` is `estimateInputTokens` of the same request, and
 * `packages/ir/test/tokens.test.ts` pins all three against it — this walk and
 * that one are two spellings of one sum, and nothing but a test keeps them so.
 */
export function estimateInputPrefixes(request: ChatRequest): {
  tools: number;
  toolsAndSystem: number;
  total: number;
} {
  let tools = 0;
  for (const tool of request.tools ?? []) tools += toolTokens(tool);

  let toolsAndSystem = tools;
  for (const block of request.system ?? []) toolsAndSystem += blockTokens(block);

  let total = toolsAndSystem;
  for (const message of request.messages) total += messageTokens(message);

  return { tools, toolsAndSystem, total };
}

/**
 * Estimates how much of a request's prompt a cache breakpoint covers.
 *
 * A breakpoint caches everything before it, in the order the prompt is
 * assembled: tools, then system, then the conversation. So the answer is the
 * running total up to and including the last block carrying one, and a request
 * with no breakpoint has no cached prefix at all.
 *
 * Two things this is not. It is not a prediction that the prefix will *hit* —
 * the first turn of a conversation marks the same blocks the second one does
 * and pays to write them. And it is never billed from: dispatch prices a
 * request from the token classes the provider reported. It exists so routing
 * can tell apart two targets whose cache-read prices differ, which comparing
 * fresh input prices alone cannot do.
 */
export function estimateCachedInputTokens(request: ChatRequest): number {
  let running = 0;
  let cached = 0;

  for (const tool of request.tools ?? []) {
    running += toolTokens(tool);
    if (tool.cacheControl !== undefined) cached = running;
  }
  for (const block of request.system ?? []) {
    running += blockTokens(block);
    if (cacheControlOf(block) !== undefined) cached = running;
  }
  for (const message of request.messages) {
    // Framing is charged whether or not a block inside carries the marker, so
    // it joins the running total before the blocks it wraps.
    running += MESSAGE_OVERHEAD;
    for (const block of message.content) {
      running += blockTokens(block);
      if (cacheControlOf(block) !== undefined) cached = running;
    }
  }

  return cached;
}
