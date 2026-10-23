import type { ChatRequest, ContentBlock } from "@omni/ir";
import { GUARDRAIL_HISTORY_TURNS_MAX } from "@omni/store/types";

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

/**
 * How much tool-result text the classifier is shown, in total across every
 * judged result. Separate from `HUMAN_CAP` so a large tool output (a fetched
 * page, a file) can neither crowd out what the human wrote nor be spared by it.
 */
export const TOOL_RESULTS_CAP = 16_000;

/** Stands where the middle of an over-long text was cut out. */
export const TRUNCATION_MARKER = "\n[… truncated …]\n";

/**
 * What the classifier judges, after capping, and whether anything was cut.
 *
 * `human` is oldest first; its last entry is the message being judged, and
 * the ones before it are context. Empty when no human message exists.
 * `toolResults` is the text of the tool results after the oldest judged human
 * message, oldest first; empty when there are none.
 */
export type JudgedText = {
  system: string;
  human: readonly string[];
  toolResults: readonly string[];
  truncated: boolean;
};

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

/**
 * Spends one shared cap on texts given newest first. The newest takes room
 * first and is cut only when it alone exceeds the cap; each older one takes
 * what is left, cut to fit. Once the room cannot hold the marker, that text and
 * every older one are dropped, so what is kept has no hole in it. `kept` stays
 * newest first.
 */
function capNewestFirst(
  texts: readonly string[],
  cap: number,
): { kept: string[]; truncated: boolean } {
  let room = cap;
  let truncated = false;
  const kept: string[] = [];
  for (const text of texts) {
    // Too little room left to cut it around the marker: this text and every
    // older one are dropped. The newest never lands here — it starts with the
    // whole cap.
    if (text.length > room && room <= TRUNCATION_MARKER.length) {
      truncated = true;
      break;
    }
    const capped = capText(text, room);
    kept.push(capped.text);
    room -= capped.text.length;
    truncated ||= capped.truncated;
  }
  return { kept, truncated };
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
 * and the last `turns` messages a human wrote, oldest first. `turns` is clamped
 * to `1..GUARDRAIL_HISTORY_TURNS_MAX`; anything not an integer judges one.
 *
 * Walking backwards, tool turns are not human messages and are skipped when
 * counting the window (`humanWrote`); the text the human wrote is what the
 * window is made of. More than one human message is judged so a bland
 * follow-up ("continue", "do it") is read in the light of the ask it
 * continues. Mid-conversation system turns and assistant replies are never
 * sent.
 *
 * The **text of tool results** after the oldest judged human message is sent
 * too (`toolResults`), so an ask cannot be split into tool output the
 * classifier never sees. Only the text: images, files and native parts of a
 * result are not sent, and neither are tool-call arguments. A tool turn changes
 * what is judged, so an agent's tool loop no longer hits the verdict cache
 * across turns — the accepted cost of judging them.
 *
 * Each cap is shared, and the newest text spends it first: it is cut head plus
 * tail only when it alone exceeds the cap. Each older one then takes what room
 * is left, cut when it does not fit; once the room is too small to hold the
 * marker, that one and every older one are dropped. So context gives way
 * before the ask does, and the oldest before the newer. Tool results have a cap
 * of their own, so a large tool output never costs the human text its room.
 *
 * No human message at all is not a special case: the classifier is asked
 * about empty text and decides.
 */
export function judgedText(request: ChatRequest, turns: number): JudgedText {
  // Settings coercion already keeps `turns` in range; this does not rely on it.
  // A window of zero would judge an empty request, which a classifier may allow.
  const window =
    !Number.isInteger(turns) || turns < 1 ? 1 : Math.min(turns, GUARDRAIL_HISTORY_TURNS_MAX);
  const system = capText(textOf(request.system ?? []), SYSTEM_CAP);
  // Newest first while walking; reversed once at the end.
  const found: string[] = [];
  // Index of the oldest judged human message; -1 when there is none.
  let oldestJudged = -1;
  for (let i = request.messages.length - 1; i >= 0 && found.length < window; i--) {
    const message = request.messages[i];
    if (message !== undefined && humanWrote(message)) {
      found.push(textOf(message.content));
      oldestJudged = i;
    }
  }

  const human = capNewestFirst(found, HUMAN_CAP);

  // Tool results are windowed by the human messages, not counted themselves:
  // everything a tool returned after the oldest judged human message is the
  // output of work that message set going. With no human message at all, the
  // whole request is the window.
  const windowStart = oldestJudged + 1;
  const returned: string[] = [];
  for (let i = request.messages.length - 1; i >= windowStart; i--) {
    const message = request.messages[i];
    if (message?.role !== "user") continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j];
      if (block?.type === "toolResult") returned.push(block.content);
    }
  }
  const results = capNewestFirst(returned, TOOL_RESULTS_CAP);

  return {
    system: system.text,
    human: human.kept.reverse(),
    toolResults: results.kept.reverse(),
    truncated: system.truncated || human.truncated || results.truncated,
  };
}
