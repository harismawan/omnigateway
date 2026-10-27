import { type ChatRequest, type ContentBlock, cacheControlOf, type TextBlock } from "@omni/ir";
import { PONYTAIL_MARKER, rulesetFor } from "@omni/ponytail";
import { MAX_APPENDED_PROMPT_CHARS } from "./catalog.ts";

export { type PromptResolution, resolvePrompts } from "./resolve.ts";

export type ResolvedPrompt = {
  id: string;
  version: number | string;
  text: string;
  marker?: string;
};

export type PromptsReport = {
  applied: Array<{ id: string; version: number | string }>;
  skipped: Array<{ id: string; reason: "already-present" | "over-budget" }>;
  cacheMarkerMoved: boolean;
  cacheMarkerNotLast: boolean;
};

export function builtinPrompts(): readonly ResolvedPrompt[] {
  return (["lite", "full", "ultra"] as const).map((level) => ({
    id: `ponytail-${level}`,
    version: "v4.9.0",
    text: rulesetFor(level),
    marker: PONYTAIL_MARKER,
  }));
}

function unmarked(block: ContentBlock): ContentBlock {
  if (!("cacheControl" in block)) return block;
  const { cacheControl: _moved, ...rest } = block;
  return rest as ContentBlock;
}

/** Append one block without mutating the shared request or enabling auto-cache. */
export function injectPrompts(
  request: ChatRequest,
  prompts: readonly ResolvedPrompt[],
): { request: ChatRequest; report: PromptsReport } {
  const report: PromptsReport = {
    applied: [],
    skipped: [],
    cacheMarkerMoved: false,
    cacheMarkerNotLast: false,
  };
  if (prompts.length === 0) return { request, report };

  const existing = request.system ?? [];
  const systemTexts: string[] = [];
  const collect = (blocks: readonly ContentBlock[]) => {
    for (const block of blocks) if (block.type === "text") systemTexts.push(block.text);
  };
  collect(existing);
  for (const message of request.messages) {
    if (message.role === "system") collect(message.content);
  }

  const survivors: ResolvedPrompt[] = [];
  for (const prompt of prompts) {
    const needle = prompt.marker ?? prompt.text.trim();
    if (systemTexts.some((text) => text.includes(needle))) {
      report.skipped.push({ id: prompt.id, reason: "already-present" });
    } else {
      survivors.push(prompt);
      // Earlier survivors are part of the would-be system prompt too.
      systemTexts.push(prompt.text);
    }
  }

  const texts: string[] = [];
  let chars = 0;
  let overBudget = false;
  for (const prompt of survivors) {
    const size = prompt.text.length + (texts.length === 0 ? 0 : 2);
    overBudget ||= chars + size > MAX_APPENDED_PROMPT_CHARS;
    if (overBudget) report.skipped.push({ id: prompt.id, reason: "over-budget" });
    else {
      texts.push(prompt.text);
      chars += size;
      report.applied.push({ id: prompt.id, version: prompt.version });
    }
  }
  if (texts.length === 0) return { request, report };

  const last = existing[existing.length - 1];
  const moved = last === undefined ? undefined : cacheControlOf(last);
  report.cacheMarkerMoved = moved !== undefined;
  report.cacheMarkerNotLast =
    moved === undefined && existing.some((block) => cacheControlOf(block) !== undefined);
  const block: TextBlock = {
    type: "text",
    text: texts.join("\n\n"),
    ...(moved === undefined ? {} : { cacheControl: moved }),
  };
  const head =
    moved === undefined || last === undefined
      ? existing
      : [...existing.slice(0, -1), unmarked(last)];
  return { request: { ...request, system: [...head, block] }, report };
}

/** Closed vocabulary: never interpolate an operator ID, version, or prompt text. */
export function promptNotes(report: PromptsReport): readonly string[] {
  const notes = new Set<string>();
  for (const prompt of report.applied) {
    switch (prompt.id) {
      case "ponytail-lite":
        notes.add("ponytail:lite");
        break;
      case "ponytail-full":
        notes.add("ponytail:full");
        break;
      case "ponytail-ultra":
        notes.add("ponytail:ultra");
        break;
    }
  }
  for (const prompt of report.skipped) {
    if (prompt.reason === "already-present") {
      notes.add("prompt:already-present");
      if (
        prompt.id === "ponytail-lite" ||
        prompt.id === "ponytail-full" ||
        prompt.id === "ponytail-ultra"
      ) {
        notes.add("ponytail:already-present");
      }
    } else if (prompt.reason === "over-budget") notes.add("prompt:over-budget");
  }
  if (report.cacheMarkerMoved) notes.add("prompt:cache-marker-moved");
  if (report.cacheMarkerNotLast) notes.add("prompt:cache-marker-not-last");
  return [...notes];
}
