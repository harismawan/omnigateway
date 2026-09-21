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
/**
 * What the client asked for, and — when nothing usable came back — why.
 *
 * One reader rather than a predicate beside it: "asked and we refused" and
 * "never asked" are different facts, and an encoder deciding between them from a
 * second walk of the same three spellings gets a *guess*. It cannot tell a
 * schema too deep to send from one whose discriminator was misspelled, so it
 * reported both as too deep — and the second walk drifted from the first the
 * moment either changed.
 *
 * `malformed` and `absent` are deliberately not distinguished by callers today:
 * a malformed field is left to the backend to refuse, exactly as it was before
 * any of this existed. Only `tooDeep` is ours to report.
 */
export type ResponseFormatRead =
  | { kind: "absent" }
  | { kind: "malformed" }
  | { kind: "tooDeep" }
  | { kind: "readable"; format: ResponseFormat };

export function readResponseFormatResult(req: ChatRequest): ResponseFormatRead {
  const openai = req.vendor?.openai;
  // Each spelling is read at the depth its own surface defines: the chat one
  // wraps the schema in `json_schema`, the other two carry it flat. Checking a
  // specific path rather than sniffing for a `schema` key anywhere keeps an
  // unrelated vendor field that happens to contain one from being read as this.
  const chat = openai?.response_format;
  if (chat !== undefined) {
    if (!isRecord(chat) || chat.type !== "json_schema") return { kind: "malformed" };
    return fromSpec(chat.json_schema);
  }
  const responses = openai?.text;
  if (isRecord(responses) && responses.format !== undefined) return fromSpec(responses.format);
  if (responses !== undefined) return { kind: "malformed" };
  const messages = req.vendor?.anthropic?.output_config;
  if (isRecord(messages) && messages.format !== undefined) return fromSpec(messages.format);
  if (messages !== undefined) return { kind: "malformed" };
  return { kind: "absent" };
}

/** The readable format alone, for the callers that have nothing to report. */
export function readResponseFormat(req: ChatRequest): ResponseFormat | undefined {
  const read = readResponseFormatResult(req);
  return read.kind === "readable" ? read.format : undefined;
}

/**
 * Whether a native format is one this gateway can read.
 *
 * The single definition of "readable", because two places ask it — `fromSpec`,
 * deciding whether to translate, and `moveToResponsesText`, deciding whether the
 * client's own spelling outranks a translation. A record is not enough: a wrong
 * discriminator or a missing schema is a field the backend cannot answer, and
 * letting one of those outrank a valid spelling loses the schema silently.
 *
 * Structural only. Depth is `fromSpec`'s question, because a schema the codec
 * cannot serialize is unsendable whoever wrote it — so a caller using this to
 * decide that a native field may stay must ask about depth separately.
 */
export function readableFormat(spec: unknown): spec is Record<string, unknown> {
  return (
    isRecord(spec) &&
    (spec.type === undefined || spec.type === "json_schema") &&
    isRecord(spec.schema)
  );
}

/**
 * Whether a value can be serialized to JSON without throwing.
 *
 * Traverses unique objects iteratively with a seen set so a shared-node DAG does
 * not expand exponentially. Catches in-memory values from plugins that cannot be
 * represented in JSON (BigInt, objects with hostile `toJSON` hooks).
 */
export function canSerialize(value: unknown): boolean {
  if (typeof value === "bigint") return false;
  if (typeof value !== "object" || value === null) return true;
  const seen = new WeakSet<object>();
  const stack: object[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (seen.has(node)) continue;
    seen.add(node);
    if (typeof (node as { toJSON?: unknown }).toJSON === "function") {
      try {
        const res = (node as { toJSON: () => unknown }).toJSON();
        if (typeof res === "bigint") return false;
      } catch {
        return false;
      }
    }
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const val of values) {
      if (typeof val === "bigint") return false;
      if (typeof val === "object" && val !== null) {
        stack.push(val);
      }
    }
  }
  return true;
}

/** The `{type?, name?, schema}` leaf all three spellings share. */
function fromSpec(spec: unknown): ResponseFormatRead {
  if (!readableFormat(spec)) return { kind: "malformed" };
  const schema = spec.schema;
  if (!isRecord(schema)) return { kind: "malformed" };
  // A schema nested past the walker's cap cannot be serialized either: every
  // codec renders its body with `JSON.stringify`, which recurses as far as the
  // schema does and throws. A cycle or an in-memory BigInt / hostile `toJSON` is
  // the same refusal: `JSON.stringify` rejects it outright, at any depth.
  // Refusing them here — at the one gate all three spellings pass through —
  // turns an unsendable request into a dropped field on every target, rather
  // than a throw on some of them.
  // `isCyclic` and `tooDeepToSerialize` run first to guarantee depth is bounded
  // before `canSerialize` safely invokes `JSON.stringify`.
  if (isCyclic(schema) || tooDeepToSerialize(schema) || !canSerialize(schema)) {
    return { kind: "tooDeep" };
  }
  return {
    kind: "readable",
    format: {
      schema,
      name: typeof spec.name === "string" && spec.name.length > 0 ? spec.name : "response",
    },
  };
}

/**
 * Every subschema member of `nodes`, in one place because three walks ask it.
 *
 * Sharing the enumeration is what keeps them from drifting: a position added to
 * the tables reaches the depth walk, the cycle check and the closer together,
 * and the two depth rules disagreeing by one position is a bug this file has
 * already shipped once.
 */
function forEachSubschema(
  nodes: readonly Record<string, unknown>[],
  visit: (member: Record<string, unknown>, parent: Record<string, unknown>) => void,
): void {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if ((SUBSCHEMA_MAP as readonly string[]).includes(key) && isRecord(value)) {
        for (const member of Object.values(value)) if (isRecord(member)) visit(member, node);
      } else if ((SUBSCHEMA_LIST as readonly string[]).includes(key) && Array.isArray(value)) {
        for (const member of value) if (isRecord(member)) visit(member, node);
      } else if ((SUBSCHEMA as readonly string[]).includes(key) && isRecord(value)) {
        visit(value, node);
      }
    }
  }
}

/**
 * Whether a schema reaches itself.
 *
 * A separate question from depth, and not one the depth walk can answer: that
 * walk skips a node it has already seen, which is correct for a second path
 * *to* a node and hides a path *through* it, so a cycle reads as "shallow
 * enough to send". It is not sendable at any depth — `JSON.stringify` refuses a
 * cyclic structure outright rather than running out of stack, so every codec
 * throws on a body carrying one. JSON cannot express a cycle, but the IR is also
 * built in-process by plugins.
 *
 * Traverses every enumerable object and array — not only recognized subschema
 * positions — because `JSON.stringify` serializes annotations (`default`,
 * `examples`, `enum`) and extension keywords too, and a back-edge through any of
 * them crashes the codec just as surely.
 *
 * Depth-first with the path as a set, so the answer is exact rather than a
 * budget: only nodes on the current path are held, never the whole schema.
 */
function isCyclic(schema: Record<string, unknown>): boolean {
  const onPath = new Set<object>();
  const done = new WeakSet<object>();
  const stack: { node: object; entering: boolean }[] = [{ node: schema, entering: true }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    if (!frame.entering) {
      onPath.delete(node);
      done.add(node);
      continue;
    }
    if (onPath.has(node)) return true;
    if (done.has(node)) continue;
    onPath.add(node);
    stack.push({ node, entering: false });
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === "object" && item !== null) {
          stack.push({ node: item, entering: true });
        }
      }
    } else {
      for (const val of Object.values(node)) {
        if (typeof val === "object" && val !== null) {
          stack.push({ node: val, entering: true });
        }
      }
    }
  }
  return false;
}

/**
 * Whether a schema nests deeper than {@link MAX_DEPTH} schema levels.
 *
 * Walks the same positions as {@link closeNode}, one level per iteration, so
 * the two refuse at the same boundary. Iterative on purpose: a schema with
 * thousands of levels must not overflow the JavaScript call stack.
 *
 * Deduplicates per level rather than globally: a global seen set would record
 * a shared node at its shallowest path and miss a deeper path through the same
 * node, disagreeing with {@link closeNode}. Deduplicating per level keeps
 * diamond DAGs from expanding exponentially (at most |V| nodes per level,
 * bounded by {@link MAX_DEPTH} iterations) while correctly measuring the
 * longest path to every leaf.
 */
function tooDeepToSerialize(schema: Record<string, unknown>): boolean {
  let level: Record<string, unknown>[] = [schema];
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const next: Record<string, unknown>[] = [];
    const seenThisLevel = new WeakSet<Record<string, unknown>>();
    forEachSubschema(level, (member) => {
      if (seenThisLevel.has(member)) return;
      seenThisLevel.add(member);
      next.push(member);
    });
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
  // Only a format this gateway can *send* outranks, which is a stricter question
  // than `readableFormat` answers: a structurally valid schema nested past the
  // cap is one `JSON.stringify` cannot render, so leaving it here would put an
  // unserializable body on the wire — and a malformed one would silently bury
  // the valid `response_format` the same request carried.
  const read = readResponseFormatResult(req);
  const clientText = isRecord(body.text) ? body.text : undefined;
  const clientFormat = clientText?.format;
  // `readResponseFormatResult` reads the chat spelling first, so a request
  // carrying both lands on the translation and only a request carrying this one
  // alone returns `readable` from it — which is exactly when the client's own
  // field may stay.
  if (readableFormat(clientFormat) && read.kind === "readable") return undefined;
  const malformedFormat = clientText !== undefined && clientFormat !== undefined;
  // Copied rather than edited: this object is the caller's own
  // `req.vendor.openai.text`, carried here by a shallow merge, and the IR is
  // shared across dispatch retries. Deleting from it would mutate the request
  // every later attempt reads — and throw outright on a frozen one.
  const text = clientText === undefined ? undefined : { ...clientText };
  if (text !== undefined) delete text.format;
  if (malformedFormat) body.text = text;

  // Read from the request, not from `raw`: a `/v1/messages` client's schema
  // never touches this body, and it needs translating just the same.
  if (read.kind === "readable") {
    const format = read.format;
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
  // A schema the codec cannot serialize is refused by the reader, and that is
  // ours to report on every target — including one whose vendor bag never
  // carried the spelling it arrived in, where nothing above would have noticed.
  if (read.kind === "tooDeep") return `${provider}:response-schema-too-deep`;
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
  // The memo is per call: it holds output objects for this walk alone.
  return closeNode(schema, 0, stats ?? { changed: false, truncated: false }, new Map());
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
  memo: Map<number, WeakMap<Record<string, unknown>, Record<string, unknown>>>,
): Record<string, unknown> {
  if (depth >= MAX_DEPTH) {
    stats.truncated = true;
    return schema;
  }
  // Keyed on depth as well as identity: the same node reached lower down has
  // less budget left and may truncate where the shallower visit did not. Without
  // this, one object sitting at several positions is cloned once per path, which
  // is exponential in the number of shared edges — a 22-node schema took nearly
  // a second. JSON cannot express sharing, but the IR is also built in-process.
  let atDepth = memo.get(depth);
  if (atDepth === undefined) {
    atDepth = new WeakMap();
    memo.set(depth, atDepth);
  }
  const done = atDepth.get(schema);
  if (done !== undefined) return done;
  const out: Record<string, unknown> = {};
  atDepth.set(schema, out);
  for (const [key, value] of Object.entries(schema)) {
    if ((SUBSCHEMA_MAP as readonly string[]).includes(key) && isRecord(value)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(value)) {
        // `defineProperty`, because a schema parsed from JSON may hold a member
        // named `__proto__`, and plain assignment would invoke the setter and
        // drop the property instead of carrying it.
        Object.defineProperty(members, name, {
          value: isRecord(member) ? closeNode(member, depth + 1, stats, memo) : member,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      out[key] = members;
      continue;
    }
    if ((SUBSCHEMA as readonly string[]).includes(key) && isRecord(value)) {
      out[key] = closeNode(value, depth + 1, stats, memo);
      continue;
    }
    if ((SUBSCHEMA_LIST as readonly string[]).includes(key) && Array.isArray(value)) {
      out[key] = value.map((arm) => (isRecord(arm) ? closeNode(arm, depth + 1, stats, memo) : arm));
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
