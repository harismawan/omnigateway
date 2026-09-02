import type { CacheControl, ContentBlock } from "@omni/ir";
import { cacheControlOf, GatewayError, safeToken } from "@omni/ir";
import { z } from "zod";

/**
 * Only the shapes Anthropic accepts.
 *
 * Used strictly on the Anthropic surface, where an unknown marker is a
 * `BAD_REQUEST` rather than something forwarded verbatim: the field decides
 * what gets cached, and a typo waved through becomes a silent upstream 400.
 * `looseCacheControl` reads the same shapes without refusing, for a surface
 * where the field is a translation rather than a contract.
 */
export const cacheControlSchema = z.object({
  type: z.literal("ephemeral"),
  ttl: z.enum(["5m", "1h"]).optional(),
});

/**
 * Reads a marker on a surface that does not define one, ignoring anything
 * this gateway cannot express.
 *
 * `cache_control` is not an OpenAI field: carrying it there is a best-effort
 * translation for a request that may be routed to an Anthropic target. A
 * shape that does not map is dropped rather than refused, because it was
 * dropped before this field was read at all — refusing would break a caller
 * that worked yesterday, and would put the gateway in the way of a TTL the
 * provider adds later. A shape that maps exactly is honoured; a partial match
 * is not downgraded, since a TTL that cannot be expressed is not the same
 * request as no TTL at all.
 */
export function looseCacheControl(value: unknown): { cacheControl?: CacheControl } {
  const parsed = cacheControlSchema.safeParse(value);
  return parsed.success ? irCacheControl(parsed.data) : {};
}

/**
 * Spreads a cache breakpoint onto whatever block is being built.
 *
 * Returns an empty object when there is none, so `exactOptionalPropertyTypes`
 * never sees an explicit `undefined` where the property is optional.
 */
export function irCacheControl(c: z.infer<typeof cacheControlSchema> | undefined): {
  cacheControl?: CacheControl;
} {
  if (c === undefined) return {};
  return { cacheControl: { type: c.type, ...(c.ttl === undefined ? {} : { ttl: c.ttl }) } };
}

/**
 * Applies a breakpoint the client put on a *message* to that message's last
 * block, in place.
 *
 * Anthropic only accepts a marker on a content block, so the faithful reading
 * of a message-level one is "cache through the end of this message". A marker
 * already on the last block is more specific and wins. Thinking blocks cannot
 * carry one at all, so a message ending in thinking drops it — nothing else
 * would be a legal request.
 */
export function applyMessageCacheControl(blocks: ContentBlock[], value: unknown): void {
  const control = looseCacheControl(value);
  if (control.cacheControl === undefined) return;
  const last = blocks.at(-1);
  if (last === undefined || last.type === "thinking" || cacheControlOf(last) !== undefined) return;
  Object.assign(last, control);
}

/**
 * Runs a schema and converts a Zod failure into a BAD_REQUEST carrying the
 * offending field path, so a client can see which field it got wrong.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  throw new GatewayError("BAD_REQUEST", `${issuePath(issue)}: ${zodDetail(issue)}`);
}

/**
 * What a zod failure may say about the request that caused it.
 *
 * Every arm reports the schema's own expectation — except `unrecognized_keys`,
 * whose message is `Unrecognized key: "<the client's key>"`. That one is
 * rewritten here rather than bounded in place, because the value rides zod's
 * wording rather than ours, and there are twenty-five strict schemas on this
 * surface for it to come out of. Checked against zod v4: no other arm echoes a
 * received value.
 */
/**
 * The field path of a zod failure, with every segment bounded.
 *
 * A path reads as structure, and mostly is — schema keys and array indices this
 * repository named. The exception is real: zod's `invalid_key` arm puts the
 * client's own key in `path`, so a `z.record` with a constrained key schema
 * would put client text here while the message beside it stayed bounded. No
 * such record exists today; the bound is what makes that stay true when one
 * does.
 */
export function issuePath(issue: z.core.$ZodIssue | undefined): string {
  const segments = issue?.path ?? [];
  return segments.length === 0 ? "(root)" : segments.map((s) => safeToken(String(s))).join(".");
}

export function zodDetail(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return "invalid request";
  if (issue.code === "unrecognized_keys") {
    return `unrecognized key "${safeToken(issue.keys[0])}"`;
  }
  return issue.message;
}

export { safeToken };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Anything the schema does not name is preserved for vendor passthrough. */
export function extraFields(
  body: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!known.includes(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/**
 * Header names a harness uses to name the conversation it is in.
 *
 * Measured from each client's own source, not guessed. Two of the three send a
 * per-session id in a header and put **nothing** in the body, so a gateway
 * reading bodies alone sees them as anonymous and falls back to a derived key
 * that — measured on real traffic — rotates 4 to 9 times per session as the
 * system prompt changes.
 *
 * - `x-session-id` / `x-session-affinity`: opencode sends both, with that exact
 *   disagreement in casing, which is why the match below is case-insensitive.
 * - `x-deepseek-harness-session-id`: dsh, whose design notes say it keeps
 *   identity out of the body on purpose.
 *
 * - `session-id`: Codex, which sends the bare spelling. It was absent from this
 *   list for as long as it could not reach any route here — it speaks only the
 *   Responses API, `wire_api = "chat"` being a hard error in it now — and
 *   `POST /v1/responses` is what changed that.
 *
 * Order is precedence, and only matters for a client sending two of these. The
 * prefixed spellings come first because a client that sends one chose it; the
 * bare name is the one another proxy is most likely to have set on the way
 * through.
 */
const CONVERSATION_HEADERS = [
  "x-session-id",
  "x-session-affinity",
  "x-deepseek-harness-session-id",
  "session-id",
] as const;

/**
 * The conversation id a client named in a header, if any.
 *
 * Bounded at the same 512 characters the body fields are, and for the same
 * reason rather than a different one: the value is hashed before it reaches a
 * provider, so the bound is about what this gateway will hold, not about what
 * the upstream accepts.
 */
export function readConversationHeader(headers: Headers | undefined): string | undefined {
  for (const name of CONVERSATION_HEADERS) {
    const raw = headers?.get(name)?.trim();
    if (raw !== undefined && raw.length > 0 && raw.length <= 512) return raw;
  }
  return undefined;
}

/** Splits `data:image/png;base64,AAAA` into its media type and payload. */
export function parseDataUrl(url: string): { mediaType: string; data: string } {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) {
    throw new GatewayError(
      "BAD_REQUEST",
      "image_url must be a base64 data URL; the gateway does not fetch remote images",
    );
  }
  return { mediaType: match[1] as string, data: match[2] as string };
}

/**
 * Leading base64 of each container header, for payloads that arrive with no
 * declared media type.
 *
 * Each base64 character depends only on the bytes before it, so a prefix of the
 * encoding identifies a prefix of the bytes at any character boundary — these
 * are cut for legibility, not alignment. The set is the four formats Anthropic
 * accepts, which is also every format the vision-capable targets here share; a
 * fifth would have to be carried by a provider that can receive it.
 */
const BASE64_MAGIC: readonly (readonly [string, string])[] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];

/** Why a sidecar payload could not become an image block. */
type SidecarRejection = "remote" | "unrecognized" | "not-an-image";

type SidecarResult =
  | { ok: true; mediaType: string; data: string }
  | { ok: false; reason: SidecarRejection; detail: string };

/**
 * Reads an image a client sent outside the `content` array.
 *
 * Ollama-shaped clients (Hermes Agent among them) put a bare base64 string in
 * `messages[].images`, and SDK-shaped ones put `{url, contentType}` in
 * `attachments` / `experimental_attachments`. Neither is an OpenAI field, so
 * both were dropped by the schema before this existed — a request whose only
 * image rode in one of them reached the model as text alone, with nothing said.
 *
 * A declared media type is never trusted over the payload: a data URL carries
 * its own, and that one wins, because the client that wrote the envelope and
 * the client that wrote the bytes disagree often enough to matter.
 *
 * Returns a rejection rather than throwing, because the two carriers disagree
 * about what a rejection means — see `requireSidecarImage` and
 * `optionalSidecarImage`.
 */
function readSidecarImage(raw: string, declaredMediaType: string | undefined): SidecarResult {
  if (!raw.startsWith("data:") && /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return { ok: false, reason: "remote", detail: "the gateway does not fetch remote images" };
  }

  // Parsed here rather than through `parseDataUrl`, which throws: on this path
  // a data URL the gateway cannot read is a rejection the caller gets to
  // classify, not an error decided on its behalf.
  const dataUrl = raw.startsWith("data:") ? /^data:([^;,]+);base64,(.*)$/s.exec(raw) : null;
  if (raw.startsWith("data:") && dataUrl === null) {
    return {
      ok: false,
      reason: "unrecognized",
      detail: "data URL must carry base64 content",
    };
  }
  const resolved =
    dataUrl === null
      ? { mediaType: BASE64_MAGIC.find(([prefix]) => raw.startsWith(prefix))?.[1], data: raw }
      : { mediaType: dataUrl[1] as string, data: dataUrl[2] as string };

  const mediaType = resolved.mediaType ?? declaredMediaType;
  if (mediaType === undefined) {
    return {
      ok: false,
      reason: "unrecognized",
      detail: "unrecognized image data; expected PNG, JPEG, GIF or WebP",
    };
  }
  // Checked on both paths, not just the sniffed one: a data URL states its own
  // type, and `data:application/pdf;base64,` states it just as clearly as an
  // envelope does.
  if (!mediaType.startsWith("image/")) {
    return { ok: false, reason: "not-an-image", detail: `${safeToken(mediaType)} is not an image` };
  }
  return { ok: true, mediaType, data: resolved.data };
}

/**
 * Reads a payload from a carrier that holds nothing but images.
 *
 * `messages[].images` is Ollama's field and takes image data by definition, so
 * something in it that is not image data is a malformed request rather than an
 * attachment this gateway happens not to handle. There is also no second copy
 * of it anywhere in the message, so dropping it would send the model a question
 * about a picture it cannot see.
 */
export function requireSidecarImage(
  raw: string,
  field: string,
): { mediaType: string; data: string } {
  const result = readSidecarImage(raw, undefined);
  if (!result.ok) throw new GatewayError("BAD_REQUEST", `${field}: ${result.detail}`);
  return { mediaType: result.mediaType, data: result.data };
}

/**
 * Reads a payload from a carrier that holds files of any kind.
 *
 * `attachments` and `experimental_attachments` are the SDK's general file
 * envelope: a PDF, a text file, or a hosted URL is an ordinary thing to find
 * there, not an error. Every one of them was dropped before this gateway read
 * the field at all, so refusing the request now would break a caller that
 * worked yesterday over a part of it the gateway never used. Same reasoning as
 * `looseCacheControl` above, and the same conclusion: translate what maps, drop
 * what does not.
 */
export function optionalSidecarImage(
  raw: string,
  declaredMediaType: string | undefined,
): { mediaType: string; data: string } | null {
  const result = readSidecarImage(raw, declaredMediaType);
  return result.ok ? { mediaType: result.mediaType, data: result.data } : null;
}
