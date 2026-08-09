import type { CacheControl, ContentBlock } from "@omni/ir";
import { cacheControlOf, GatewayError } from "@omni/ir";
import { z } from "zod";

/**
 * Only the shapes Anthropic accepts. An unknown marker is a `BAD_REQUEST`
 * rather than something forwarded verbatim: the field decides what gets
 * cached, and a typo the gateway waves through becomes a silent upstream 400.
 */
export const cacheControlSchema = z.object({
  type: z.literal("ephemeral"),
  ttl: z.enum(["5m", "1h"]).optional(),
});

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
export function applyMessageCacheControl(
  blocks: ContentBlock[],
  c: z.infer<typeof cacheControlSchema> | undefined,
): void {
  if (c === undefined) return;
  const last = blocks.at(-1);
  if (last === undefined || last.type === "thinking" || cacheControlOf(last) !== undefined) return;
  Object.assign(last, irCacheControl(c));
}

/**
 * Runs a schema and converts a Zod failure into a BAD_REQUEST carrying the
 * offending field path, so a client can see which field it got wrong.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.join(".") ?? "(root)";
  throw new GatewayError("BAD_REQUEST", `${path}: ${issue?.message ?? "invalid request"}`);
}

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
