import type { ChatRequest, ContentBlock, ToolChoice } from "@omni/ir";
import { systemText } from "../system.ts";
import { MAX_OUTPUT_TOKENS } from "./models.ts";

/**
 * IR to Antigravity's Cloud Code request.
 *
 * Forked rather than shared, per boundary rule 2. There is no other Gemini
 * encoder in this package today, so the fork costs nothing now; what it buys is
 * that when a second Google-shaped provider arrives, its quirks land in its own
 * file instead of as a branch in this one.
 *
 * The envelope is the part with no analogue elsewhere here. `v1internal` wraps
 * the Gemini request one level down and **refuses an unknown top-level key**
 * outright — `Invalid JSON payload received. Unknown name "…"` — which is why
 * this builds the six keys explicitly rather than spreading anything into them.
 * Vendor passthrough merges into `request`, where Gemini's own field vocabulary
 * lives; a passthrough that reached the envelope would fail every request that
 * used it.
 */

/**
 * What a replayed `functionCall` carries in place of the signature it lost.
 *
 * Gemini's thinking models sign each tool call and refuse a continuation whose
 * replayed call carries no signature — `400 missing thought_signature` — which
 * would make the *first* tool call work and its result unsendable. The IR has
 * nowhere to keep an opaque provider blob, so the signature does not survive the
 * round trip.
 *
 * Antigravity's backend accepts this sentinel as an explicit "validated
 * elsewhere" marker, which is the same escape omniroute takes on its own bypass
 * path. It is not a forged signature: it asks the upstream to skip a check the
 * gateway cannot satisfy, and Google's own client uses the same string.
 *
 * ponytail: sentinel rather than signature persistence. Storing real signatures
 * needs somewhere provider-owned to keep them keyed by tool-call id; add that if
 * the upstream ever stops honouring the sentinel.
 */
const SIGNATURE_BYPASS = "skip_thought_signature_validator";

/** A Gemini content part, in the subset this encoder produces. */
type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { thoughtSignature: string; functionCall: { name: string; args: unknown } }
  | { functionResponse: { name: string; response: { output: string } } };

type Content = { role: "user" | "model"; parts: Part[] };

type GenerationConfig = {
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  thinkingConfig?: { thinkingBudget?: number; includeThoughts: boolean };
};

type GeminiRequest = {
  contents: Content[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: GenerationConfig;
  tools?: { functionDeclarations: unknown[] }[];
  toolConfig?: unknown;
  [key: string]: unknown;
};

export type AntigravityEnvelope = {
  project: string;
  requestId: string;
  model: string;
  userAgent: string;
  requestType: string;
  request: GeminiRequest;
};

/**
 * Gemini correlates a tool result to its call **by name**, not by id.
 *
 * The IR carries the id, so the name has to be recovered from the `toolUse`
 * block earlier in the same conversation. That map is built from the request's
 * own history rather than stashed in `decodeState`, because the history is
 * always present: a client replaying a tool result has replayed the call that
 * produced it, or the conversation would not typecheck on its own terms.
 *
 * When it is absent anyway — a client that trims history, or a result
 * synthesized by a plugin — the id is sent as the name and a degradation is
 * recorded. Sending an empty name instead would be refused upstream, and
 * dropping the block would delete the answer to a question the model asked.
 */
function toolNamesById(req: ChatRequest): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of req.messages) {
    for (const block of message.content) {
      if (block.type === "toolUse") names.set(block.id, block.name);
    }
  }
  return names;
}

/**
 * Merges adjacent turns that ended up with the same role.
 *
 * **Gemini refuses `contents` carrying two adjacent entries with one role** —
 * `400 INVALID_ARGUMENT: Request contains consecutive messages with the same
 * role` — and this encoder produces them two ways that have nothing to do with
 * a malformed client: a mid-conversation system turn becomes `user` between two
 * user turns, and a tool-result turn is forced to `user` and is then followed by
 * the client's next user turn.
 *
 * Concatenating the parts preserves order and loses nothing; the alternative is
 * a request that fails outright for conversations this gateway is expected to
 * carry. Copies each entry rather than mutating, so the caller's parts arrays
 * are never appended to.
 */
function mergeSameRole(contents: readonly Content[]): Content[] {
  const merged: Content[] = [];
  for (const entry of contents) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.role === entry.role) last.parts.push(...entry.parts);
    else merged.push({ role: entry.role, parts: [...entry.parts] });
  }
  return merged;
}

/**
 * Whether a block carries a cache breakpoint.
 *
 * `in` rather than a property read: the union has no common `cacheControl` to
 * narrow through, and a `thinking` block cannot carry one at all. The same two
 * lines as `kilo/wire.ts` — a third copy should promote it to the package root
 * beside `system.ts`.
 */
const hasCacheControl = (block: ContentBlock): boolean =>
  "cacheControl" in block && block.cacheControl !== undefined;

function encodeToolChoice(choice: ToolChoice): unknown {
  switch (choice.type) {
    case "auto":
      return { functionCallingConfig: { mode: "AUTO" } };
    case "any":
      return { functionCallingConfig: { mode: "ANY" } };
    case "none":
      return { functionCallingConfig: { mode: "NONE" } };
    case "tool":
      return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.name] } };
  }
}

export function toAntigravityWire(
  req: ChatRequest,
  model: string,
  identity: { project: string; requestId: string },
): { body: AntigravityEnvelope; degradations: string[] } {
  const degradations: string[] = [];
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  const names = toolNamesById(req);
  const contents: Content[] = [];

  for (const message of req.messages) {
    const parts: Part[] = [];

    // Gemini has two roles and no third. A mid-conversation system turn keeps
    // its **position** — never folded into `systemInstruction`, which would move
    // an instruction the client placed deliberately — and goes as `user`, which
    // is the only role left that the model reads as input.
    if (message.role === "system") note("antigravity:system-turn-as-user");

    let role: "user" | "model" = message.role === "assistant" ? "model" : "user";

    for (const block of message.content) {
      // Cloud Code's envelope has no cache-control vocabulary at any level, so a
      // breakpoint the client placed cannot be expressed. Recorded rather than
      // dropped in silence, which is the standing rule for a requested feature a
      // provider cannot express.
      if (hasCacheControl(block)) note("antigravity:cache-control-dropped");

      switch (block.type) {
        case "text":
          parts.push({ text: block.text });
          break;
        case "image":
          parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } });
          break;
        case "thinking":
          // Gemini's thoughts come back signed and are meaningless replayed
          // without the signature the IR has nowhere to keep. Same position
          // grok's encoder takes, and recorded for the same reason.
          note("antigravity:thinking-dropped");
          break;
        case "toolUse":
          parts.push({
            thoughtSignature: SIGNATURE_BYPASS,
            functionCall: { name: block.name, args: block.input },
          });
          break;
        case "toolResult": {
          const name = names.get(block.toolUseId);
          if (name === undefined) note("antigravity:tool-result-unmatched");
          // Gemini's `functionResponse` has no failure flag. A failed tool result
          // therefore reaches the model as an ordinary one whose text happens to
          // describe an error, which is a real loss of meaning and is recorded.
          if (block.isError === true) note("antigravity:tool-result-error-flag-dropped");
          parts.push({
            functionResponse: {
              name: name ?? block.toolUseId,
              response: { output: block.content },
            },
          });
          // **A turn carrying a function response must be `user`**, whatever the
          // IR said. Gemini refuses a `functionResponse` on a `model` turn, and
          // an Anthropic-shaped client that puts a tool result on the assistant
          // turn is otherwise perfectly well-formed — so this is a rewrite that
          // has to happen and is not a degradation of anything.
          role = "user";
          break;
        }
        case "providerNative":
          // Unreachable: the router excludes this provider from a request
          // carrying another provider's native history. Recorded rather than
          // ignored so that if it ever arrives, the log says what was lost.
          note("antigravity:provider-native-block-dropped");
          break;
      }
    }

    if (parts.length > 0) contents.push({ role, parts });
  }

  const request: GeminiRequest = { contents: mergeSameRole(contents) };

  const system = systemText(req.system, "antigravity", note);
  if (system !== undefined && system.length > 0) {
    request.systemInstruction = { parts: [{ text: system }] };
  }

  const generationConfig: GenerationConfig = {};
  if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.stopSequences !== undefined) generationConfig.stopSequences = req.stopSequences;

  if (req.reasoning !== undefined) {
    switch (req.reasoning.mode) {
      case "off":
        // An explicit opt-out, and it has to be sent: these models think by
        // default, so saying nothing turns thinking back on. `includeThoughts`
        // is false to match — asking for thoughts from a zero budget is a
        // contradiction the upstream should not have to resolve.
        generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
        break;
      case "budget":
        // **`includeThoughts` is what makes the thinking come back.** A budget
        // alone has the model spend reasoning tokens and return no thought
        // parts, so a client that asked to see the reasoning is billed for it
        // and shown nothing.
        generationConfig.thinkingConfig = {
          thinkingBudget: req.reasoning.budgetTokens,
          includeThoughts: req.reasoning.budgetTokens !== 0,
        };
        break;
      case "adaptive":
        // The tier *is* the model here: `gemini-3.6-flash-high` and `-low` are
        // separate catalog rows differing only in thinking depth. Translating an
        // effort into a budget would fight the model the operator chose, so no
        // budget is sent and the model runs at its own depth. The effort is not
        // lost silently — it is lost visibly.
        //
        // `includeThoughts` is still stated, because the depth is the model's
        // decision and whether the client sees the result is the client's:
        // `display: "omitted"` is the one request to keep them hidden.
        generationConfig.thinkingConfig = {
          includeThoughts: req.reasoning.display !== "omitted",
        };
        if (req.reasoning.effort !== undefined) note("antigravity:reasoning-effort-dropped");
        break;
    }
  }

  // **Cloud Code refuses more than this, whatever the model's own ceiling is.**
  // 16,384 is the wrapper's limit, confirmed upstream against both a Gemini and
  // a Claude row; a request asking for the model's full 65K answers
  // `400 Invalid Argument`. The catalog advertises this number too, so a client
  // that paces itself by `GET /v1/models` never builds one — this clamp is for
  // the client that names its own figure.
  const max = generationConfig.maxOutputTokens;
  if (max !== undefined && max > MAX_OUTPUT_TOKENS) {
    generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS;
    note("antigravity:max-tokens-clamped");
  }

  // A budget at or above the output ceiling leaves no room for an answer, and
  // Cloud Code refuses that combination rather than reconciling it. Raising the
  // ceiling by one is the upstream's own repair.
  const budget = generationConfig.thinkingConfig?.thinkingBudget;
  if (budget !== undefined && budget > 0) {
    const ceiling = generationConfig.maxOutputTokens;
    if (ceiling === undefined || ceiling <= budget) {
      generationConfig.maxOutputTokens = Math.min(budget + 1, MAX_OUTPUT_TOKENS);
    }
  }

  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

  if (req.tools !== undefined) {
    const portable = req.tools.filter((t) => t.kind === "portable");
    if (portable.length !== req.tools.length) note("antigravity:provider-tool-dropped");
    if (portable.length > 0) {
      request.tools = [
        {
          functionDeclarations: portable.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          })),
        },
      ];
    }
  }
  if (req.toolChoice !== undefined) request.toolConfig = encodeToolChoice(req.toolChoice);

  // Last, so an operator can override anything above — and into `request`, not
  // into the envelope. See the file header for why that distinction is fatal
  // rather than stylistic.
  Object.assign(request, req.vendor?.antigravity ?? {});

  return {
    body: {
      project: identity.project,
      requestId: identity.requestId,
      model,
      // Fixed. It names the *client family* to Cloud Code, not the version —
      // that is the `User-Agent` header's job — and the backend gates on it.
      userAgent: "antigravity",
      // `image_gen` is the only other value, and nothing in this gateway's IR
      // can ask for it.
      requestType: "agent",
      request,
    },
    degradations,
  };
}
