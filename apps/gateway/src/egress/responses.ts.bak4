import type { CollectedResponse, ErrorCode, StopReason, StreamEvent, Usage } from "@omni/ir";
import { promptTokens } from "@omni/ir";
import type { HeadroomByDimension } from "@omni/ratelimit";
import type { SseFrame } from "./anthropic.ts";
import { ERROR_TYPE, openaiRateLimitHeaders } from "./openai.ts";

/**
 * How a finish reads on this surface.
 *
 * `pauseTurn` is Anthropic's and has no spelling here, so it reads as a normal
 * finish — the same reading the chat surface already gives it, arrived at the
 * same way. An `incomplete_details.reason` the API does not define would land
 * exactly where clients switch, and this one is reachable only through a chain
 * the router already breaks: `pause_turn` comes from Anthropic server-tool
 * turns, and only the Anthropic ingress can declare those tools.
 */
const STATUS: Readonly<Record<StopReason, { status: string; reason?: string }>> = {
  endTurn: { status: "completed" },
  toolUse: { status: "completed" },
  stopSequence: { status: "completed" },
  pauseTurn: { status: "completed" },
  maxTokens: { status: "incomplete", reason: "max_output_tokens" },
  contentFilter: { status: "incomplete", reason: "content_filter" },
};

/**
 * Usage in this dialect's terms.
 *
 * `input_tokens` is the whole prompt, while IR's `inputTokens` is the *uncached
 * remainder* — so the parts are added back exactly as `promptTokens()` does.
 * Reporting the remainder raw under-reports every cached request, silently, and
 * in the direction that looks like good news.
 *
 * `reasoning_tokens` is `0` because IR does not separate reasoning from output
 * tokens: the honest value is unavailable rather than zero, and the field is
 * emitted anyway because SDKs read it. Nothing should be changed to agree with
 * it — the gateway's own accounting uses `Usage`, not this.
 */
function usageBody(usage: Usage): Record<string, unknown> {
  const input = promptTokens(usage);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.outputTokens,
  };
}

export type ResponsesRender = {
  requestId: string;
  created: number;
  /**
   * The tool names the client declared as freeform `custom` tools.
   *
   * The same IR `toolUse` block renders two different ways depending on which
   * one the client declared, and getting it wrong is silent: a client that
   * registered a function tool dispatches only `function_call`, so a
   * `custom_tool_call` carrying the same name is never executed and the turn
   * ends with a tool result that never arrives.
   */
  customToolNames: ReadonlySet<string>;
};

/**
 * A message item's only content part.
 *
 * `content_index` is the constant `0` on this surface, and that is a property
 * of the assembly rather than a coincidence: every text block gets its own
 * message item, so no item ever holds a second part to number.
 */
const CONTENT_INDEX = 0;

/**
 * Which shape of item is open, which decides every event name it emits.
 *
 * `native` is a block this gateway did not compose and does not interpret: an
 * openai-owned `providerNative`, replayed as the item it already was.
 */
type ItemKind = "message" | "reasoning" | "function_call" | "custom_tool_call" | "native";

type OpenItem = {
  /** The IR block index this item was opened for, and the only one that may close it. */
  irIndex: number;
  outputIndex: number;
  id: string;
  kind: ItemKind;
  /** Text for a message, summary text for reasoning, raw JSON for a tool call. */
  text: string;
  toolName: string;
  callId: string;
  native: Record<string, unknown>;
};

/**
 * The program inside a freeform tool call's JSON envelope.
 *
 * IR carries a custom tool's input as `{"input": "<program>"}`, because that is
 * the portable schema the ingress gives such a tool. The client declared it
 * freeform and expects the program itself, so the envelope is opened here. A
 * payload that is not that shape is passed through rather than dropped: it is
 * still the model's output, and a client that gets nothing cannot tell.
 */
function customToolInput(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "input" in parsed) {
      const inner = (parsed as { input: unknown }).input;
      if (typeof inner === "string") return inner;
    }
  } catch {
    // Not JSON at all — the stream may have been cut mid-argument.
  }
  return raw;
}

/**
 * One item, in whichever shape its kind takes, at the status given.
 *
 * Module scope and shared by both renderers on purpose: the streaming path
 * builds an item incrementally and the buffered path builds it all at once, but
 * a client comparing the two must not be able to tell — a field present in one
 * and absent in the other is the kind of difference nobody notices until a
 * client parses strictly.
 */
function renderItem(item: OpenItem, status: string): Record<string, unknown> {
  const done = status === "completed";
  switch (item.kind) {
    case "message":
      return {
        id: item.id,
        type: "message",
        status,
        role: "assistant",
        content: done ? [{ type: "output_text", text: item.text, annotations: [] }] : [],
      };
    case "reasoning":
      return {
        id: item.id,
        type: "reasoning",
        status,
        summary: done && item.text !== "" ? [{ type: "summary_text", text: item.text }] : [],
      };
    case "function_call":
      return {
        id: item.id,
        type: "function_call",
        status,
        call_id: item.callId,
        name: item.toolName,
        arguments: done ? item.text : "",
      };
    case "custom_tool_call":
      return {
        id: item.id,
        type: "custom_tool_call",
        status,
        call_id: item.callId,
        name: item.toolName,
        input: done ? customToolInput(item.text) : "",
      };
    case "native":
      return item.native;
  }
}

export async function* responsesStream(
  events: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
  render: ResponsesRender,
): AsyncGenerator<SseFrame, void, undefined> {
  let model = "";
  let sequence = 0;
  let terminated = false;

  const frame = (event: string, data: Record<string, unknown>): SseFrame => ({
    event,
    data: JSON.stringify({ type: event, sequence_number: ++sequence, ...data }),
  });

  // Items as they finish, for the terminal event's own `output`. Accumulated
  // rather than rebuilt, because the terminal snapshot is the only place a
  // non-streaming reader of this stream sees the whole turn.
  const output: Record<string, unknown>[] = [];

  const snapshot = (status: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
    id: `resp_${render.requestId}`,
    object: "response",
    created_at: render.created,
    status,
    model,
    output,
    ...extra,
  });

  // One counter for every item, whatever its kind, and one item open at a time.
  //
  // omniroute computed indices per item kind and shipped a live incident for
  // it: a short preamble message before a tool call took the slot the tool-call
  // arithmetic assumed was free, the two items collided on one `output_index`,
  // and clients keying per-item state by that index silently dropped the tool
  // call. A single monotonic counter cannot produce that collision, and the
  // checks below are what stop the state machine from drifting into a shape
  // where two items are live at once.
  //
  // Held on an object rather than in a `let`, and that is a compiler
  // requirement rather than a style: every assignment below happens inside a
  // closure, which control-flow analysis does not follow, so a plain `let`
  // reads at each use as the `null` it was initialised to and narrows every
  // branch guarded on it to `never`.
  let nextOutputIndex = 0;
  const state: { open: OpenItem | null } = { open: null };

  const ID_PREFIX: Readonly<Record<ItemKind, string>> = {
    message: "msg",
    reasoning: "rs",
    function_call: "fc",
    custom_tool_call: "ctc",
    native: "item",
  };

  const open = (irIndex: number, kind: ItemKind, seed?: Partial<OpenItem>): OpenItem => {
    if (state.open !== null) {
      throw new Error(
        `responses egress: block ${irIndex} opened while item ${state.open.outputIndex} is open`,
      );
    }
    const outputIndex = nextOutputIndex++;
    // A tool call is identified by the call id the model produced, because the
    // client answers with that id and nothing else correlates the two.
    const id =
      seed?.callId !== undefined && seed.callId !== ""
        ? `${ID_PREFIX[kind]}_${seed.callId}`
        : `${ID_PREFIX[kind]}_${render.requestId}_${outputIndex}`;
    state.open = {
      irIndex,
      outputIndex,
      id,
      kind,
      text: "",
      toolName: "",
      callId: "",
      native: {},
      ...seed,
    };
    return state.open;
  };

  const itemBody = (item: OpenItem, status: string): Record<string, unknown> =>
    renderItem(item, status);

  /** Closes whatever is open, whether the IR said so or the machine needs the slot. */
  function* closeCurrent(): Generator<SseFrame> {
    const item = state.open;
    if (item === null) return;
    state.open = null;
    const at = { item_id: item.id, output_index: item.outputIndex, content_index: CONTENT_INDEX };

    switch (item.kind) {
      case "message":
        yield frame("response.output_text.done", { ...at, text: item.text });
        yield frame("response.content_part.done", {
          ...at,
          part: { type: "output_text", text: item.text, annotations: [] },
        });
        break;
      case "reasoning":
        yield frame("response.reasoning_summary_text.done", {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: CONTENT_INDEX,
          text: item.text,
        });
        yield frame("response.reasoning_summary_part.done", {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: CONTENT_INDEX,
          part: { type: "summary_text", text: item.text },
        });
        break;
      case "function_call":
        yield frame("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: item.outputIndex,
          arguments: item.text,
        });
        break;
      case "custom_tool_call": {
        // Emitted whole, here and nowhere earlier: the fragments are the JSON
        // envelope, and a client that renders them shows its user the wrapper
        // rather than the program.
        const input = customToolInput(item.text);
        yield frame("response.custom_tool_call_input.delta", {
          item_id: item.id,
          output_index: item.outputIndex,
          delta: input,
        });
        yield frame("response.custom_tool_call_input.done", {
          item_id: item.id,
          output_index: item.outputIndex,
          input,
        });
        break;
      }
      case "native":
        break;
    }

    const body = itemBody(item, "completed");
    output.push(body);
    yield frame("response.output_item.done", { output_index: item.outputIndex, item: body });
  }

  /**
   * Closes on the IR's say-so, refusing any index but the open item's.
   *
   * Nothing open is "nothing to close" — an upstream may end a part it never
   * opened. A *different* item being open is the state machine having lost
   * track of which item it is writing into, which is the bug that puts an
   * `output_item.done` on an index a client is holding other state under.
   */
  function* closeChecked(irIndex: number): Generator<SseFrame> {
    if (state.open === null) return;
    if (state.open.irIndex !== irIndex) {
      throw new Error(
        `responses egress: block ${irIndex} closed while block ${state.open.irIndex} is open`,
      );
    }
    yield* closeCurrent();
  }

  for await (const event of events) {
    switch (event.type) {
      case "start":
        model = event.model;
        yield frame("response.created", { response: snapshot("in_progress") });
        yield frame("response.in_progress", { response: snapshot("in_progress") });
        break;

      case "blockStart": {
        const block = event.block;
        const kind: ItemKind =
          block.type === "text"
            ? "message"
            : block.type === "thinking"
              ? "reasoning"
              : block.type === "toolUse"
                ? render.customToolNames.has(block.name)
                  ? "custom_tool_call"
                  : "function_call"
                : "native";

        const item = open(
          event.index,
          kind,
          block.type === "toolUse"
            ? { callId: block.id, toolName: block.name }
            : block.type === "providerNative"
              ? { native: { type: block.blockType, ...block.data } }
              : {},
        );

        yield frame("response.output_item.added", {
          output_index: item.outputIndex,
          item: itemBody(item, "in_progress"),
        });

        if (kind === "message") {
          yield frame("response.content_part.added", {
            item_id: item.id,
            output_index: item.outputIndex,
            content_index: CONTENT_INDEX,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        if (kind === "reasoning") {
          yield frame("response.reasoning_summary_part.added", {
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: CONTENT_INDEX,
            part: { type: "summary_text", text: "" },
          });
        }
        break;
      }

      case "blockDelta": {
        const item = state.open;
        if (item === null || item.irIndex !== event.index) break;
        const delta = event.delta;

        if (delta.type === "text" && item.kind === "message") {
          item.text += delta.text;
          yield frame("response.output_text.delta", {
            item_id: item.id,
            output_index: item.outputIndex,
            content_index: CONTENT_INDEX,
            delta: delta.text,
          });
        }
        if (delta.type === "thinking" && item.kind === "reasoning") {
          item.text += delta.text;
          yield frame("response.reasoning_summary_text.delta", {
            item_id: item.id,
            output_index: item.outputIndex,
            summary_index: CONTENT_INDEX,
            delta: delta.text,
          });
        }
        if (delta.type === "toolJson") {
          item.text += delta.partial;
          // A freeform call buffers instead: its fragments are the envelope, not
          // the program, so they are worth nothing to the client until the whole
          // payload is here and can be unwrapped.
          if (item.kind === "function_call") {
            yield frame("response.function_call_arguments.delta", {
              item_id: item.id,
              output_index: item.outputIndex,
              delta: delta.partial,
            });
          }
        }
        if (delta.type === "providerNative" && item.kind === "native") {
          // A summary the provider is producing now, forwarded under this
          // dialect's own event name so a client watching the model think sees
          // it as it arrives.
          if (delta.deltaType === "reasoning_summary_text.delta") {
            yield frame("response.reasoning_summary_text.delta", {
              item_id: item.id,
              output_index: item.outputIndex,
              summary_index: CONTENT_INDEX,
              delta: String(delta.data.text ?? ""),
            });
          }
          // The finished item, folded in whole. `encrypted_content` exists on
          // no earlier event, so this is where the replayed block learns it —
          // and it is carried, never read.
          if (delta.fold === "merge") {
            item.native = { ...item.native, ...delta.data };
          }
        }
        // A `thinkingSignature` is Anthropic's, and there is no Responses
        // spelling for it. Dropped rather than carried as an unknown field: the
        // clients reading this stream parse it strictly.
        break;
      }

      case "blockEnd":
        yield* closeChecked(event.index);
        break;

      case "end": {
        // Whatever is still open closes first: a client tracking items by index
        // is holding one that never ended otherwise.
        yield* closeCurrent();
        const { status, reason } = STATUS[event.stopReason];
        terminated = true;
        yield frame(status === "completed" ? "response.completed" : "response.incomplete", {
          response: snapshot(status, {
            ...(reason === undefined ? {} : { incomplete_details: { reason } }),
            usage: usageBody(event.usage),
          }),
        });
        break;
      }

      case "error":
        yield* closeCurrent();
        terminated = true;
        yield frame("response.failed", {
          response: snapshot("failed", {
            error: { code: ERROR_TYPE[event.code].code, message: event.message },
          }),
        });
        break;
    }
  }

  // A stream that stops without saying so. Codex waits for a terminal event and
  // closes on it, so silence here is not an empty answer — it is a client
  // holding the socket open until its own timeout, which reads to the operator
  // as a slow model rather than as the dropped upstream it is.
  if (!terminated) {
    yield* closeCurrent();
    yield frame("response.failed", {
      response: snapshot("failed", {
        error: { code: "stream_disconnected", message: "stream closed before response.completed" },
      }),
    });
  }

  // Not in the specification, and sent anyway: the real backend sends one, this
  // repository's own decoder tolerates one, and the clients that do read it hang
  // without it. Codex closes on the terminal event above and never sees this.
  yield { event: "message", data: "[DONE]" };
}

/**
 * The whole turn at once, for a client that did not ask to stream.
 *
 * Built from the same `renderItem` the stream uses, so the two cannot disagree
 * about an item's shape, and given the same synthetic ids: a buffered reader
 * comparing a replayed turn against a streamed one sees the same document.
 */
export function responsesResponse(collected: CollectedResponse, render: ResponsesRender): unknown {
  const output: Record<string, unknown>[] = [];
  let index = 0;

  for (const block of collected.content) {
    const outputIndex = index++;
    const at = { irIndex: outputIndex, outputIndex, toolName: "", callId: "", native: {} };

    if (block.type === "text") {
      output.push(
        renderItem(
          {
            ...at,
            kind: "message",
            id: `msg_${render.requestId}_${outputIndex}`,
            text: block.text,
          },
          "completed",
        ),
      );
    }
    if (block.type === "thinking") {
      output.push(
        renderItem(
          {
            ...at,
            kind: "reasoning",
            id: `rs_${render.requestId}_${outputIndex}`,
            text: block.text,
          },
          "completed",
        ),
      );
    }
    if (block.type === "toolUse") {
      const custom = render.customToolNames.has(block.name);
      const kind: ItemKind = custom ? "custom_tool_call" : "function_call";
      output.push(
        renderItem(
          {
            ...at,
            kind,
            id: `${custom ? "ctc" : "fc"}_${block.id}`,
            text: JSON.stringify(block.input),
            toolName: block.name,
            callId: block.id,
          },
          "completed",
        ),
      );
    }
    if (block.type === "providerNative" && block.provider === "openai") {
      output.push(
        renderItem(
          {
            ...at,
            kind: "native",
            id: `item_${render.requestId}_${outputIndex}`,
            text: "",
            native: { type: block.blockType, ...block.data },
          },
          "completed",
        ),
      );
    }
  }

  const { status, reason } = STATUS[collected.stopReason];
  return {
    id: `resp_${render.requestId}`,
    object: "response",
    created_at: render.created,
    status,
    model: collected.model,
    output,
    // Stated rather than implied: this gateway keeps nothing, and a client
    // reading the field learns that without having to ask for the response back.
    store: false,
    ...(reason === undefined ? {} : { incomplete_details: { reason } }),
    usage: usageBody(collected.usage),
  };
}

/**
 * A failure in this dialect.
 *
 * The `type` and `code` come from the chat surface's own table rather than a
 * second copy: both are OpenAI dialects, a client may well read either, and two
 * tables mapping one `ErrorCode` are two tables that eventually disagree.
 * `param` is present and null because the field is part of the shape.
 */
export function responsesErrorBody(code: ErrorCode, message: string): unknown {
  const { type, code: errorCode } = ERROR_TYPE[code];
  return { error: { type, code: errorCode, message, param: null } };
}

/** Identical to the chat surface's, and delegated so it stays that way. */
export function responsesRateLimitHeaders(
  headroom: HeadroomByDimension,
  now: number,
): Record<string, string> {
  return openaiRateLimitHeaders(headroom, now);
}
