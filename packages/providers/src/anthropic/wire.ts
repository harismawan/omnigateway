import type { CacheControl, ChatRequest, ContentBlock, ToolChoice, ToolDef } from "@omni/ir";
import { cacheControlOf, estimateCachedInputTokens, estimateInputTokens } from "@omni/ir";
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
    case "anthropicNative":
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
  if (t.provider === "anthropic") {
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
 * One constant rather than a table per model: the real minimum is larger for
 * Haiku than for Opus and Sonnet, but the estimator is nowhere near accurate
 * enough for that difference to be meaningful, so this takes the smaller of the
 * published values. Rounding down is the right direction — the cost of being
 * wrong is a marker Anthropic ignores, not a request that fails.
 *
 * The estimator over-counts (a flat 1600 per image, four tokens of overhead per
 * block, the full schema text of every tool), so the error runs the same way:
 * a prompt that squeaks past this gate and turns out to be too small is simply
 * ignored upstream. The opposite error — skipping a prompt that would have
 * cached — needs an *under*-count, which this estimator does not produce.
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
 * Adds the breakpoint a client omitted, when the operator asked us to.
 *
 * Caching at Anthropic is opt-in: an unmarked request is billed as fresh input
 * every time, however stable its prefix. A client that never marks one pays
 * full price to resend a prompt verbatim.
 *
 * Three things make this safe to do on the caller's behalf:
 *
 * - It runs **only** when the request carries no breakpoint anywhere.
 *   `estimateCachedInputTokens` returns zero in exactly that case — every
 *   marked block adds a strictly positive count before it records one — and
 *   `hasVendorCacheControl` covers the one marker that never reaches the IR.
 *   So a client that placed its own is never second-guessed, and nothing can be
 *   pushed past Anthropic's four-breakpoint ceiling into a 400.
 * - It writes to the **wire body**, whose arrays this function just built, and
 *   never to `req`. The IR is one shared object across every attempt, so a
 *   breakpoint written there would follow a failover into another provider and
 *   into what RTK and the token estimate believe the caller sent.
 * - It marks the last *system* block, or failing that the last tool — never
 *   message content, which would reach `systemCacheControl`'s promotion path
 *   and either move the marker to the top level or report a client marker as
 *   dropped. Render order is tools, then system, then messages, so a breakpoint
 *   after system covers the whole stable prefix and excludes the volatile turn.
 */
function addAutoCacheBreakpoint(
  body: AnthropicBody,
  req: ChatRequest,
  note: (d: string) => void,
): void {
  if (estimateCachedInputTokens(req) !== 0 || hasVendorCacheControl(req)) return;
  // Measured over the prefix this breakpoint would actually cache — tools and
  // system — and deliberately not over the whole request. A long conversation
  // under a two-line system prompt is an ordinary agent session, and counting
  // its messages here would wave through a prefix far too small to cache,
  // recording a change that bought nothing.
  if (estimateInputTokens({ ...req, messages: [] }) < AUTO_CACHE_MIN_TOKENS) return;

  const target = body.system?.at(-1) ?? body.tools?.at(-1);
  if (target === undefined) return;

  // The default TTL, left implicit: it is the cheapest write, and naming it
  // would send a field the client never asked for.
  target.cache_control = { type: "ephemeral" };
  note("anthropic:cache-breakpoint-added");
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

  let system = req.system?.flatMap((b) =>
    b.type === "text"
      ? [{ type: "text" as const, text: b.text, ...wireCacheControl(b.cacheControl) }]
      : [],
  );

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
  // After both arrays exist, because it marks the last entry of one of them.
  if (opts.autoCache === true) addAutoCacheBreakpoint(body, req, note);
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
