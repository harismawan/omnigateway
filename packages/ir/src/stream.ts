import type { ErrorCode } from "./errors.ts";
import type { ContentBlock, ProviderId } from "./request.ts";

/**
 * `pauseTurn` is its own reason, not a flavour of `endTurn` or `toolUse`.
 *
 * Anthropic pauses a long-running server tool and expects the client to append
 * the assistant turn verbatim and resend it. Reported as `endTurn` the client
 * would stop; reported as `toolUse` it would look for a tool call to answer and
 * synthesize a `Continue` message that changes the conversation. Both produce a
 * different exchange than the one the caller asked for.
 */
export type StopReason =
  | "endTurn"
  | "maxTokens"
  | "toolUse"
  | "stopSequence"
  | "contentFilter"
  | "pauseTurn";

/**
 * All four counts are required. Cache fields being optional would mean every
 * consumer — the cost calculation in Task 15, the usage rows in Task 19, the
 * aggregates in Task 25 — writes the same `?? 0`, and one that forgets silently
 * bills a cache read at the full input rate.
 */
/**
 * `inputTokens` is the *uncached* remainder, never the whole prompt.
 *
 * The three providers disagree: Anthropic reports input already net of cache,
 * while OpenAI and Kimi count cached tokens inside their prompt total. This is
 * Anthropic's convention, so those two decoders subtract on the way in. Pricing
 * adds `cacheReadTokens` at the cache rate on top, so a decoder that leaves the
 * overlap in charges those tokens twice — once at full input price and again at
 * the cache rate. An egress rendering a provider that wants a total adds the
 * parts back.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * `cacheWriteTokens` split by the TTL each write bought, when the upstream
   * says. Optional because only Anthropic reports the breakdown, and because a
   * consumer that ignores it still has the aggregate.
   *
   * The two sum to `cacheWriteTokens`. They exist because the rates differ —
   * a 5m write bills at 1.25x base input and a 1h write at 2x — so the
   * aggregate alone cannot be priced once a request mixes the two.
   */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
};

/**
 * Builds `Usage` from a provider that counts cached tokens inside its prompt
 * total, subtracting the overlap back out.
 *
 * Clamped at zero: an upstream reporting more cached tokens than prompt tokens
 * is nonsense, and a negative input would flow into pricing as a credit.
 */
export function usageFromPromptTotal(
  promptTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens = 0,
): Usage {
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/** The whole prompt, for a client surface that reports one number. */
export function promptTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export type ContentBlockStart =
  | { type: "text" }
  /**
   * `signed` states that this reasoning will carry a provider signature, and so
   * can be replayed to that provider on a later turn. Only Anthropic signs one.
   * Reasoning that is not signed is displayable but not replayable, and a
   * surface that would hand it back to Anthropic has to drop it rather than
   * send a block the upstream will reject.
   */
  | { type: "thinking"; signed?: boolean }
  | { type: "toolUse"; id: string; name: string }
  /**
   * `data` is the block's opening payload, which for a result block is the
   * whole block: Anthropic sends those complete in `content_block_start` and
   * never deltas them.
   *
   * `provider` is the adapter decoding the stream, and it is what the collected
   * `ProviderNativeBlock` carries onward — so the block the fold produces is
   * routable by the same rule as one that arrived from a client.
   */
  | {
      type: "providerNative";
      provider: ProviderId;
      blockType: string;
      data: Record<string, unknown>;
    };

export type Delta =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "thinkingSignature"; signature: string }
  | { type: "toolJson"; partial: string }
  /**
   * Kept apart from `toolJson` so a native block can never be folded into a
   * portable `toolUse` accumulator, which is what would send its input onward
   * as a custom function call.
   */
  | { type: "providerNativeJson"; provider: ProviderId; partial: string }
  | {
      type: "providerNative";
      provider: ProviderId;
      deltaType: string;
      /**
       * What this delta does to the block it belongs to, in IR terms.
       *
       * The decoder states it, because the decoder is the only thing that knows
       * what its own delta names mean. Core used to switch on those names
       * directly — `citations_delta` and `compaction_delta`, two Anthropic wire
       * strings sitting inside `collect()` — which made stream folding
       * un-extendable without editing `packages/ir`.
       *
       * `"merge"` folds `data` into the block's own data at completion.
       * `"citation"` appends `data.citation` to the containing text block, which
       * is the one case where a native delta lands on a block of another kind.
       * Absent is the default and means "no effect on the assembled block": the
       * streaming egress path still replays the delta verbatim, and `collect()`
       * — which builds the buffered form — keeps the block's own data and drops
       * the delta's. That is what the code did before this field existed, and
       * `a native delta stating no fold leaves the assembled block alone` asserts it.
       */
      fold?: "merge" | "citation";
      data: Record<string, unknown>;
    };

/**
 * Usage rides on `end` rather than being its own event.
 *
 * Providers report totals at different moments — Anthropic splits them across
 * `message_start` and `message_delta`, OpenAI sends one block with the final
 * chunk — so each decoder accumulates and reports once. That gives dispatch a
 * single place to price the request and one guarantee to rely on: a stream
 * that ends has usage.
 */
export type StreamEvent =
  | { type: "start"; id: string; model: string }
  | { type: "blockStart"; index: number; block: ContentBlockStart }
  | { type: "blockDelta"; index: number; delta: Delta }
  | { type: "blockEnd"; index: number }
  | { type: "end"; stopReason: StopReason; usage: Usage }
  | { type: "error"; code: ErrorCode; message: string; retryable: boolean };

export type CollectedResponse = {
  id: string;
  model: string;
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
};

type Accum =
  | { kind: "text"; text: string; citations: unknown[] }
  | { kind: "thinking"; text: string; signature?: string }
  | { kind: "toolUse"; id: string; name: string; json: string }
  | {
      kind: "providerNative";
      provider: ProviderId;
      blockType: string;
      data: Record<string, unknown>;
      json: string;
      deltas: Array<{
        deltaType: string;
        fold?: "merge" | "citation";
        data: Record<string, unknown>;
      }>;
    };

/**
 * Folds a canonical event stream into a single response. The gateway always
 * streams from the upstream, so non-streaming client requests collapse here
 * rather than taking a separate code path.
 */
export function collect(events: Iterable<StreamEvent>): CollectedResponse {
  let id = "";
  let model = "";
  let stopReason: StopReason = "endTurn";
  let usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const blocks = new Map<number, Accum>();

  for (const ev of events) {
    switch (ev.type) {
      case "start":
        id = ev.id;
        model = ev.model;
        break;
      case "blockStart":
        blocks.set(
          ev.index,
          ev.block.type === "toolUse"
            ? { kind: "toolUse", id: ev.block.id, name: ev.block.name, json: "" }
            : ev.block.type === "thinking"
              ? { kind: "thinking", text: "" }
              : ev.block.type === "providerNative"
                ? {
                    kind: "providerNative",
                    provider: ev.block.provider,
                    blockType: ev.block.blockType,
                    data: ev.block.data,
                    json: "",
                    deltas: [],
                  }
                : { kind: "text", text: "", citations: [] },
        );
        break;
      case "blockDelta": {
        const acc = blocks.get(ev.index);
        if (!acc) break;
        if (ev.delta.type === "text" && acc.kind === "text") acc.text += ev.delta.text;
        else if (ev.delta.type === "thinking" && acc.kind === "thinking") acc.text += ev.delta.text;
        // Concatenated, not assigned: a signature is one long opaque string and
        // nothing promises it arrives in a single delta. Overwriting would keep
        // the last fragment, which is a signature the provider then rejects.
        else if (ev.delta.type === "thinkingSignature" && acc.kind === "thinking")
          acc.signature = (acc.signature ?? "") + ev.delta.signature;
        else if (ev.delta.type === "toolJson" && acc.kind === "toolUse")
          acc.json += ev.delta.partial;
        else if (ev.delta.type === "providerNativeJson" && acc.kind === "providerNative")
          acc.json += ev.delta.partial;
        else if (ev.delta.type === "providerNative") {
          if (acc.kind === "providerNative") acc.deltas.push(ev.delta);
          else if (acc.kind === "text" && ev.delta.fold === "citation")
            acc.citations.push(ev.delta.data.citation);
        }
        break;
      }
      case "end":
        stopReason = ev.stopReason;
        usage = ev.usage;
        break;
      default:
        break;
    }
  }

  const content: ContentBlock[] = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, acc]): ContentBlock => {
      if (acc.kind === "text")
        return {
          type: "text",
          text: acc.text,
          ...(acc.citations.length === 0 ? {} : { citations: acc.citations }),
        };
      if (acc.kind === "thinking")
        return {
          type: "thinking",
          text: acc.text,
          ...(acc.signature === undefined ? {} : { signature: acc.signature }),
        };
      if (acc.kind === "providerNative") {
        let data = acc.json === "" ? acc.data : { ...acc.data, input: parseJson(acc.json) };
        for (const delta of acc.deltas) {
          if (delta.fold === "merge") data = { ...data, ...delta.data };
        }
        return { type: "providerNative", provider: acc.provider, blockType: acc.blockType, data };
      }
      return { type: "toolUse", id: acc.id, name: acc.name, input: parseJson(acc.json) };
    });

  return { id, model, content, stopReason, usage };
}

/** Tool arguments arrive in fragments; a truncated stream must not throw. */
function parseJson(raw: string): unknown {
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
