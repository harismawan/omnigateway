import { type CacheControl, type ContentBlock, cacheControlOf, type ProviderId } from "@omni/ir";

/**
 * The system prompt as text, recording every block that could not become text.
 *
 * At the package root beside `http.ts` and `sse.ts`, because it is a shared
 * helper rather than a codec — rule 2 forks codecs per provider and keeps the
 * shared parts here, and this is the second kind.
 *
 * **It exists because the same four lines were written seven times and every
 * copy dropped silently.** `req.system?.flatMap((b) => (b.type === "text" ?
 * [b.text] : []))` appears in `kilo`, `grok`, `openai`, `kimi`, both `custom`
 * codecs and `anthropic`, and none of them called `note()` — while the message
 * loop directly below each one records every non-text block it drops. So a
 * client attaching a reference image to a system message got a 200, a model
 * answering as though nothing were attached, and `degradations: []`.
 *
 * The router's `requiredCapabilities` was taught to read `request.system` first,
 * and that is correct and is not this: it only excludes a target whose
 * descriptor says `images: false`, which of the built-ins is `kimi` alone. The
 * other five passed the check and dropped the block anyway. A fix at the layer a
 * review named, with the defect one layer down — which is why the instrument for
 * this (`test/systemBlocks.test.ts`) walks `ADAPTERS` rather than naming
 * providers.
 *
 * **Dropping stays the behaviour.** No provider accepts an image in its system
 * prompt, `ingress/openai.ts` refuses the `images` sidecar on a system message
 * for that reason, and turning a silent drop into a refusal would break callers
 * who are working today. What changes is that the loss is recorded, which is the
 * rule CLAUDE.md already states for the message path.
 *
 * Returns the blocks rather than a joined string: Anthropic needs them as an
 * array with cache-control preserved, and the other five join. A helper that
 * joined would have had to be un-joined at one call site, which is how the
 * seventh copy gets written.
 */
export function systemTextBlocks(
  system: readonly ContentBlock[] | undefined,
  provider: ProviderId,
  note: (degradation: string) => void,
): { type: "text"; text: string; cacheControl: CacheControl | undefined }[] {
  if (system === undefined) return [];

  const kept: { type: "text"; text: string; cacheControl: CacheControl | undefined }[] = [];
  for (const block of system) {
    if (block.type === "text") {
      // Through `cacheControlOf`, the one reader of that field: a `thinking`
      // block has none, and reading it directly is a type error the next block
      // variant would reintroduce.
      kept.push({ type: "text", text: block.text, cacheControl: cacheControlOf(block) });
      continue;
    }
    // Named by the block type, so a log line says what was lost rather than
    // that something was. `image` is the reachable one today —
    // `ingress/openai.ts` puts one here from a system message's parts — and the
    // rest are reachable the moment an ingress or a plugin codec produces them.
    note(`${provider}:system-${block.type}-dropped`);
  }
  return kept;
}

/** The same, joined, for the five adapters whose system prompt is one string. */
export function systemText(
  system: readonly ContentBlock[] | undefined,
  provider: ProviderId,
  note: (degradation: string) => void,
): string | undefined {
  if (system === undefined) return undefined;
  return systemTextBlocks(system, provider, note)
    .map((block) => block.text)
    .join("\n\n");
}
