import type { ChatRequest } from "@omni/ir";

/**
 * The structured-output request a client made, in whichever of the three
 * spellings its surface produces.
 *
 * None of the three is a field an ingress names, so each arrives in the vendor
 * bag named after the *surface* — `/v1/chat/completions` and `/v1/responses`
 * both write `vendor.openai`, `/v1/messages` writes `vendor.anthropic` — and is
 * then merged by whichever encoder reads that bag. That merge is the whole
 * mechanism, and it was wrong in three different ways at once: the Responses API
 * calls the field `text.format` and answers `Unsupported parameter:
 * response_format` to the verbatim copy; Anthropic calls it
 * `output_config.format` and answers `Extra inputs are not permitted`; Gemini
 * calls it `generationConfig.responseSchema` and never sees the bag at all.
 * Measured 2026-09-21 against all three live backends.
 *
 * One reader here rather than a copy per encoder: the field is a *request for a
 * guarantee*, and an encoder that cannot express it has to say so rather than
 * drop it, which is a decision each provider makes about the same parsed value.
 */
export type ResponseFormat = {
  /** The schema itself, as the client wrote it. */
  schema: Record<string, unknown>;
  /** The client's name for it, which two of the three surfaces require. */
  name: string;
};

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads a structured-output request in whichever spelling the client used.
 *
 * Three surfaces, three native spellings, and a request routed to a provider of
 * a different dialect loses the field unless all three are read here:
 * `/v1/chat/completions` produces `response_format`, `/v1/responses` produces
 * `text.format`, and `/v1/messages` produces `output_config.format`. Each lands
 * in the bag named after the *surface*, so both Responses-shaped ingresses write
 * `vendor.openai` and only the Anthropic one writes `vendor.anthropic`.
 *
 * `json_object` — the older, schemaless spelling — is deliberately not handled:
 * it asks for "valid JSON, shape unspecified", which two of these providers
 * express only by being handed a schema. Returning `undefined` leaves it to the
 * bag merge that carries it today, so an OpenAI-compatible target keeps
 * honouring it and nothing else pretends to.
 *
 * Nothing here throws. A malformed field reaching an encoder means ingress
 * already accepted it, and failing the request at encode time would turn a
 * field the gateway used to ignore into a hard error.
 */
export function readResponseFormat(req: ChatRequest): ResponseFormat | undefined {
  const openai = req.vendor?.openai;
  // Each spelling is read at the depth its own surface defines: the chat one
  // wraps the schema in `json_schema`, the other two carry it flat. Checking a
  // specific path rather than sniffing for a `schema` key anywhere keeps an
  // unrelated vendor field that happens to contain one from being read as this.
  const chat = openai?.response_format;
  if (chat !== undefined) {
    if (!isRecord(chat) || chat.type !== "json_schema") return undefined;
    return fromSpec(chat.json_schema);
  }
  const responses = openai?.text;
  if (responses !== undefined) return isRecord(responses) ? fromSpec(responses.format) : undefined;
  const messages = req.vendor?.anthropic?.output_config;
  if (messages !== undefined) return isRecord(messages) ? fromSpec(messages.format) : undefined;
  return undefined;
}

/**
 * Whether the client asked for a schema at all, in any of the three spellings.
 *
 * Separate from {@link readResponseFormat} because "asked and we refused" and
 * "never asked" are different facts, and only the first one is a degradation. An
 * encoder that reports every empty read would claim a loss on every plain
 * request.
 */
export function requestsResponseFormat(req: ChatRequest): boolean {
  const openai = req.vendor?.openai;
  if (isRecord(openai?.response_format)) return true;
  if (isRecord(openai?.text) && openai.text.format !== undefined) return true;
  const messages = req.vendor?.anthropic?.output_config;
  return isRecord(messages) && messages.format !== undefined;
}

/**
 * Whether a native format is one this gateway can read.
 *
 * The single definition of "readable", because two places ask it — `fromSpec`,
 * deciding whether to translate, and `moveToResponsesText`, deciding whether the
 * client's own spelling outranks a translation. A record is not enough: a wrong
 * discriminator or a missing schema is a field the backend cannot answer, and
 * letting one of those outrank a valid spelling loses the schema silently.
 */
export function readableFormat(spec: unknown): spec is Record<string, unknown> {
  return (
    isRecord(spec) &&
    (spec.type === undefined || spec.type === "json_schema") &&
    isRecord(spec.schema)
  );
}

/** The `{type?, name?, schema}` leaf all three spellings share. */
function fromSpec(spec: unknown): ResponseFormat | undefined {
  if (!readableFormat(spec)) return undefined;
  const schema = spec.schema;
  if (!isRecord(schema)) return undefined;
  // A schema nested past the walker's cap cannot be serialized either: every
  // codec renders its body with `JSON.stringify`, which recurses as far as the
  // schema does and throws. Refusing it here — at the one gate all three
  // spellings pass through — turns an unsendable request into a dropped field
  // on every target, rather than a stack overflow on some of them.
  if (tooDeepToSerialize(schema)) return undefined;
  return {
    schema,
    name: typeof spec.name === "string" && spec.name.length > 0 ? spec.name : "response",
  };
}

/**
 * Whether a schema nests deeper than {@link MAX_DEPTH} schema levels.
 *
 * Walks the same positions as {@link closeNode}, one level per iteration, so the
 * two refuse at the same boundary. An earlier version counted raw object levels
 * and converted with a constant, which held only for positions that cross a
 * container before the child (`properties`, `anyOf`): a single-subschema
 * position like `items` crosses one level per schema level, so a schema nested
 * through it was read at twice the depth the walker would close — accepted here
 * and then sent half-closed, the exact 400 this cap exists to prevent. There is
 * no multiplier that fits both shapes; the units have to be the same.
 *
 * Iterative on purpose: the question is whether recursion would overflow, so
 * asking it recursively would overflow first.
 */
function tooDeepToSerialize(schema: Record<string, unknown>): boolean {
  let level: Record<string, unknown>[] = [schema];
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next: Record<string, unknown>[] = [];
    for (const node of level) {
      for (const [key, value] of Object.entries(node)) {
        if ((SUBSCHEMA_MAP as readonly string[]).includes(key) && isRecord(value)) {
          for (const member of Object.values(value)) if (isRecord(member)) next.push(member);
        } else if ((SUBSCHEMA_LIST as readonly string[]).includes(key) && Array.isArray(value)) {
          for (const member of value) if (isRecord(member)) next.push(member);
        } else if ((SUBSCHEMA as readonly string[]).includes(key) && isRecord(value)) {
          next.push(value);
        }
      }
    }
    if (next.length === 0) return false;
    level = next;
  }
  return true;
}

/**
 * Moves a structured-output request onto a Responses-shaped body.
 *
 * The three Responses backends share one problem: the vendor merge hands them
 * `response_format`, which they answer `Unsupported parameter: response_format`
 * to (measured 2026-09-21), while their own field is `text.format`. One helper
 * rather than three copies, because three copies already drifted once.
 *
 * `json_object` is carried across too. It has no schema for `readResponseFormat`
 * to return, but leaving it behind means leaving the field that fails the
 * request — so the schemaless spelling is translated to the schemaless
 * `text.format` this API defines.
 *
 * Returns the degradation to record, or `undefined` when there was nothing to do.
 */
export function moveToResponsesText(
  req: ChatRequest,
  body: Record<string, unknown>,
  provider: string,
): string | undefined {
  // The Chat Completions spelling, if the merge carried one in. Removed
  // unconditionally: whatever happens below, leaving it is leaving the field
  // that fails the request.
  const raw = body.response_format;
  delete body.response_format;

  // A `text` that is not an object is not a field this API defines either, so
  // it goes the same way — and is reported, since the client did send it.
  const malformedText = body.text !== undefined && !isRecord(body.text);
  if (malformedText) delete body.text;

  // The client's own `text.format` is this surface's native spelling and
  // outranks a translation. A `text` carrying anything else — `verbosity`, say —
  // is not a format, so the format joins it rather than replacing it.
  //
  // Only a *readable* native format outranks, and readable means what
  // `readResponseFormat` means by it: a record alone is not enough, since
  // `{type: "wrong"}` or `{schema: null}` is a field this API cannot answer any
  // more than `null` is. Anything less would let a malformed native spelling
  // silently bury the valid `response_format` the same request carried.
  const clientText = isRecord(body.text) ? body.text : undefined;
  if (readableFormat(clientText?.format)) return undefined;
  const malformedFormat = clientText !== undefined && clientText.format !== undefined;
  // Copied rather than edited: this object is the caller's own
  // `req.vendor.openai.text`, carried here by a shallow merge, and the IR is
  // shared across dispatch retries. Deleting from it would mutate the request
  // every later attempt reads — and throw outright on a frozen one.
  const text = clientText === undefined ? undefined : { ...clientText };
  if (text !== undefined) delete text.format;
  if (malformedFormat) body.text = text;

  // Read from the request, not from `raw`: a `/v1/messages` client's schema
  // never touches this body, and it needs translating just the same.
  const format = readResponseFormat(req);
  if (format !== undefined) {
    body.text = {
      ...text,
      format: { type: "json_schema", name: format.name, schema: format.schema, strict: true },
    };
    return `${provider}:response-format-translated`;
  }
  // No schema to carry. `json_object` still has a meaning here; anything else
  // was malformed, and dropping it is what the gateway did before — but now it
  // says so.
  if (isRecord(raw) && raw.type === "json_object") {
    body.text = { ...text, format: { type: "json_object" } };
    return `${provider}:response-format-translated`;
  }
  // Nothing readable was requested. Report only if something was actually
  // removed: a request that never asked for structured output must not be
  // logged as having lost it.
  if (raw !== undefined || malformedText || malformedFormat) {
    return `${provider}:response-format-dropped`;
  }
  return undefined;
}

/**
 * The same schema with `additionalProperties: false` on every object node.
 *
 * Anthropic refuses a schema without it — `For 'object' type,
 * 'additionalProperties' must be explicitly set to false` — at every level, not
 * just the root, and a client that wrote `strict: true` has already asked for
 * exactly this. Gemini requires nothing of the sort, so this runs only on the
 * Anthropic path.
 *
 * Applied wherever a schema reaches `output_config`, translated or native:
 * `anthropic/wire.ts` calls it after its vendor merge, because a client already
 * speaking that surface arrives by the merge and its schema is subject to the
 * same backend rule. A tool's `input_schema` is untouched — measured, the same
 * backend accepts those open.
 *
 * Walks only the positions that hold schemas, for the reason `pruneSchema` does:
 * `properties` may contain a member *named* `items`, and a walk that recursed by
 * name would rewrite data.
 *
 * `additionalProperties: true` is replaced rather than preserved. The backend
 * answers `'additionalProperties: true' is not supported` to it, so honouring
 * the client's word there is honouring it into a 400 — the one case where the
 * client's explicit value cannot stand.
 *
 * `stats` reports what happened, so a caller can record a degradation without
 * walking the result again: comparing input to output with `JSON.stringify`
 * recurses as deeply as the schema nests and overflows the very stack the depth
 * cap below exists to protect.
 */
export function closeObjects(
  schema: Record<string, unknown>,
  stats?: { changed: boolean; truncated: boolean },
): Record<string, unknown> {
  // Reset rather than accumulate: the out-param answers "what happened to THIS
  // schema", and a caller reusing one object across two schemas would otherwise
  // read the first one's verdict and record a degradation for the second.
  if (stats !== undefined) {
    stats.changed = false;
    stats.truncated = false;
  }
  return closeNode(schema, 0, stats ?? { changed: false, truncated: false });
}

/**
 * Positions holding a single subschema.
 *
 * `additionalProperties` is here as well as being forced below: a client may
 * give it a schema rather than a boolean, and that schema's own object nodes
 * still need closing.
 */
const SUBSCHEMA = [
  "items",
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "if",
  "then",
  "else",
  "not",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

/**
 * Positions holding an array of subschemas.
 *
 * `items` is in both tables: 2020-12 gives it one schema, draft-07 gives it a
 * tuple, and which arrives is the client's choice.
 */
const SUBSCHEMA_LIST = ["anyOf", "allOf", "oneOf", "prefixItems", "items"] as const;

/**
 * Positions holding a map of name to subschema.
 *
 * `dependencies` is draft-07 and holds either a subschema or an array of
 * property names; `isRecord` takes the first and leaves the second alone.
 */
const SUBSCHEMA_MAP = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies",
] as const;

/**
 * A schema can nest arbitrarily and arrives from the network, so the depth is
 * capped rather than trusted: recursion deep enough to overflow the stack would
 * turn a request ingress accepted into a crash.
 *
 * The cap is the same for reading and for closing, because it answers one
 * question — whether `JSON.stringify` in the codec can render this body at all.
 * `fromSpec` refuses a schema past it, so a truncated walk is the narrow case of
 * a schema that arrived already on the body through a vendor bag; the caller
 * drops the field and records it. Cloud Code's own schema limit is 24, so 64 is
 * already past every schema the strictest of these backends will read.
 */
const MAX_DEPTH = 64;

function closeNode(
  schema: Record<string, unknown>,
  depth: number,
  stats: { changed: boolean; truncated: boolean },
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) {
    stats.truncated = true;
    return schema;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((SUBSCHEMA_MAP as readonly string[]).includes(key) && isRecord(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        // `defineProperty`, because a schema parsed from JSON may hold a member
        // named `__proto__`, and plain assignment would invoke the setter and
        // drop the property instead of carrying it.
        Object.defineProperty(members, name, {
          value: isRecord(member) ? closeNode(member, depth + 1, stats) : member,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      out[key] = members;
      continue;
    }
    if ((SUBSCHEMA as readonly string[]).includes(key) && isRecord(value)) {
      out[key] = closeNode(value, depth + 1, stats);
      continue;
    }
    if ((SUBSCHEMA_LIST as readonly string[]).includes(key) && Array.isArray(value)) {
      out[key] = value.map((arm) => (isRecord(arm) ? closeNode(arm, depth + 1, stats) : arm));
      continue;
    }
    out[key] = value;
  }
  // After the walk, so a schema-valued `additionalProperties` rewritten above is
  // read back here: a schema is not `false`, and the backend wants `false`.
  if (out.type === "object" && out.additionalProperties !== false) {
    out.additionalProperties = false;
    stats.changed = true;
  }
  return out;
}
