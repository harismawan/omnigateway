import {
  type CatalogAuth,
  catalogLimits,
  catalogModelAuths,
  catalogPricing,
  PROVIDER_MODEL_CATALOG,
  type ProviderModelChoice,
} from "@omni/providers/catalog";
import type { Credential, ProviderId, Strategy, Target, VirtualModel } from "../../api/types.ts";

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
  endpointId: string;
  model: string;
  tier: string;
  weight: string;
  costInput: string;
  costOutput: string;
  /** Empty means the provider does not price cache reads separately. */
  costCacheRead: string;
  /**
   * Empty means the target names no write price, and pricing falls back to a
   * multiple of input chosen for that provider. Blank and 0 are different: a
   * provider that bills no write premium needs the explicit 0.
   */
  costCacheWrite5m: string;
  costCacheWrite1h: string;
  /**
   * What the gateway tells clients this target holds and emits. Empty is the
   * normal state and means the gateway works it out per listing, from the
   * catalog and from how the serving credential authenticates. Fill one in only
   * where the account's own limits differ from the published ones.
   */
  contextWindow: string;
  maxOutputTokens: string;
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
): Pick<
  TargetDraft,
  "costInput" | "costOutput" | "costCacheRead" | "costCacheWrite5m" | "costCacheWrite1h"
> | null {
  const listed = catalogPricing(provider, model);
  if (listed === null) return null;
  return {
    costInput: String(listed.input),
    costOutput: String(listed.output),
    costCacheRead: String(listed.cacheRead),
    costCacheWrite5m: String(listed.cacheWrite5m),
    costCacheWrite1h: String(listed.cacheWrite1h),
  };
}

/**
 * The catalog's limits for a provider model, as the strings the editor holds.
 * Null for a model it does not list, which leaves the operator's figures alone.
 */
export function catalogTokenLimits(
  provider: ProviderId,
  model: string,
): Pick<TargetDraft, "contextWindow" | "maxOutputTokens"> | null {
  const listed = catalogLimits(provider, model);
  if (listed === null) return null;
  return {
    contextWindow: String(listed.contextWindow),
    maxOutputTokens: String(listed.maxOutputTokens),
  };
}

/** Which ways in the installation holds, per provider. Absent means none. */
export type HeldAuths = Partial<Record<ProviderId, readonly CatalogAuth[]>>;

const AUTH_NOUN: Readonly<Record<CatalogAuth, string>> = {
  oauth: "OAuth",
  apiKey: "an API key",
};

function phrase(auths: readonly CatalogAuth[]): string {
  return auths.map((auth) => AUTH_NOUN[auth]).join(" or ");
}

/**
 * Reads the connected accounts as a set of ways in per provider.
 *
 * `enabled` is deliberately not consulted, matching the control rule this
 * mirrors: a credential the gateway disabled after one rejected token is still
 * the operator's way into that provider, and hiding models behind a transient
 * failure would be worse than showing them.
 */
export function heldAuths(credentials: readonly Credential[]): HeldAuths {
  const held: Record<string, CatalogAuth[]> = {};
  for (const credential of credentials) {
    const ways = held[credential.provider] ?? [];
    if (!ways.includes(credential.authType)) ways.push(credential.authType);
    held[credential.provider] = ways;
  }
  return held;
}

/**
 * Whether any credential this installation holds could serve a model.
 *
 * Two things read as "yes" rather than "no", both on purpose. A provider with
 * no credential at all is unknown, not blocked — an operator composing models
 * before connecting accounts is working in a normal order. And a model the
 * catalog does not list is also unknown: the curated list is a subset of what
 * a provider serves, and Kilo's is a few dozen rows out of several hundred.
 */
export function reachable(provider: ProviderId, model: string, held: HeldAuths): boolean {
  const have = held[provider];
  if (have === undefined || have.length === 0) return true;
  return catalogModelAuths(provider, model).some((auth) => have.includes(auth));
}

/** The catalog choices worth offering: the ones a connected account can serve. */
export function reachableChoices(
  provider: ProviderId,
  held: HeldAuths,
): readonly ProviderModelChoice[] {
  return PROVIDER_MODEL_CATALOG[provider].models.filter((choice) =>
    reachable(provider, choice.id, held),
  );
}

/**
 * Why no connected account can serve a typed model, or null when one can.
 *
 * The picker only hides unreachable choices, and hiding teaches nothing to an
 * operator who typed the id or is editing a target saved when the other account
 * still existed.
 *
 * Deliberately states the routing consequence rather than predicting the save.
 * A target already stored under this id is exempt from the control-side refusal
 * — removing an account must not make an unrelated edit impossible — so "saving
 * will be refused" would be a lie in exactly the case an operator is most
 * likely to be reading this.
 */
export function unreachableNote(
  provider: ProviderId,
  model: string,
  held: HeldAuths,
): string | null {
  if (model.trim().length === 0 || reachable(provider, model, held)) return null;
  const have = held[provider] ?? [];
  return (
    `${provider} serves this model to ${phrase(catalogModelAuths(provider, model))} only, ` +
    `and every ${provider} account here is ${phrase(have)}. Requests routed here will fail.`
  );
}

/**
 * Points a target at a different model, and settles what carries across.
 *
 * Prices follow the model: a price left over from the previous model is wrong
 * in a way nothing surfaces, and the field has no fallback, so it has to hold
 * a number. Limits do the opposite and are cleared, because they *do* have a
 * fallback — the gateway works them out when it lists the model, from the
 * catalog and from how the serving credential signs in. Filling in the new
 * model's published figure would pin it, and on an OpenAI target pinning the
 * API's window is what hides the narrower one its OAuth backend allows.
 *
 * A model the catalog does not list keeps whatever prices are in the fields:
 * there is nothing better to put there.
 */
export function retargetDraft(
  target: TargetDraft,
  next: Pick<TargetDraft, "provider" | "model">,
): TargetDraft {
  return {
    ...target,
    ...next,
    ...(catalogPrices(next.provider, next.model) ?? {}),
    contextWindow: "",
    maxOutputTokens: "",
  };
}

export function blankTarget(provider: ProviderId = "anthropic"): TargetDraft {
  const model = PROVIDER_MODEL_CATALOG[provider].defaultModel;
  const prices = catalogPrices(provider, model);
  return {
    key: nextKey(),
    provider,
    endpointId: "",
    model,
    tier: "1",
    weight: "1",
    // A new target starts at the provider's published price so cost ranking
    // works before anyone has priced anything by hand.
    costInput: prices?.costInput ?? "0",
    costOutput: prices?.costOutput ?? "0",
    costCacheRead: prices?.costCacheRead ?? "",
    costCacheWrite5m: prices?.costCacheWrite5m ?? "",
    costCacheWrite1h: prices?.costCacheWrite1h ?? "",
    // Blank on purpose, unlike the prices above. A saved figure overrides what
    // the gateway would otherwise work out when it lists the model, which for
    // an OpenAI target depends on whether an API key or an OAuth credential
    // serves it. Filling these in would freeze one of those two answers.
    contextWindow: "",
    maxOutputTokens: "",
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
      endpointId: target.provider === "custom" ? (target.endpointId ?? "") : "",
      model: target.model,
      tier: String(target.tier),
      weight: String(target.weight),
      costInput: String(target.costPerMTok.input),
      costOutput: String(target.costPerMTok.output),
      costCacheRead:
        target.costPerMTok.cacheRead === undefined ? "" : String(target.costPerMTok.cacheRead),
      costCacheWrite5m:
        target.costPerMTok.cacheWrite5m === undefined
          ? ""
          : String(target.costPerMTok.cacheWrite5m),
      costCacheWrite1h:
        target.costPerMTok.cacheWrite1h === undefined
          ? ""
          : String(target.costPerMTok.cacheWrite1h),
      contextWindow: target.contextWindow === undefined ? "" : String(target.contextWindow),
      maxOutputTokens: target.maxOutputTokens === undefined ? "" : String(target.maxOutputTokens),
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
    const endpointId = target.endpointId.trim();
    if (target.provider === "custom" && endpointId.length === 0) {
      return { ok: false, problem: `${position} needs a custom endpoint.` };
    }
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

    const hasWrite5m = target.costCacheWrite5m.trim().length > 0;
    const cacheWrite5m = Number(target.costCacheWrite5m);
    if (hasWrite5m && (!Number.isFinite(cacheWrite5m) || cacheWrite5m < 0)) {
      return {
        ok: false,
        problem: `${position}: the 5m cache-write price must be a number of 0 or more.`,
      };
    }

    const hasWrite1h = target.costCacheWrite1h.trim().length > 0;
    const cacheWrite1h = Number(target.costCacheWrite1h);
    if (hasWrite1h && (!Number.isFinite(cacheWrite1h) || cacheWrite1h < 0)) {
      return {
        ok: false,
        problem: `${position}: the 1h cache-write price must be a number of 0 or more.`,
      };
    }

    const hasContext = target.contextWindow.trim().length > 0;
    const contextWindow = Number(target.contextWindow);
    if (hasContext && (!Number.isInteger(contextWindow) || contextWindow < 1)) {
      return {
        ok: false,
        problem: `${position}: the context window must be a whole number of tokens.`,
      };
    }

    const hasMaxOutput = target.maxOutputTokens.trim().length > 0;
    const maxOutputTokens = Number(target.maxOutputTokens);
    if (hasMaxOutput && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) {
      return {
        ok: false,
        problem: `${position}: the output limit must be a whole number of tokens.`,
      };
    }

    targets.push({
      provider: target.provider,
      ...(target.provider === "custom" ? { endpointId } : {}),
      model,
      tier,
      weight,
      costPerMTok: {
        input,
        output,
        ...(hasCacheRead ? { cacheRead } : {}),
        ...(hasWrite5m ? { cacheWrite5m } : {}),
        ...(hasWrite1h ? { cacheWrite1h } : {}),
      },
      ...(hasContext ? { contextWindow } : {}),
      ...(hasMaxOutput ? { maxOutputTokens } : {}),
      capabilities: { tools: target.tools, images: target.images, reasoning: target.reasoning },
    });
  }

  return { ok: true, model: { id, strategy: draft.strategy, isAlias: draft.isAlias, targets } };
}
