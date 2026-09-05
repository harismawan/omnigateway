import type { ChatRequest, ContentBlock, ToolChoice } from "@omni/ir";
import { systemText } from "../system.ts";
import { cloakName, type ToolCloak } from "./cloak.ts";
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
 * A history that may not open on a tool exchange.
 *
 * **Cloud Code requires a function call to follow a user turn or a function
 * response, and a function response to follow a call** — `Please ensure that
 * function call turn comes immediately after a user turn …`. Only the *opening*
 * entry can break it: measured 2026-09-05, a conversation starting with a model
 * turn and one starting with a function response are each a 400, while an
 * orphan response later in the history is fine, because `mergeSameRole` has
 * already folded it into the user turn beside it.
 *
 * That is precisely the shape a client which trims history sends, so it is
 * repaired rather than refused. An **empty** leading user turn is what the
 * upstream accepts (verified against both failing shapes) and it invents no
 * words — a placeholder like "(continued)" would put text in the prompt the
 * client never wrote, and the model would read it.
 */
function openingTurn(contents: Content[], note: (d: string) => void): Content[] {
  const first = contents[0];
  if (first === undefined) return contents;
  const opensOnTool =
    first.role === "model" ||
    (first.parts[0] !== undefined && "functionResponse" in first.parts[0]);
  if (!opensOnTool) return contents;
  note("antigravity:opening-turn-added");
  return [{ role: "user", parts: [{ text: "" }] }, ...contents];
}

/**
 * A history that may not end on a model turn.
 *
 * **`Requests ending with a model turn are not supported.`** — measured
 * 2026-09-05, and reachable from an ordinary feature rather than a malformed
 * request: an Anthropic client prefills the answer by sending a trailing
 * assistant turn for the model to continue from.
 *
 * The prefill is **kept** and a trailing user turn added after it, so the model
 * still reads its own partial answer as context. Dropping the turn instead also
 * runs (measured) and throws away the thing the client asked for.
 *
 * The added turn holds a **single space, not the empty string** `openingTurn`
 * uses. That asymmetry is measured and not a preference: a trailing user turn
 * whose only part is `{ text: "" }` is still refused with the same message,
 * where `{ text: " " }` is accepted. A leading empty turn is accepted, so each
 * repair uses the least it can.
 */
function closingTurn(contents: Content[], note: (d: string) => void): Content[] {
  if (contents[contents.length - 1]?.role !== "model") return contents;
  note("antigravity:closing-turn-added");
  return [...contents, { role: "user", parts: [{ text: " " }] }];
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

/** Recorded once per tool set, for any keyword or shape this drops. */
const PRUNED = "antigravity:tool-schema-pruned";

/** `the number of stop_sequences must not exceed 5`, measured. */
const MAX_STOP_SEQUENCES = 5;

/**
 * `thinking_budget must be in the range [-1, 65535]`, measured.
 *
 * One below `MAX_OUTPUT_TOKENS`, which is what makes the "raise the ceiling
 * above the budget" repair below reachable at the top of the range.
 */
const MAX_THINKING_BUDGET = 65_535;

/**
 * How a `Schema` field's *value* is checked, once its name is known to be one.
 *
 * **Naming a field is not accepting any value under it**, and this is the
 * second error class the upstream has — `Invalid value at '…value.pattern'
 * (TYPE_STRING), 5`, which no amount of keyword filtering can see. Measured
 * live on 2026-09-05 across 32 wrong-typed shapes: protobuf-JSON is lenient
 * where a JSON string can be read as a number (`minLength: "1"` is fine) and
 * strict everywhere else (`minLength: 1.5`, `pattern: 5`, `enum: [5]`,
 * `title: {}` are each a 400).
 *
 * `enum` is the one that matters in practice: any numeric or boolean literal
 * union — `Literal[1, 2]`, `z.union([z.literal(1), …])` — exports as
 * `enum: [1, 2]` into a `repeated string`.
 */
type FieldKind = "walked" | "text" | "texts" | "int" | "double" | "free";

/**
 * A scalar field's value, or `undefined` when the proto would refuse it.
 *
 * A `texts` field keeps its usable members rather than going whole: an
 * eight-member enum with one number in it still constrains the model seven
 * ways, and dropping the constraint entirely is the larger loss.
 */
function scalarValue(kind: FieldKind, value: unknown): unknown {
  const numeric = (v: unknown, whole: boolean): boolean => {
    if (typeof v === "number") return Number.isFinite(v) && (!whole || Number.isInteger(v));
    if (typeof v !== "string") return false;
    // An int64 arrives as a JSON string of plain decimal digits — `"1e3"` is
    // refused even though it reads as a whole number, so this is a spelling
    // test and not `Number.isInteger(Number(v))`.
    if (whole) return /^-?\d+$/.test(v);
    return v.trim().length > 0 && Number.isFinite(Number(v));
  };
  switch (kind) {
    case "free":
      return value;
    case "text":
      return typeof value === "string" ? value : undefined;
    case "texts": {
      // A lone value in a repeated field is accepted by protobuf-JSON.
      if (typeof value === "string") return value;
      if (!Array.isArray(value)) return undefined;
      const members = (value as unknown[]).filter((m): m is string => typeof m === "string");
      return members.length === 0 ? undefined : members;
    }
    case "int":
      return numeric(value, true) ? value : undefined;
    case "double":
      return numeric(value, false) ? value : undefined;
    case "walked":
      return value;
  }
}

/**
 * The field names Gemini's `Schema` message declares.
 *
 * **`v1internal` parses a tool's `parameters` as a proto message, not as JSON
 * Schema, so an unknown keyword is a hard 400** — the same
 * `Invalid JSON payload received. Unknown name "…": Cannot find field.` the
 * envelope refuses an unknown top-level key with. Measured 2026-09-05: an
 * ordinary Claude Code tool set produced 41 of them, on `$schema` (once per
 * tool, emitted by every zod/pydantic exporter), `propertyNames`,
 * `exclusiveMinimum` and `const`.
 *
 * An allowlist rather than a denylist of those four, because the denylist is
 * only ever as long as the last payload that failed: `$ref`, `oneOf`, `not`,
 * `multipleOf`, `uniqueItems`, `$defs` and the rest are all still out there.
 * Failing this way round is also the cheap direction — a dropped constraint is
 * advisory to the model, a kept unknown one is a request that never runs.
 *
 * The set is `google.cloud.aiplatform…Schema`'s published field list — the
 * message the 400 names — plus `allOf`, which it does not publish. `allOf`,
 * `anyOf` and `additionalProperties` are all here on the same evidence, and it
 * is the strong kind: each was **present in the request that answered 200**,
 * not merely absent from an error list.
 *
 * `$ref`/`$defs` are published fields but are **left out and so dropped, not
 * resolved**: nothing this gateway has seen emits them into a tool schema, and
 * a resolver is a lot of code to carry on speculation. A schema that ever
 * arrives with one loses that subtree, which the degradation says.
 *
 * Naming a field here is not the same as accepting any value under it: several
 * of these are singular or scalar in the proto where JSON Schema allows an
 * array, so `pruneSchema` checks the shapes it can reach. Measurements and the
 * failing payloads: `docs/superpowers/specs/2026-09-05-antigravity-provider-design.md`.
 */
const SCHEMA_FIELDS: ReadonlyMap<string, FieldKind> = new Map<string, FieldKind>([
  // Walked by the switch below.
  ["type", "walked"],
  ["items", "walked"],
  ["properties", "walked"],
  ["anyOf", "walked"],
  ["allOf", "walked"],
  ["additionalProperties", "walked"],
  // `TYPE_STRING`.
  ["format", "text"],
  ["title", "text"],
  ["description", "text"],
  ["pattern", "text"],
  // `repeated string`.
  ["enum", "texts"],
  ["required", "texts"],
  ["propertyOrdering", "texts"],
  // `TYPE_INT64` — a JSON string is accepted, a fractional number is not.
  ["minItems", "int"],
  ["maxItems", "int"],
  ["minLength", "int"],
  ["maxLength", "int"],
  ["minProperties", "int"],
  ["maxProperties", "int"],
  // `TYPE_DOUBLE`.
  ["minimum", "double"],
  ["maximum", "double"],
  // `Value` and `bool`: measured to accept any JSON this can produce.
  ["default", "free"],
  ["example", "free"],
  ["nullable", "free"],
]);

/**
 * The values `Schema.type` accepts.
 *
 * A proto **enum**, so unlike every other field here its *value* is checked as
 * well as its name: `type: "text"` answers
 * `Invalid value at '…value.type' (…master.Type), "text"`. Enumerated live on
 * 2026-09-05 — these eight are accepted case-insensitively and everything else
 * tried was refused, including `""`, `"any"`, `"int"`, `"float"`, `"list"` and
 * a trailing space. `"null"` standing alone is a real type here, which is why
 * only the *union* spelling needs translating into `nullable`.
 */
const SCHEMA_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
  "null",
  "type_unspecified",
]);

/**
 * How deep a schema may nest before its remainder is cut.
 *
 * The upstream's JSON parser has a recursion ceiling and answers
 * `Invalid JSON payload received. Message too deep. Max recursion depth reached
 * for key '…'` — with **no `function_declarations[N]` in it**, so the whole
 * request dies and the log cannot even say which tool did it.
 *
 * Measured 2026-09-05 through `properties`: 30 levels answered 200, 31 was
 * refused. That is a *JSON* ceiling, not a schema one, and the two are not the
 * same count — a `properties` hop costs two levels (the map, then the member)
 * and an `items` hop costs one — so this is set well under the measured figure
 * rather than at it, and stays right when the envelope above it changes shape.
 * No tool schema this gateway has seen comes near either number.
 */
const MAX_SCHEMA_DEPTH = 24;

const isSchema = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A tool schema reduced to what the upstream will parse.
 *
 * Walks only the positions that hold schemas — `properties` values, `items`,
 * the `anyOf`/`allOf` arms, an object-valued `additionalProperties`. Everything
 * else is left alone, which is the whole point of doing this structurally
 * rather than by scanning keys: `enum: ["const"]` and a property *named*
 * `const` are data, and a walk that pruned by name would silently rewrite both.
 *
 * A schema position holding something that is not a schema is dropped rather
 * than forwarded, for the same reason an unknown name is: the proto refuses it
 * either way, and there is nothing to recurse into.
 *
 * `const` is the one keyword translated rather than dropped — it is how a
 * discriminated union names its arm, and `enum` with one member says the same
 * thing in the vocabulary Gemini has. A `const` beside an existing `enum` is
 * dropped instead: the proto can express one of the two, and the `enum` is the
 * client's own explicit vocabulary.
 */
function pruneSchema(node: Record<string, unknown>, note: (d: string) => void, depth = 0): unknown {
  const out: Record<string, unknown> = {};
  const drop = (): void => note(PRUNED);
  const sub = (v: unknown): unknown => {
    if (!isSchema(v) || depth >= MAX_SCHEMA_DEPTH) {
      drop();
      return undefined;
    }
    return pruneSchema(v, note, depth + 1);
  };

  for (const [key, value] of Object.entries(node)) {
    if (key === "const") {
      drop();
      // **`Schema.enum` is `repeated string`.** A numeric or boolean literal
      // said this way trades `Unknown name "const"` for
      // `Invalid value at '…enum[0]' (TYPE_STRING)`, which is the same dead
      // request with a less helpful message, so only a string const survives.
      if (typeof value === "string" && !Object.hasOwn(node, "enum")) out.enum = [value];
      continue;
    }
    const kind = SCHEMA_FIELDS.get(key);
    if (kind === undefined) {
      drop();
      continue;
    }
    switch (key) {
      case "type": {
        // `Schema.type` is a proto enum, so draft-07's union spelling
        // (`["string", "null"]`) is a parse error. It says two things Gemini
        // has two fields for, so it is translated rather than dropped; a union
        // of two real types keeps the first and records the loss.
        if (typeof value === "string") {
          if (SCHEMA_TYPES.has(value.toLowerCase())) out.type = value;
          else drop();
          break;
        }
        const named = Array.isArray(value)
          ? (value as unknown[]).filter(
              (t): t is string => typeof t === "string" && SCHEMA_TYPES.has(t.toLowerCase()),
            )
          : [];
        const real = named.filter((t) => t.toLowerCase() !== "null");
        if (!Array.isArray(value) || named.length !== value.length || real.length !== 1) drop();
        if (real[0] !== undefined) out.type = real[0];
        if (named.length !== real.length) out.nullable = true;
        break;
      }
      case "properties": {
        if (!isSchema(value)) {
          drop();
          break;
        }
        const entries: [string, unknown][] = [];
        for (const [name, member] of Object.entries(value)) {
          // `properties[]: key cannot be empty` — the map's key is validated
          // too, and an unnamed property is not something a rename can fix.
          if (name.length === 0) {
            drop();
            continue;
          }
          const pruned = sub(member);
          if (pruned !== undefined) entries.push([name, pruned]);
        }
        out.properties = Object.fromEntries(entries);
        break;
      }
      case "items": {
        // Tuple form — `items: [A, B]` — is an array in a singular message
        // field. Reduced to `A` rather than dropped: "array of the first arm"
        // is wrong about the tail but right about the shape, and an array left
        // with no `items` at all is refused outright (see below).
        if (Array.isArray(value)) {
          drop();
          const first = sub((value as unknown[])[0]);
          if (first !== undefined) out.items = first;
          break;
        }
        const pruned = sub(value);
        if (pruned !== undefined) out.items = pruned;
        break;
      }
      case "anyOf":
      case "allOf": {
        if (!Array.isArray(value)) {
          drop();
          break;
        }
        const arms: unknown[] = [];
        for (const arm of value as unknown[]) {
          const pruned = sub(arm);
          if (pruned !== undefined) arms.push(pruned);
        }
        out[key] = arms;
        break;
      }
      case "additionalProperties": {
        if (typeof value === "boolean") {
          out[key] = value;
          break;
        }
        const pruned = sub(value);
        if (pruned !== undefined) out[key] = pruned;
        break;
      }
      default: {
        const kept = scalarValue(kind, value);
        if (kept === undefined) drop();
        else {
          if (Array.isArray(kept) && Array.isArray(value) && kept.length !== value.length) drop();
          out[key] = kept;
        }
      }
    }
  }

  // **Structural fields are gated on the node's `type`** — `properties`,
  // `required` and `propertyOrdering` answer
  // `* …properties[a].properties: only allowed for OBJECT type`, and `items`
  // answers `field predicate failed: $type == Type.ARRAY`. An *absent* type is
  // not a pass: `TYPE_UNSPECIFIED` fails both, which is the trap, because this
  // function produces exactly that whenever it drops a type it could not name.
  //
  // Repaired by inferring rather than by deleting: a node carrying `properties`
  // **is** an object and one carrying `items` **is** an array, which is what
  // every other reader of the schema already assumes. Only a node that states a
  // *contradicting* type loses the structure instead — there the client said
  // something explicit and the encoder is not entitled to overrule it.
  const declared = typeof out.type === "string" ? out.type.toLowerCase() : undefined;
  const agree = (want: string, fields: readonly string[]): void => {
    if (!fields.some((f) => out[f] !== undefined)) return;
    if (declared === want) return;
    if (declared === undefined) {
      out.type = want;
      return;
    }
    drop();
    for (const f of fields) delete out[f];
  };
  agree("object", ["properties", "required", "propertyOrdering"]);
  agree("array", ["items"]);

  // **`required` and `propertyOrdering` may only name properties that exist** —
  // `* GenerateContentRequest…required[1]: property is not defined`. This is a
  // *cross-field* check, invisible until every parse error is gone (the
  // upstream validates in two stages and stops after the first), and this
  // function creates the condition itself whenever it drops a member the
  // client listed as required.
  for (const key of ["required", "propertyOrdering"] as const) {
    const names = out[key];
    if (!Array.isArray(names)) continue;
    const known = isSchema(out.properties) ? out.properties : {};
    const kept = (names as unknown[]).filter(
      (n) => typeof n === "string" && Object.hasOwn(known, n),
    );
    if (kept.length === names.length) continue;
    drop();
    if (kept.length === 0) delete out[key];
    else out[key] = kept;
  }

  // **`type: "array"` obliges `items`** — Cloud Code answers
  // `* GenerateContentRequest…properties[x].items: missing field.`, which is a
  // *required*-field error and not an unknown-name one, so the allowlist alone
  // never sees it. Reachable whenever `items` was unusable and from a client
  // that never sent one, so the repair is here rather than in that branch:
  // dropping the type leaves a schema that says less and parses, where keeping
  // it fails the whole request.
  if (out.type === "array" && out.items === undefined) {
    drop();
    delete out.type;
  }
  return out;
}

function encodeToolChoice(choice: ToolChoice, cloak: ToolCloak | null): unknown {
  switch (choice.type) {
    case "auto":
      return { functionCallingConfig: { mode: "AUTO" } };
    case "any":
      return { functionCallingConfig: { mode: "ANY" } };
    case "none":
      return { functionCallingConfig: { mode: "NONE" } };
    case "tool":
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [cloakName(cloak, choice.name)],
        },
      };
  }
}

export function toAntigravityWire(
  req: ChatRequest,
  model: string,
  identity: { project: string; requestId: string; cloak?: ToolCloak | null },
): { body: AntigravityEnvelope; degradations: string[] } {
  const cloak = identity.cloak ?? null;
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
            functionCall: { name: cloakName(cloak, block.name), args: block.input },
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
              // Cloaked whichever it is: the recovered name and the id
              // fallback both land in the same field under the same grammar.
              name: cloakName(cloak, name ?? block.toolUseId),
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

  const request: GeminiRequest = {
    contents: closingTurn(openingTurn(mergeSameRole(contents), note), note),
  };

  const system = systemText(req.system, "antigravity", note);
  if (system !== undefined && system.length > 0) {
    request.systemInstruction = { parts: [{ text: system }] };
  }

  // **Cloud Code range-checks `generationConfig` and answers 400 on each**, in
  // its own semantic pass rather than as a parse error, so none of these are
  // visible until the request parses. Measured 2026-09-05:
  // `temperature must be in the range [0.0, 2.0]`,
  // `the number of stop_sequences must not exceed 5`,
  // `thinking_budget must be in the range [-1, 65535]`, and a non-positive
  // `maxOutputTokens` answers a bare `Request contains an invalid argument.`
  //
  // Clamped rather than forwarded, on the standing rule that a request the
  // client can still use beats one that never runs. Each records what moved.
  const generationConfig: GenerationConfig = {};
  if (req.maxTokens !== undefined) {
    // Dropped, not clamped to 1: a client asking for no output has said
    // something this encoder cannot honour, and the model's own default is a
    // better answer than a one-token ceiling.
    if (req.maxTokens > 0) generationConfig.maxOutputTokens = req.maxTokens;
    else note("antigravity:max-tokens-dropped");
  }
  if (req.temperature !== undefined) {
    const clamped = Math.min(Math.max(req.temperature, 0), 2);
    if (clamped !== req.temperature) note("antigravity:temperature-clamped");
    generationConfig.temperature = clamped;
  }
  if (req.stopSequences !== undefined) {
    generationConfig.stopSequences = req.stopSequences.slice(0, MAX_STOP_SEQUENCES);
    if (req.stopSequences.length > MAX_STOP_SEQUENCES) note("antigravity:stop-sequences-dropped");
  }

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
        {
          const asked = req.reasoning.budgetTokens;
          const budget = Math.min(Math.max(asked, -1), MAX_THINKING_BUDGET);
          if (budget !== asked) note("antigravity:thinking-budget-clamped");
          generationConfig.thinkingConfig = {
            thinkingBudget: budget,
            includeThoughts: budget !== 0,
          };
        }
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

    // A name the upstream will not take costs the **whole request** rather than
    // itself, so it is renamed on the way out and restored in `decode.ts` from
    // the map `codec.ts` carries in `decodeState`. Renaming rather than
    // dropping: a dropped tool is a capability the client asked for and never
    // learns it lost.
    //
    // Deduplication survives the rename and cannot be folded into it —
    // `Duplicate function declaration found: …` is its own 400, and two
    // declarations sharing one name are the same tool twice from the wire's
    // point of view. The first wins, so the survivor is the client's own.
    const seen = new Set<string>();
    const named: {
      name: string;
      description: string | undefined;
      inputSchema: Record<string, unknown>;
    }[] = [];
    for (const tool of portable) {
      const name = cloakName(cloak, tool.name);
      if (seen.has(name)) {
        note("antigravity:duplicate-tool-dropped");
        continue;
      }
      seen.add(name);
      named.push({ name, description: tool.description, inputSchema: tool.inputSchema });
    }
    if (cloak !== null && cloak.toWire.size > 0) note("antigravity:tool-name-renamed");

    if (named.length > 0) {
      request.tools = [
        {
          functionDeclarations: named.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: pruneSchema(t.inputSchema, note),
          })),
        },
      ];
    }
  }
  if (req.toolChoice !== undefined) request.toolConfig = encodeToolChoice(req.toolChoice, cloak);

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
