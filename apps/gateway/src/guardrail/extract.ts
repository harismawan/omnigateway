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

/**
 * How much human-written text the classifier is shown, in total across every
 * judged message. A total rather than per message, so the setting that widens
 * the window cannot multiply what one classifier call is sent.
 */
export const HUMAN_CAP = 16_000;

/** Stands where the middle of an over-long text was cut out. */
export const TRUNCATION_MARKER = "\n[… truncated …]\n";

/**
 * What the classifier judges, after capping, and whether anything was cut.
 *
 * `human` is oldest first; its last entry is the message being judged, and
 * the ones before it are context. Empty when no human message exists.
 */
export type JudgedText = { system: string; human: readonly string[]; truncated: boolean };

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
 * A message a human wrote, as opposed to a tool turn.
 *
 * A `user` message carrying **no** tool-result block and **at least one** text
 * block. A user message holding any tool result is a tool turn even when the
 * client added text beside it — agent clients inject reminders there — so it is
 * skipped whole. So is one holding no text at all: tool output that is not a
 * `toolResult` arrives that way (a Responses `local_shell_call_output` is a
 * user turn with one native block), and stopping there judges an empty string.
 * A native block *beside* text does not make a tool turn — a cited document
 * with "summarise this" is the human's own ask.
 */
function humanWrote(message: ChatRequest["messages"][number]): boolean {
  return (
    message.role === "user" &&
    !message.content.some((block) => block.type === "toolResult") &&
    message.content.some((block) => block.type === "text")
  );
}

/**
 * The text a usage policy is judged against: the request-level system prompt,
 * and the last `turns` messages a human wrote, oldest first.
 *
 * Walking backwards, tool turns are skipped and never sent (`humanWrote`). That
 * keeps the judged text stable across an agent's tool turns, which is what lets
 * the verdict cache answer them; and it keeps tool output, which the human did
 * not write, out of the classifier's input entirely. More than one human
 * message is judged so a bland follow-up ("continue", "do it") is read in the
 * light of the ask it continues. Mid-conversation system turns and assistant
 * replies are never sent.
 *
 * The human cap is shared, and the newest message spends it first: it is cut
 * head plus tail only when it alone exceeds the cap. Each older message then
 * takes what room is left, cut when it does not fit; once the room is too small
 * to hold the marker, that message and every older one are dropped. So context
 * gives way before the ask does, and the oldest before the newer.
 *
 * No human message at all is not a special case: the classifier is asked
 * about empty text and decides.
 */
export function judgedText(request: ChatRequest, turns: number): JudgedText {
  const system = capText(textOf(request.system ?? []), SYSTEM_CAP);
  // Newest first while walking; reversed once at the end.
  const found: string[] = [];
  for (let i = request.messages.length - 1; i >= 0 && found.length < turns; i--) {
    const message = request.messages[i];
    if (message !== undefined && humanWrote(message)) found.push(textOf(message.content));
  }

  let truncated = system.truncated;
  let room = HUMAN_CAP;
  const human: string[] = [];
  for (const text of found) {
    // Too little room left to cut it around the marker: this message and every
    // older one are dropped, so the context has no hole in it. The newest never
    // lands here — it starts with the whole cap.
    if (text.length > room && room <= TRUNCATION_MARKER.length) {
      truncated = true;
      break;
    }
    const capped = capText(text, room);
    human.push(capped.text);
    room -= capped.text.length;
    truncated ||= capped.truncated;
  }
  return { system: system.text, human: human.reverse(), truncated };
}
