import type { CacheControl, ChatRequest, ContentBlock, ToolChoice, ToolDef } from "@omni/ir";
import {
  cacheControlOf,
  estimateCachedInputTokens,
  estimateInputPrefixes,
  GatewayError,
} from "@omni/ir";
import { systemTextBlocks } from "../system.ts";
import { cloakName, type ToolCloak } from "./cloak.ts";
import { anthropicReasoningForm } from "./models.ts";

export const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

type WireCacheControl = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type AnthropicBody = {
  model: string;
  messages: unknown[];
  system?: { type: "text"; text: string; cache_control?: WireCacheControl }[];
  max_tokens: number;
  stream: boolean;
  temperature?: number;
  stop_sequences?: string[];
  /**
   * Two shapes share this array: a portable tool sends a schema, an
   * Anthropic-defined one sends a versioned `type` and its options. Typed as a
   * record because the second shape's legal keys differ per version, and the
   * table that knows them lives in `tools.ts`.
   */
  tools?: Record<string, unknown>[];
  tool_choice?: unknown;
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budget_tokens: number }
    | { type: "disabled" };
  /**
   * Set by this encoder as an object, but vendor passthrough merges whatever a
   * client sent under the same key, and a client can send anything. Declared as
   * it actually arrives so reading it has to narrow first.
   */
  output_config?: unknown;
  [key: string]: unknown;
};

/**
 * Renders a caller's breakpoint, omitting a TTL it did not ask for.
 *
 * Sending `ttl` explicitly would pin the request to one duration; leaving it
 * off is what asks for the provider's default.
 */
function wireCacheControl(c: CacheControl | undefined): { cache_control?: WireCacheControl } {
  if (c === undefined) return {};
  return { cache_control: { type: c.type, ...(c.ttl === undefined ? {} : { ttl: c.ttl }) } };
}

/**
 * Whether a thinking block can be replayed to Anthropic at all.
 *
 * A signature is minted by Anthropic over the reasoning it produced, and the
 * upstream verifies it on every later turn that carries the block. Reasoning
 * that came from another provider has none — the OpenAI decoder turns a
 * reasoning summary into a thinking block, and a client that stores the
 * assistant turn replays it here when the operator switches models. Forwarding
 * it fails the whole request with `Invalid \`signature\` in \`thinking\``, so
 * the block is dropped instead and the loss is recorded.
 */
function isReplayableThinking(b: ContentBlock): boolean {
  return b.type !== "thinking" || (b.signature !== undefined && b.signature !== "");
}

function encodeBlock(b: ContentBlock, cloak: ToolCloak | null): unknown {
  const cache = wireCacheControl(cacheControlOf(b));
  switch (b.type) {
    case "text":
      return {
        type: "text",
        text: b.text,
        ...(b.citations === undefined ? {} : { citations: b.citations }),
        ...cache,
      };
    case "image":
      return {
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.data },
        ...cache,
      };
    case "thinking":
      return { type: "thinking", thinking: b.text, signature: b.signature };
    case "toolUse":
      return {
        type: "tool_use",
        id: b.id,
        name: cloakName(cloak, b.name),
        input: b.input,
        ...cache,
      };
    case "toolResult":
      return {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
        is_error: b.isError,
        ...cache,
      };
    // Rebuilt from the payload the decoder kept, so citations, container ids,
    // caller metadata and error objects go back exactly as they arrived. The
    // discriminator is spread last so a stray `type` inside `data` cannot
    // rename the block on its way out.
    //
    // **Only this provider's own blocks.** `data` is opaque — whatever its
    // producer put there — so spreading a foreign one transmits another
    // provider's payload to Anthropic verbatim. Before the `anthropicNative` →
    // `providerNative` rename the block carried no producer and the *type* was
    // the check, total by construction; the rename gave the block a `provider`
    // field and this encoder went on ignoring it. `encodeTool` above lost its
    // equivalent self-check in the same commit and says so; this one lost it
    // silently, which is the worse half.
    //
    // A guard rather than a fallthrough, unlike `encodeTool`'s deleted one:
    // there is no portable form for a provider-native block, so there is nothing
    // to degrade to. Reaching here means `requiredProviders` admitted a target
    // it should have excluded — a gateway bug, not an operator one — so it is an
    // `INTERNAL` throw for the same reason dispatch throws on a missing adapter.
    case "providerNative":
      if (b.provider !== "anthropic") {
        throw new GatewayError(
          "INTERNAL",
          `anthropic adapter received a ${b.provider} provider-native block`,
        );
      }
      return { ...b.data, type: b.blockType, ...cache };
  }
}

/**
 * Keeps plain mid-conversation instructions in the documented string form.
 * Tool changes share the system role but require block arrays, so any mixed or
 * native content is encoded block-for-block rather than silently discarded.
 */
function encodeSystemTurn(content: ContentBlock[], cloak: ToolCloak | null): string | unknown[] {
  if (content.every((block) => block.type === "text")) {
    return content.map((block) => block.text).join("\n");
  }
  return content.map((block) => encodeBlock(block, cloak));
}

function systemCacheControl(req: ChatRequest): {
  promoted?: CacheControl;
  lost: boolean;
} {
  const cacheable = req.messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "thinking" ? [] : [{ role: message.role, block }],
    ),
  );
  const markedSystemBlocks = cacheable.filter(
    ({ role, block }) => role === "system" && cacheControlOf(block) !== undefined,
  );
  const final = markedSystemBlocks.at(-1);
  const promoted =
    final !== undefined && final.block.type === "text" && cacheable.at(-1) === final
      ? cacheControlOf(final.block)
      : undefined;
  return {
    ...(promoted === undefined ? {} : { promoted }),
    lost: markedSystemBlocks.length > (promoted === undefined ? 0 : 1),
  };
}

/**
 * Renders one tool entry.
 *
 * An Anthropic-defined tool is emitted with the version the caller wrote and
 * the options ingress validated against that version — the gateway never
 * upgrades a date or supplies a default, because either would send Anthropic a
 * different tool than the one the client declared. `mcp_toolset` is the one
 * entry with no name, so an empty one is omitted rather than sent as `""`.
 *
 * That is also why the cloak reaches only the second branch. An Anthropic name
 * is paired with its `type` by Anthropic and re-validated against that pairing
 * at ingress, so renaming one breaks the request at both ends.
 */
function encodeTool(t: ToolDef, cloak: ToolCloak | null): Record<string, unknown> {
  // `kind === "provider"` and not `provider === "anthropic"`, and the difference
  // is a dependency worth naming. This branch encodes the tool as Anthropic's,
  // so it is correct only because a provider-defined tool never reaches another
  // provider's adapter — `requiredProviders` in `packages/router/src/filters.ts`
  // admits only targets of the provider that owns it.
  //
  // The old discriminant was `provider === "anthropic"`, which was self-checking:
  // a foreign provider-defined tool fell through to the portable branch. This one
  // is not, so the check is restated below rather than left to the router alone.
  //
  // **An earlier version of this comment declined to add that check**, on the
  // grounds that a branch which cannot fire under correct routing is decoration.
  // The argument was sound and the premise was not: review found
  // `requiredProvider` returned the *first* provider-owned item rather than every
  // one, so a request naming two providers was admitted to targets of one and
  // this branch would have fired. Deleted checks are right when the real decision
  // is provably made elsewhere; here it was not, and the proof was never run.
  if (t.kind === "provider") {
    if (t.provider !== "anthropic") {
      throw new GatewayError(
        "INTERNAL",
        `anthropic adapter received a ${t.provider} provider-defined tool`,
      );
    }
    return {
      type: t.type,
      ...(t.name === "" ? {} : { name: t.name }),
      ...t.wire,
      ...wireCacheControl(t.cacheControl),
    };
  }
  return {
    name: cloakName(cloak, t.name),
    ...(t.description === undefined ? {} : { description: t.description }),
    input_schema: t.inputSchema,
    ...(t.options ?? {}),
    ...wireCacheControl(t.cacheControl),
  };
}

function encodeToolChoice(c: ToolChoice, cloak: ToolCloak | null): unknown {
  switch (c.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: cloakName(cloak, c.name) };
  }
}

/**
 * Whether a value is a plain JSON object, which is the only shape whose keys
 * this encoder reads. Arrays and `null` are objects to `typeof` and neither is
 * one here.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The vendor block minus an `output_config.effort` this model cannot express.
 *
 * Ingress keeps the client's raw `output_config` out of the known fields, so it
 * reaches the body through passthrough even after the encoder has downgraded
 * the thinking form. A budget-form model rejects `effort` outright. The gateway
 * does not generally validate request shape per model, but here it already
 * knows the field is unexpressible and records the loss, so forwarding a
 * request it knows will be rejected buys the caller nothing.
 *
 * Only that one key moves. Everything else — other `output_config` keys, other
 * vendor fields — is passed on as given, and an `output_config` that is not an
 * object is left alone rather than rewritten into a shape nobody asked for.
 */
function withoutEffort(
  vendor: Record<string, unknown>,
  note: (d: string) => void,
): Record<string, unknown> {
  const config = vendor.output_config;
  if (!isRecord(config)) return vendor;
  const entries = Object.entries(config);
  const kept = entries.filter(([key]) => key !== "effort");
  if (kept.length === entries.length) return vendor;

  note("anthropic:effort-unsupported");
  // An `output_config` that held nothing but `effort` is dropped rather than
  // sent as an empty object.
  if (kept.length === 0) {
    return Object.fromEntries(Object.entries(vendor).filter(([key]) => key !== "output_config"));
  }
  return { ...vendor, output_config: Object.fromEntries(kept) };
}

/** The context edits that upstream rejects unless thinking is on. */
const THINKING_ONLY_EDITS = new Set(["clear_thinking_20251015"]);

/**
 * Whether the merged body asks the model to think.
 *
 * An absent `thinking` is not an answer either way — it leaves the provider
 * default in place — so only a form that is present and off counts as off.
 */
function thinkingIsOff(thinking: unknown): boolean {
  if (!isRecord(thinking)) return thinking !== undefined;
  return thinking.type !== "adaptive" && thinking.type !== "enabled";
}

/**
 * The body minus a context edit that needs a thinking mode this body lacks.
 *
 * Ingress keeps `context_management` out of the known fields, so a client's
 * `clear_thinking_*` edit rides through passthrough even after the encoder has
 * turned thinking off — which upstream answers with `` `clear_thinking_...`
 * strategy requires `thinking` to be enabled or adaptive ``. Same shape as
 * `withoutEffort`, and the same reasoning: the gateway does not generally
 * validate request shape per model, but it already knows this pairing is
 * rejected.
 *
 * Read after the vendor merge, not before: passthrough can set `thinking`
 * itself, and it outranks the mapping. Edit types are matched exactly — an
 * unfamiliar dated version is left for upstream to rule on rather than
 * prefix-matched into something this table has never seen.
 */
function stripUnsupportedEdits(body: AnthropicBody, note: (d: string) => void): void {
  if (!thinkingIsOff(body.thinking)) return;
  const config = body.context_management;
  if (!isRecord(config) || !Array.isArray(config.edits)) return;

  const kept = config.edits.filter(
    (e) => !(isRecord(e) && THINKING_ONLY_EDITS.has(String(e.type))),
  );
  if (kept.length === config.edits.length) return;

  note("anthropic:clear-thinking-unsupported");
  // A `context_management` that held nothing else is dropped rather than sent
  // as an empty edit list.
  if (kept.length === 0 && Object.keys(config).length === 1) {
    delete body.context_management;
    return;
  }
  body.context_management = { ...config, edits: kept };
}

/**
 * Below this, Anthropic caches nothing however the request is marked.
 *
 * One constant rather than a table per model, and it is not the floor. The real
 * minimum is model-dependent and not monotonic across generations — 512 on
 * Opus 5, 1024 on Opus 4.8 and Sonnet 5 and 4.6, 2048 on Opus 4.7, 4096 on
 * Opus 4.6 and Haiku 4.5 — so 1024 over-gates the first and under-gates the
 * last two. The estimator is nowhere near accurate enough for a table to mean
 * anything, and the error runs safe in both directions at no charge: a prompt
 * that squeaks past this gate and turns out too small is ignored upstream, and
 * one held back below it is billed exactly as it was before this feature
 * existed.
 */
const AUTO_CACHE_MIN_TOKENS = 1024;

/**
 * Whether a top-level `cache_control` is riding along in the vendor bag.
 *
 * `cache_control` is not one of the fields ingress names, so a client that sets
 * the request-level auto-caching form gets it forwarded verbatim through
 * `vendor` — where it is invisible to `estimateCachedInputTokens`, which only
 * walks the IR. Without this check such a request reads as unmarked and would
 * be given a second breakpoint it never asked for.
 */
function hasVendorCacheControl(req: ChatRequest): boolean {
  const anthropic = req.vendor?.anthropic;
  return typeof anthropic === "object" && anthropic !== null && "cache_control" in anthropic;
}

/**
 * The block types Anthropic accepts a `cache_control` on.
 *
 * Everything else in a content array — `thinking` and `redacted_thinking` most
 * of all, but equally a server tool result the decoder kept verbatim — is
 * walked past rather than marked. A marker on one of those does not degrade the
 * request, it fails it.
 */
const CACHEABLE_WIRE_BLOCKS = new Set(["text", "image", "tool_use", "tool_result", "document"]);

/**
 * The last content block in the wire history that can carry a breakpoint.
 *
 * Walked from the end of `body.messages` backwards, and within each message
 * from the end of its content backwards, because a breakpoint caches everything
 * before it and the whole point of this one is to cover the conversation. Two
 * shapes are stepped over rather than assumed away: a message whose content is
 * a plain string, which `encodeSystemTurn` produces for an all-text
 * mid-conversation system turn and which has nowhere to put a `cache_control`,
 * and a block whose type takes none.
 *
 * What actually skips the string turn is the per-block `isRecord`: indexing a
 * string yields one-character strings, none of which is a record, so the walk
 * would find nothing there and move on with or without the `Array.isArray`
 * above it. That check earns its place for a different reason — `content` is
 * `unknown`, and narrowing it to an array is what makes indexing it and reading
 * its `length` mean anything at all. Deleting it changes no behaviour and stops
 * the file compiling, which is the order those two facts belong in.
 *
 * This reads `body.messages`, never `req.messages`. `toWire`'s flatMap drops
 * any turn whose content was entirely unsignable reasoning, so the two arrays
 * have different lengths, and a position taken from the IR would land on the
 * wrong turn as history grows — silently, and further off with every turn.
 * `AnthropicBody.messages` is `unknown[]` because it holds whatever the
 * encoders produced, so the walk narrows before it writes.
 */
function lastCacheableHistoryBlock(messages: unknown[]): Record<string, unknown> | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message: unknown = messages[m];
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (let b = message.content.length - 1; b >= 0; b--) {
      const block: unknown = message.content[b];
      if (!isRecord(block)) continue;
      if (typeof block.type === "string" && CACHEABLE_WIRE_BLOCKS.has(block.type)) return block;
    }
  }
  return undefined;
}

/**
 * Adds the breakpoints a client omitted, when the operator asked us to.
 *
 * Caching at Anthropic is opt-in: an unmarked request is billed as fresh input
 * every time, however stable its prefix. A client that never marks one pays
 * full price to resend a prompt verbatim.
 *
 * Three markers, in render order — last tool, last system block, last cacheable
 * block of the history — because they cache three different prefixes. Tools and
 * system are separate invalidation tiers upstream: editing the system prompt
 * drops the system and message entries and leaves the tools entry standing. One
 * marker at end-of-system would take the tools down with it for nothing. And a
 * marker on the history is the only one that covers the part of a conversation
 * that grows, which past the first few turns is most of it.
 *
 * Three things make this safe to do on the caller's behalf:
 *
 * - It runs **only** when the request carries no breakpoint anywhere.
 *   `estimateCachedInputTokens` returns zero in exactly that case — every
 *   marked block adds a strictly positive count before it records one — and
 *   `hasVendorCacheControl` covers the one marker that never reaches the IR.
 *   So a client that placed its own is never second-guessed, and three markers
 *   of Anthropic's four cannot reach the ceiling that turns into a 400.
 * - It writes to the **wire body**, whose arrays `toWire` just built from fresh
 *   object literals, and never to `req`. The IR is one shared object across
 *   every attempt, so a breakpoint written there would follow a failover into
 *   another provider and into what RTK and the token estimate believe the
 *   caller sent. The history marker is no exception and needs no exemption:
 *   `systemCacheControl`'s promotion path walks the IR, so it cannot observe a
 *   wire-side marker at all.
 * - A marker goes down only where it *adds* a cached prefix. The three tiers
 *   are not three independent questions: `estimateInputPrefixes` accumulates
 *   non-negative terms, so tools ≤ tools+system ≤ whole request always, and a
 *   gate per tier on the prefix that tier caches passes all three whenever it
 *   passes the first. That is how a big tool set under a one-line system prompt
 *   earned three markers over three prefixes a token apart — three of
 *   Anthropic's four slots, and two cache writes, to store the same bytes
 *   again. So each tier is measured against what the last marker already
 *   covers, and has to beat it by the same minimum a prefix needs to cache at
 *   all.
 */
function addAutoCacheBreakpoints(
  body: AnthropicBody,
  req: ChatRequest,
  note: (d: string) => void,
): void {
  if (estimateCachedInputTokens(req) !== 0 || hasVendorCacheControl(req)) return;

  /**
   * The prefix, in tokens, that the last marker *placed* already caches.
   *
   * Deliberately not "the previous tier's prefix". A tier can clear the
   * minimum and still be skipped — an empty `body.system` on a request whose IR
   * system blocks were all dropped, say — and a tier that never wrote anything
   * is not a boundary later tiers have to clear. Comparing against it would
   * measure an increment from a marker that does not exist and suppress the one
   * that would have paid.
   *
   * Starting at zero is what makes the first marker's test the ordinary one:
   * with nothing cached below it, "extends the prefix below by 1,024" and
   * "caches at least 1,024" are the same sentence. That also makes Anthropic's
   * own minimum implicit rather than a second comparison — this number is
   * either zero or already at least `AUTO_CACHE_MIN_TOKENS`, so anything that
   * clears it by that much clears the minimum outright. A separate cumulative
   * check would be a condition no input can fail.
   */
  let markedPrefix = 0;

  const worthAMarker = (prefix: number): boolean => prefix - markedPrefix >= AUTO_CACHE_MIN_TOKENS;

  // Whether either marker on the stable prefix landed. The two share one
  // degradation id, because they are one statement about the request.
  let stablePrefixMarked = false;

  // One walk with two checkpoints, rather than three calls that re-sum the
  // tools three times and the system blocks twice. The tiers are nested by
  // construction — the same nesting the `markedPrefix` comparison above relies
  // on — so the cumulative sums and three separate estimates are one number.
  const prefixes = estimateInputPrefixes(req);

  // The default TTL is left implicit on all three: it is the cheapest write,
  // and naming it would send a field the client never asked for.
  const toolsPrefix = prefixes.tools;
  const lastTool = body.tools?.at(-1);
  if (lastTool !== undefined && worthAMarker(toolsPrefix)) {
    lastTool.cache_control = { type: "ephemeral" };
    markedPrefix = toolsPrefix;
    stablePrefixMarked = true;
  }

  // Measured over the IR's system blocks, which is also why the identity line
  // `toWire` injects on the OAuth leg needs no special case: it is not in the
  // IR, so a request whose client sent no system prompt measures this tier at
  // exactly the tools prefix, adds nothing, and takes no marker. A check
  // naming `OAUTH_IDENTITY` would defend against that one string and nothing
  // else shaped like it.
  const systemPrefix = prefixes.toolsAndSystem;
  const lastSystem = body.system?.at(-1);
  if (lastSystem !== undefined && worthAMarker(systemPrefix)) {
    lastSystem.cache_control = { type: "ephemeral" };
    markedPrefix = systemPrefix;
    stablePrefixMarked = true;
  }
  if (stablePrefixMarked) note("anthropic:cache-breakpoint-added");

  if (!worthAMarker(prefixes.total)) return;
  const lastHistory = lastCacheableHistoryBlock(body.messages);
  // A history of nothing but string-content system turns has nowhere to put
  // one. No marker, and nothing recorded: the column says what happened to the
  // request, and here nothing did.
  if (lastHistory === undefined) return;
  lastHistory.cache_control = { type: "ephemeral" };
  // Its own id, because "we cached your tools" and "we cached your entire
  // conversation" are not the same statement to whoever reads the column.
  note("anthropic:history-cache-breakpoint-added");
}

export function toWire(
  req: ChatRequest,
  model: string,
  opts: { oauth: boolean; cloak?: ToolCloak | null; autoCache?: boolean },
): { body: AnthropicBody; degradations: string[] } {
  const cloak = opts.cloak ?? null;
  const degradations: string[] = [];
  // A degradation names something the request lost, not how many times the
  // encoder noticed; the other two encoders dedupe the same way.
  const note = (d: string): void => {
    if (!degradations.includes(d)) degradations.push(d);
  };

  const keptSystem = systemTextBlocks(req.system, "anthropic", note);
  let system =
    req.system === undefined
      ? undefined
      : keptSystem.map((b) => ({
          type: "text" as const,
          text: b.text,
          ...wireCacheControl(b.cacheControl),
        }));

  // The OAuth token endpoint rejects requests whose first system block is not
  // this string. It is a functional requirement of the credential, not a
  // disguise: the User-Agent still identifies this gateway. Recorded as a
  // degradation so it is visible in the request log.
  if (opts.oauth && system?.[0]?.text !== OAUTH_IDENTITY) {
    system = [{ type: "text" as const, text: OAUTH_IDENTITY }, ...(system ?? [])];
    note("anthropic:oauth-system-prefix");
  }

  // The request really does lose something on this leg: the client's chosen
  // tool names. A cloak only exists when at least one name moved, so this is
  // never a warning about nothing.
  if (cloak !== null) note("anthropic:tool-names-cloaked");

  const systemCache = systemCacheControl(req);
  if (systemCache.lost) note("anthropic:system-turn-cache-control-dropped");
  const body: AnthropicBody = {
    model,
    messages: req.messages.flatMap((m): { role: string; content: unknown }[] => {
      if (m.role !== "system") {
        const replayable = m.content.filter(isReplayableThinking);
        if (replayable.length !== m.content.length) note("anthropic:unsigned-thinking-dropped");
        // A turn whose only content was unsignable reasoning has nothing left
        // to say. Anthropic rejects an empty content array, so the message goes
        // rather than being sent as one.
        if (replayable.length === 0) return [];
        return [{ role: m.role, content: replayable.map((b) => encodeBlock(b, cloak)) }];
      }
      return [{ role: m.role, content: encodeSystemTurn(m.content, cloak) }];
    }),
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream,
    ...(systemCache.promoted === undefined
      ? {}
      : {
          cache_control: {
            type: systemCache.promoted.type,
            ...(systemCache.promoted.ttl === undefined ? {} : { ttl: systemCache.promoted.ttl }),
          },
        }),
  };

  if (system !== undefined && system.length > 0) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stopSequences !== undefined) body.stop_sequences = req.stopSequences;
  // Order is preserved: Anthropic places cache breakpoints by position in this
  // array, so reordering the two kinds would move a breakpoint the caller set.
  if (req.tools !== undefined) body.tools = req.tools.map((t) => encodeTool(t, cloak));
  if (req.toolChoice !== undefined) body.tool_choice = encodeToolChoice(req.toolChoice, cloak);
  // After both arrays exist, because it marks the last entry of each of them —
  // and of `body.messages`, which was built above.
  if (opts.autoCache === true) addAutoCacheBreakpoints(body, req, note);
  if (req.reasoning !== undefined) {
    switch (req.reasoning.mode) {
      case "adaptive":
        if (anthropicReasoningForm(model) === "budget") {
          // This model only speaks the older fixed-budget API and rejects the
          // adaptive form outright. Turning thinking off keeps the request
          // working; the one thing not done is inventing a `budget_tokens` from
          // the effort level, which would be a number no client ever asked for.
          body.thinking = { type: "disabled" };
          note("anthropic:adaptive-thinking-unsupported");
          break;
        }
        body.thinking = {
          type: "adaptive",
          ...(req.reasoning.display === undefined ? {} : { display: req.reasoning.display }),
        };
        // Depth is an output-level control here, not a thinking-level one.
        if (req.reasoning.effort !== undefined) {
          body.output_config = {
            ...(isRecord(body.output_config) ? body.output_config : {}),
            effort: req.reasoning.effort,
          };
        }
        break;
      case "budget":
        // Only ever sent because a client asked for it by name. Current models
        // reject this form, so it is never synthesized from an effort level.
        body.thinking = { type: "enabled", budget_tokens: req.reasoning.budgetTokens };
        break;
      case "off":
        body.thinking = { type: "disabled" };
        break;
    }
  }

  // Vendor passthrough is applied last: an operator setting a raw Anthropic
  // field is stating an explicit intent that outranks our mapping.
  const vendor = req.vendor?.anthropic ?? {};
  Object.assign(
    body,
    anthropicReasoningForm(model) === "budget" ? withoutEffort(vendor, note) : vendor,
  );
  stripUnsupportedEdits(body, note);

  return { body, degradations };
}
