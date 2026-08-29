import { type ChatRequest, type ContentBlock, cacheControlOf, type TextBlock } from "@omni/ir";
import type { PonytailMode } from "./catalog.ts";
import { PONYTAIL_MARKER, rulesetFor } from "./text.ts";

export type { PonytailLevel, PonytailMode } from "./catalog.ts";
export { isPonytailMode, PONYTAIL_MODES } from "./catalog.ts";
export { PONYTAIL_MARKER } from "./text.ts";

export type PonytailReport = {
  mode: PonytailMode;
  applied: boolean;
  cacheMarkerMoved: boolean;
  /**
   * The client marked a system block, but not its last one.
   *
   * Only a breakpoint on the final block can move without changing what the
   * caller chose to cache, so in this shape the ruleset lands outside the
   * cached prefix and is billed as fresh input every request. Reported rather
   * than silently absorbed: it reads identically to the cheap case otherwise,
   * and the difference is roughly 1,240 tokens a request.
   */
  cacheMarkerNotLast: boolean;
  reason?: "disabled" | "already-present";
};

/**
 * What a report leaves on `request_logs.degradations`.
 *
 * Constants only, and never anything read off the request: that column is
 * operator-facing, so interpolating request data into it would be a privacy
 * change on the same terms as widening `LogFields`. The vocabulary lives here,
 * beside the text whose version it describes, rather than at the call site.
 *
 * Nothing is recorded when the mode is off. Absence is off, and a row per
 * disabled request is noise.
 *
 * ponytail: no column and no rollup counter — this rides an array that already
 * exists. Add a real column when someone needs to filter or aggregate by it.
 */
export function ponytailNotes(report: PonytailReport): readonly string[] {
  // Keyed on what happened, not on why: a report that applied nothing and named
  // no reason would otherwise emit `ponytail:off`, a word outside this
  // vocabulary. Only `injectPonytail` builds these, so that shape is
  // unreachable today — this keeps it unreachable by construction.
  if (!report.applied) {
    return report.reason === "already-present" ? ["ponytail:already-present"] : [];
  }
  const notes = [`ponytail:${report.mode}`];
  if (report.cacheMarkerMoved) notes.push("ponytail:cache-marker-moved");
  if (report.cacheMarkerNotLast) notes.push("ponytail:cache-marker-not-last");
  return notes;
}

const holdsMarker = (blocks: readonly ContentBlock[]): boolean =>
  blocks.some((block) => block.type === "text" && block.text.includes(PONYTAIL_MARKER));

/**
 * Whether this request already carries the ruleset.
 *
 * ponytail: scans the system prompt and system turns only, not user turns — a
 * client that puts its rules in the first user turn is not recognised, and a
 * locally reworded copy is not either. Widen to user turns if such a client
 * turns up; the cost is scanning the whole conversation on every request.
 */
function carriesRuleset(request: ChatRequest): boolean {
  if (request.system !== undefined && holdsMarker(request.system)) return true;
  return request.messages.some((m) => m.role === "system" && holdsMarker(m.content));
}

/** The same block without its cache breakpoint. A copy: the input is shared. */
function unmarked(block: ContentBlock): ContentBlock {
  if (!("cacheControl" in block)) return block;
  const { cacheControl: _moved, ...rest } = block;
  return rest as ContentBlock;
}

/**
 * Append the ponytail ruleset to a request's system prompt.
 *
 * Pure, like every transform dispatch runs before routing: it returns a new
 * request rather than editing the one it was handed. The IR object is shared
 * across failover attempts, so a block written into it in place would follow
 * the request into the next provider — the trap auto-cache already fell into.
 *
 * The ruleset goes last so it reads with recency and leaves the client's stable
 * prefix byte-identical ahead of it. When the client marked its own final
 * system block, that breakpoint moves onto the appended block: the marker meant
 * "cache through the end of system", and after injection it still does. This is
 * the one place the gateway edits a caller's cache placement — it never invents
 * a marker, never changes the count, and never changes the TTL, so the prefix
 * strictly grows by a constant and the hit rate is unchanged.
 */
export function injectPonytail(
  request: ChatRequest,
  opts: { mode: PonytailMode },
): { request: ChatRequest; report: PonytailReport } {
  const { mode } = opts;
  if (mode === "off") {
    return {
      request,
      report: {
        mode,
        applied: false,
        cacheMarkerMoved: false,
        cacheMarkerNotLast: false,
        reason: "disabled",
      },
    };
  }
  if (carriesRuleset(request)) {
    return {
      request,
      report: {
        mode,
        applied: false,
        cacheMarkerMoved: false,
        cacheMarkerNotLast: false,
        reason: "already-present",
      },
    };
  }

  const existing = request.system ?? [];
  const last = existing[existing.length - 1];
  const moved = last === undefined ? undefined : cacheControlOf(last);
  // ponytail: only a marker on the *final* system block moves. One placed
  // earlier is left alone — relocating it would enlarge what the caller chose
  // to cache by their own trailing blocks, not just by ours — so the ruleset
  // sits outside that prefix and is billed fresh every request. Reported, never
  // repaired; if this shape turns up in practice the fix is a second marker,
  // which costs one of Anthropic's four.
  const notLast =
    moved === undefined && existing.some((block) => cacheControlOf(block) !== undefined);

  const block: TextBlock = {
    type: "text",
    text: rulesetFor(mode),
    ...(moved === undefined ? {} : { cacheControl: moved }),
  };
  const head =
    moved === undefined || last === undefined
      ? existing
      : [...existing.slice(0, -1), unmarked(last)];

  return {
    request: { ...request, system: [...head, block] },
    report: {
      mode,
      applied: true,
      cacheMarkerMoved: moved !== undefined,
      cacheMarkerNotLast: notLast,
    },
  };
}
