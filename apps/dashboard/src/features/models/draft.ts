import { catalogPricing, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import type { ProviderId, Strategy, Target, VirtualModel } from "../../api/types.ts";

/**
 * The editor holds numbers as strings.
 *
 * Parsing on every keystroke turns a half-typed "0." into NaN and fights the
 * operator; parsing once, on save, lets the field hold whatever is being typed
 * and reports a single clear problem if it never became a number.
 */
export type TargetDraft = {
  /** Stable across reorders so React keeps input focus. */
  key: string;
  provider: ProviderId;
  model: string;
  tier: string;
  weight: string;
  costInput: string;
  costOutput: string;
  /** Empty means the provider does not price cache reads separately. */
  costCacheRead: string;
  tools: boolean;
  images: boolean;
  reasoning: boolean;
};

export type ModelDraft = {
  id: string;
  strategy: Strategy;
  isAlias: boolean;
  targets: TargetDraft[];
};

export const STRATEGIES: ReadonlyArray<{ id: Strategy; label: string; blurb: string }> = [
  {
    id: "score",
    label: "Best score",
    blurb: "Rank every eligible target by the routing weights and take the best one.",
  },
  {
    id: "priority",
    label: "Lowest tier",
    blurb: "Always prefer the lowest tier. Score only breaks ties inside a tier.",
  },
  {
    id: "roundRobin",
    label: "Round robin",
    blurb: "Take whichever eligible target has been idle longest, to spread load evenly.",
  },
  {
    id: "weighted",
    label: "Weighted draw",
    blurb: "Pick at random, biased by weight. The order differs from request to request.",
  },
];

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `target-${counter}`;
}

/**
 * The catalog's list price for a provider model, as the strings the editor
 * holds. Returns null for a model the catalog does not list, which leaves the
 * operator's own numbers alone.
 */
export function catalogPrices(
  provider: ProviderId,
  model: string,
): Pick<TargetDraft, "costInput" | "costOutput" | "costCacheRead"> | null {
  const listed = catalogPricing(provider, model);
  if (listed === null) return null;
  return {
    costInput: String(listed.input),
    costOutput: String(listed.output),
    costCacheRead: String(listed.cacheRead),
  };
}

export function blankTarget(provider: ProviderId = "anthropic"): TargetDraft {
  const model = PROVIDER_MODEL_CATALOG[provider].defaultModel;
  const prices = catalogPrices(provider, model);
  return {
    key: nextKey(),
    provider,
    model,
    tier: "1",
    weight: "1",
    // A new target starts at the provider's published price so cost ranking
    // works before anyone has priced anything by hand.
    costInput: prices?.costInput ?? "0",
    costOutput: prices?.costOutput ?? "0",
    costCacheRead: prices?.costCacheRead ?? "",
    tools: true,
    images: true,
    reasoning: true,
  };
}

export function blankModel(): ModelDraft {
  return { id: "", strategy: "score", isAlias: false, targets: [blankTarget()] };
}

export function toDraft(model: VirtualModel): ModelDraft {
  return {
    id: model.id,
    strategy: model.strategy,
    isAlias: model.isAlias,
    targets: model.targets.map((target) => ({
      key: nextKey(),
      provider: target.provider,
      model: target.model,
      tier: String(target.tier),
      weight: String(target.weight),
      costInput: String(target.costPerMTok.input),
      costOutput: String(target.costPerMTok.output),
      costCacheRead:
        target.costPerMTok.cacheRead === undefined ? "" : String(target.costPerMTok.cacheRead),
      tools: target.capabilities.tools,
      images: target.capabilities.images,
      reasoning: target.capabilities.reasoning,
    })),
  };
}

export type Parsed = { ok: true; model: VirtualModel } | { ok: false; problem: string };

/** Mirrors the control API's own schema, so a save is rejected here or nowhere. */
export function parseDraft(draft: ModelDraft): Parsed {
  const id = draft.id.trim();
  if (id.length === 0) return { ok: false, problem: "Give the model a name clients will ask for." };
  if (draft.targets.length === 0) {
    return { ok: false, problem: "A model needs at least one target to route to." };
  }

  const targets: Target[] = [];
  for (const [index, target] of draft.targets.entries()) {
    const position = `Target ${index + 1}`;
    const model = target.model.trim();
    if (model.length === 0)
      return { ok: false, problem: `${position} needs a provider model name.` };

    const tier = Number(target.tier);
    if (!Number.isInteger(tier) || tier < 1) {
      return { ok: false, problem: `${position}: tier must be a whole number of 1 or more.` };
    }

    const weight = Number(target.weight);
    if (!Number.isFinite(weight) || weight <= 0) {
      return { ok: false, problem: `${position}: weight must be greater than zero.` };
    }

    const input = Number(target.costInput);
    const output = Number(target.costOutput);
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      return { ok: false, problem: `${position}: prices cannot be negative.` };
    }

    const hasCacheRead = target.costCacheRead.trim().length > 0;
    const cacheRead = Number(target.costCacheRead);
    if (hasCacheRead && (!Number.isFinite(cacheRead) || cacheRead < 0)) {
      return { ok: false, problem: `${position}: the cache-read price cannot be negative.` };
    }

    targets.push({
      provider: target.provider,
      model,
      tier,
      weight,
      costPerMTok: { input, output, ...(hasCacheRead ? { cacheRead } : {}) },
      capabilities: { tools: target.tools, images: target.images, reasoning: target.reasoning },
    });
  }

  return { ok: true, model: { id, strategy: draft.strategy, isAlias: draft.isAlias, targets } };
}
