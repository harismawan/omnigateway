import type { ChatRequest, ContentBlock, Message } from "./request.ts";

/**
 * Enforces the IR boundary invariants once, at ingress, so no downstream module
 * has to defend against malformed tool sequences. Returns a new request.
 *
 * `newToolUseId` is injected for the reason clocks are: this package is required
 * to be side-effect-free, and a bare `crypto.randomUUID()` made the one function
 * that rewrites a request answer differently for identical input. It defaults to
 * the real generator, so callers that do not care are unaffected — the same
 * shape `Logger`'s `now` and `memoryCoord`'s clock already use. Only reached
 * when a client sends a `toolUse` block with an empty id, and the id needs to be
 * unique within this request, nothing wider.
 */
export function validateRequest(
  req: ChatRequest,
  newToolUseId: () => string = () => `tu_${crypto.randomUUID()}`,
): ChatRequest {
  const seenToolUseIds = new Set<string>();
  const cleaned: Message[] = [];

  for (const message of req.messages) {
    const content: ContentBlock[] = [];

    for (const block of message.content) {
      if (block.type === "toolUse") {
        const id = block.id.length > 0 ? block.id : newToolUseId();
        seenToolUseIds.add(id);
        content.push({ ...block, id });
        continue;
      }
      // Orphaned tool results make providers reject the whole request.
      if (block.type === "toolResult" && !seenToolUseIds.has(block.toolUseId)) continue;
      content.push(block);
    }

    if (content.length === 0) continue;

    const prev = cleaned.at(-1);
    if (prev && prev.role === message.role) {
      prev.content = [...prev.content, ...content];
    } else {
      cleaned.push({ role: message.role, content });
    }
  }

  return { ...req, messages: cleaned };
}
