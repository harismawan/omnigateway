import { codexModel } from "./codexCatalog.ts";
import {
  keyed,
  prefixNamespace,
  threadInstant,
  uuidV4From,
  uuidV5,
  uuidV7From,
} from "./codexIdentity.ts";
import { OPENAI_SANDBOX } from "./profile.ts";

/**
 * Codex 0.165's "responses-lite" request shape, for the OAuth leg.
 *
 * Every model in Codex's 0.165.0 catalog but `gpt-5.5` sets
 * `use_responses_lite`, and with it the client sends no `instructions` and no
 * `tools`: both ride inside `input` as prefix items. Non-lite keeps its tools in
 * the body but still sends base instructions here — 0.163 removed the
 * `instructions` field — and in both shapes every history item carries an id
 * and the passthrough metadata Codex stamps. This module turns the Responses
 * items `wire.ts` built into that shape, and builds the per-turn metadata that
 * goes beside it.
 *
 * Measured against the live backend before it was built (spec History): the
 * shape returns tool calls with no `namespace`, accepts fabricated item ids
 * under `store: false`, and caches exactly as the plain shape did.
 */

export type LiteInput = {
  /** The conversation's thread id, already resolved by `wire.ts`. */
  threadId: string;
  /** Responses items, in order, as `wire.ts` built them. */
  input: readonly unknown[];
  /**
   * The user turn each item belongs to. An item missing here — the empty
   * output `repairOrphanedCalls` adds — belongs to the item before it.
   */
  turnOf: WeakMap<object, number>;
  /** Tool-result media may share a user message with ordinary user input. */
  toolParts: WeakSet<object>;
  /**
   * The client's function tools in wire form, when the model is lite. A
   * non-lite model sends them in the body and its base instructions still
   * come here: 0.163 removed the `instructions` field outright.
   */
  tools: readonly unknown[] | undefined;
  instructions: string | undefined;
  /** Seeds ids that are fresh per request. */
  requestId: string | undefined;
  /** When the request started, epoch ms. */
  startedAt: number | undefined;
  /** The credential's id salt, which keys every id derived here. */
  idSalt: string | undefined;
  /** Per-content attribution is accepted only by responses-lite. */
  lite: boolean;
  /** Supported models receive the current effort as a history update. */
  effortUpdate: string | undefined;
};

export type LiteResult = {
  input: unknown[];
  /** The current turn: the last user turn the history opened. */
  turnId: string;
  /** The instant turn metadata reports; the request's start when known. */
  startedAt: number;
};

type Item = Record<string, unknown>;

const PASSTHROUGH = "internal_chat_message_metadata_passthrough";

/**
 * A turn's id: the same for every request that includes that turn, so a
 * tool-loop follow-up shares its turn's id as Codex's does, and a past turn
 * keeps the id it had when it was current. Keyed with the credential's salt,
 * so it cannot be recomputed from the thread id sent beside it.
 */
function turnId(threadId: string, index: number, threadAt: number, salt?: string): string {
  return uuidV7From(keyed(salt, `${threadId}:turn:${index}`), threadAt + index);
}

/**
 * Codex's `content_item_kinds`, one per content part.
 *
 * A message holding a part Codex has no kind for (`input_file`: Codex's user
 * content has no file) is sent without the list rather than with a guessed
 * kind. The backend types this field, and an unknown value is a refusal risk
 * that an absent list is not — Codex itself omits it when the feature is off.
 */
function contentKinds(content: unknown, role: string): string[] | undefined {
  if (!Array.isArray(content)) return undefined;
  if (role === "assistant") return content.map(() => "unknown");
  const kinds: string[] = [];
  for (const part of content) {
    const type = (part as { type?: unknown }).type;
    if (type === "input_text") kinds.push("user.text");
    else if (type === "input_image") kinds.push("user.image");
    else return undefined;
  }
  return kinds;
}

export function toLiteInput(args: LiteInput): LiteResult {
  const { threadId } = args;
  const threadAt = threadInstant(threadId, args.startedAt ?? Number.POSITIVE_INFINITY);
  const startedAt = args.startedAt ?? threadAt;
  const historySeed = args.requestId ?? threadId;
  const salt = args.idSalt;
  const namespace = prefixNamespace(threadId);

  const prefix: Item[] = [];
  if (args.tools !== undefined && args.tools.length > 0) {
    const tools = [{ type: "namespace", name: "functions", description: "", tools: args.tools }];
    // Codex hashes `serde_json::to_vec(&tools)`, whose key order is the
    // declaration order this literal repeats; reproduced exactly against a
    // real capture.
    prefix.push({
      type: "additional_tools",
      id: `at_${uuidV5(namespace, JSON.stringify(tools))}`,
      role: "developer",
      tools,
    });
  }
  if (args.instructions !== undefined && args.instructions.length > 0) {
    prefix.push({
      type: "message",
      id: `msg_${uuidV5(namespace, args.instructions)}`,
      role: "developer",
      content: [{ type: "input_text", text: args.instructions }],
      [PASSTHROUGH]: {
        turn_id: turnId(threadId, 0, threadAt, salt),
        create_time: startedAt / 1000,
        content_item_kinds: ["model.base_instructions"],
        ...(args.lite
          ? { content_item_metadata: [{ provenance: { type: "harness", hook: false } }] }
          : {}),
      },
    });
  }

  // Turns only ever open, so the last item's turn is the current one.
  let turn = 0;
  const history = args.input.map((raw, index) => {
    const item = raw as Item;
    turn = args.turnOf.get(item) ?? turn;
    const turn_id = turnId(threadId, turn, threadAt, salt);
    const fresh = (prefixName: string) =>
      `${prefixName}_${uuidV7From(keyed(salt, `${historySeed}:item:${index}`), startedAt)}`;
    // Fractional seconds, as Codex writes it; a microsecond apart per item so
    // the order reads monotonic.
    const create_time = (startedAt * 1000 + index) / 1_000_000;

    switch (item.type) {
      case "message": {
        const role = String(item.role);
        const kinds = contentKinds(item.content, role);
        if (role === "assistant") {
          return {
            type: "message",
            status: "completed",
            id: fresh("msg"),
            role,
            content: Array.isArray(item.content)
              ? item.content.map((part: Item) =>
                  part.type === "output_text" ? { ...part, annotations: [] } : part,
                )
              : item.content,
            [PASSTHROUGH]: {
              turn_id,
              ...(kinds === undefined ? {} : { content_item_kinds: kinds }),
            },
          };
        }
        return {
          type: "message",
          id: fresh("msg"),
          role,
          content: item.content,
          [PASSTHROUGH]: {
            turn_id,
            create_time,
            ...(kinds === undefined ? {} : { content_item_kinds: kinds }),
            ...(args.lite && Array.isArray(item.content)
              ? {
                  content_item_metadata: item.content.map((part: object) => ({
                    provenance: args.toolParts.has(part)
                      ? { type: "tool" }
                      : role === "user"
                        ? { type: "user" }
                        : { type: "harness", hook: false },
                  })),
                }
              : {}),
          },
        };
      }
      case "function_call":
        return {
          type: "function_call",
          status: "completed",
          id: fresh("fc"),
          name: item.name,
          arguments: item.arguments,
          call_id: item.call_id,
          [PASSTHROUGH]: { turn_id },
        };
      case "function_call_output":
        return {
          type: "function_call_output",
          id: fresh("fco"),
          call_id: item.call_id,
          output: item.output,
          [PASSTHROUGH]: { turn_id, create_time },
        };
      case "reasoning": {
        // Still without its server id — that rule was measured against this
        // backend and is `wire.ts`'s. Codex stamps the turn on these too.
        const { [PASSTHROUGH]: _client, ...rest } = item;
        return { ...rest, [PASSTHROUGH]: { turn_id } };
      }
      default:
        return item;
    }
  });

  if (args.effortUpdate !== undefined) {
    // The configuration belongs after the current user prompt, before its
    // assistant/tool loop; historical efforts are not available in the IR.
    let after = 0;
    for (let i = 0; i < args.input.length; i++) {
      const item = args.input[i] as Item;
      if (
        item.type === "message" &&
        item.role === "user" &&
        Array.isArray(item.content) &&
        item.content.some((part: object) => !args.toolParts.has(part))
      ) {
        after = i + 1;
      }
    }
    history.splice(after, 0, {
      type: "configuration_update",
      reasoning: { effort: args.effortUpdate },
    });
  }

  return {
    input: [...prefix, ...history],
    turnId: turnId(threadId, turn, threadAt, salt),
    startedAt,
  };
}

/**
 * Escapes everything outside printable ASCII. The JSON rides a header, and
 * Codex writes this one ASCII-only for the same reason.
 */
function asciiJson(value: unknown): string {
  // `JSON.stringify` already escapes below 0x20; this takes DEL and everything
  // above, one UTF-16 unit at a time, so a surrogate pair becomes two escapes.
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export type CodexTurn = {
  windowId: string;
  /** The `x-codex-turn-metadata` header, repeated in `client_metadata`. */
  turnMetadata: string;
  clientMetadata: Record<string, string>;
};

/**
 * The per-turn identity Codex sends twice: as `x-codex-turn-metadata` and
 * inside the body's `client_metadata`. Keys in the order the capture showed.
 */
export function codexTurn(args: {
  threadId: string;
  turnId: string;
  /** The credential's stored installation id, once it has one. */
  installationId: string | undefined;
  /**
   * What the installation id hashes until then: the account, else the
   * thread's seed. Recomputable from the request, which is why it is only the
   * fallback for a credential not yet refreshed since the stored value began.
   */
  installationSeed: string;
  idSalt: string | undefined;
  model: string;
  effort: string;
  startedAt: number;
}): CodexTurn {
  const { threadId, turnId: turn } = args;
  const windowId = `${threadId}:0`;
  const installationId = args.installationId ?? uuidV4From(`installation:${args.installationSeed}`);
  const threadAt = threadInstant(threadId, args.startedAt);
  const catalog = codexModel(args.model);
  const turnMetadata = asciiJson({
    installation_id: installationId,
    session_id: threadId,
    thread_id: threadId,
    agent_name: "/root",
    turn_id: turn,
    window_id: windowId,
    window_number: 0,
    context_window_id: uuidV7From(keyed(args.idSalt, `${threadId}:context-window`), threadAt),
    request_kind: "turn",
    history_initialization: "new",
    root_turn_id: turn,
    thread_source: "user",
    turn_trigger: "user",
    sandbox: OPENAI_SANDBOX,
    sandbox_mode: "workspace-write",
    auto_review_enabled: false,
    node_repl_auto_review_required: catalog.nodeReplAutoReviewRequired,
    node_repl_disabled: catalog.nodeReplDisabled,
    turn_started_at_unix_ms: args.startedAt,
    analytics_enabled: false,
    model: args.model,
    reasoning_effort: args.effort,
  });
  // A Rust `HashMap` in Codex, so its order varies between requests and none
  // is pinned; this is the order of one capture.
  const clientMetadata: Record<string, string> = {
    turn_id: turn,
    thread_id: threadId,
    "x-codex-turn-metadata": turnMetadata,
    mcp_attribution: '{"status":"none"}',
    guardian_credits_requested: "true",
    "x-codex-installation-id": installationId,
    "x-codex-window-id": windowId,
    root_turn_id: turn,
    session_id: threadId,
  };
  return { windowId, turnMetadata, clientMetadata };
}
