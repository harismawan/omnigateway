import type { CacheControl, ChatRequest, ContentBlock, TextBlock } from "@omni/ir";
import type { PonytailMode } from "./catalog.ts";
import { PONYTAIL_MARKER, rulesetFor } from "./text.ts";

export type { PonytailLevel, PonytailMode } from "./catalog.ts";
export { isPonytailMode, PONYTAIL_MODES } from "./catalog.ts";
export { PONYTAIL_MARKER } from "./text.ts";

export type PonytailReport = {
  mode: PonytailMode;
  applied: boolean;
  cacheMarkerMoved: boolean;
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
  if (report.reason === "disabled") return [];
  if (report.reason === "already-present") return ["ponytail:already-present"];
  return report.cacheMarkerMoved
    ? [`ponytail:${report.mode}`, "ponytail:cache-marker-moved"]
    : [`ponytail:${report.mode}`];
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

/**
 * The breakpoint a block carries, if its kind can carry one at all.
 *
 * `ContentBlock` is a union and thinking blocks have no `cacheControl`, so the
 * property has to be narrowed to rather than read off the union.
 */
function markerOf(block: ContentBlock | undefined): CacheControl | undefined {
  return block !== undefined && "cacheControl" in block ? block.cacheControl : undefined;
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
      report: { mode, applied: false, cacheMarkerMoved: false, reason: "disabled" },
    };
  }
  if (carriesRuleset(request)) {
    return {
      request,
      report: { mode, applied: false, cacheMarkerMoved: false, reason: "already-present" },
    };
  }

  const existing = request.system ?? [];
  const last = existing[existing.length - 1];
  const moved = markerOf(last);

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
    report: { mode, applied: true, cacheMarkerMoved: moved !== undefined },
  };
}
