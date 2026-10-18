import type { ChatRequest, ContentBlock } from "@omni/ir";

/**
 * How much of the request-level system text the classifier is shown.
 *
 * Agent clients send system prompts of tens of thousands of tokens. Sent whole
 * they overflow a small classifier, and the check fails closed, so every request
 * from that client would be refused. Constants rather than settings: they bound
 * what the gateway sends a model the operator chose for being small.
 */
export const SYSTEM_CAP = 8_000;

/** How much of the human's own message the classifier is shown. */
export const HUMAN_CAP = 16_000;

/** Stands where the middle of an over-long text was cut out. */
export const TRUNCATION_MARKER = "\n[… truncated …]\n";

/** What the classifier judges, after capping, and whether either half was cut. */
export type JudgedText = { system: string; human: string; truncated: boolean };

/**
 * Head plus tail around an explicit marker, never longer than `cap`.
 *
 * Both ends rather than the head alone: a system prompt's framing is at the
 * top, and the part of a long message a person actually typed is usually at
 * the bottom, under whatever they pasted.
 */
function capText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const room = cap - TRUNCATION_MARKER.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return {
    text: `${text.slice(0, head)}${TRUNCATION_MARKER}${tail === 0 ? "" : text.slice(-tail)}`,
    truncated: true,
  };
}

/** The text blocks alone. Images, files, thinking and native blocks are never judged. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n\n");
}

/**
 * The text a usage policy is judged against: the request-level system prompt,
 * and the last thing a human wrote.
 *
 * "Last thing a human wrote" is the last `user` message that carries **no**
 * tool-result block, walking backwards. A user message holding any tool result
 * is a tool turn even when the client added text beside it — agent clients
 * inject reminders there — so it is skipped whole. That keeps the judged text
 * stable across an agent's tool turns, which is what lets the verdict cache
 * answer them; and it keeps tool output, which the human did not write, out of
 * the classifier's input entirely.
 *
 * Earlier history is not re-judged, and neither are mid-conversation system
 * turns. A forbidden request split across turns gets through; the design says
 * so rather than pretending otherwise.
 *
 * Neither half having any text is not a special case: the classifier is asked
 * about empty strings and decides.
 */
export function judgedText(request: ChatRequest): JudgedText {
  const system = capText(textOf(request.system ?? []), SYSTEM_CAP);
  let human = "";
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message === undefined || message.role !== "user") continue;
    if (message.content.some((block) => block.type === "toolResult")) continue;
    human = textOf(message.content);
    break;
  }
  const capped = capText(human, HUMAN_CAP);
  return {
    system: system.text,
    human: capped.text,
    truncated: system.truncated || capped.truncated,
  };
}
