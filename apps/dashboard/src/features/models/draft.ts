// The one place the console asks a routing question, imported rather than
// reimplemented for the same reason `vitals.ts` imports `sameWindow`: a second
// copy of "which account can serve this target" is what put the picker and the
// router out of step in the first place.
import { servesTarget } from "@omni/store/types";
import { findProvider } from "../../api/queries.ts";
import type {
  AuthType,
  CatalogModel,
  CatalogProvider,
  Credential,
  ProviderId,
  Strategy,
  Target,
  VirtualModel,
} from "../../api/types.ts";

/**
 * The loaded provider catalog, as every helper below takes it.
 *
 * A parameter rather than a module import: the catalog arrives over
 * `/api/catalog` now, so there is nothing to close over — and passing it in is
 * what lets these functions be tested against a two-provider fixture instead of
 * against whatever the shipped catalog happens to list this week.
 */
export type Catalog = readonly CatalogProvider[];

/** One catalog entry, or undefined for a model the catalog does not list. */
function modelEntry(catalog: Catalog, provider: string, model: string): CatalogModel | undefined {
  return findProvider(catalog, provider)?.models.find((entry) => entry.id === model);
}

/**
 * Which credential types can reach one provider model.
 *
 * The *fact*, not the rule: callers decide what to do about it. Two answers
 * collapse to the provider's whole set — a choice with no `auth` is served
 * either way, which is the normal case, and a model the catalog does not list
 * is unknown rather than restricted.
 *
 * A provider the catalog does not carry at all answers `null`, and what that
 * buys is narrower than an earlier version of this comment claimed. It does not
 * keep such a provider's models visible: `reachableChoices` returns `[]` for an
 * unknown provider before `reachable` is ever consulted, so the picker is empty
 * either way and the operator types the id. What `null` prevents is the red
 * note under that field — `unreachableNote` would otherwise accuse a target
 * whose provider merely is not listed, which is the one screen an operator
 * visits to find out whether their configuration is sound.
 */
function modelAuths(catalog: Catalog, provider: string, model: string): readonly AuthType[] | null {
  const entry = findProvider(catalog, provider);
  if (entry === undefined) return null;
  // `auth` arrives resolved: the endpoint applies the model-states-its-own-set
  // rule so this does not have to hold a second copy of it. The fallback is for
  // a model the operator typed that the catalog does not list, which is unknown
  // rather than forbidden — the same treatment the catalog itself gives it.
  return entry.models.find((choice) => choice.id === model)?.auth ?? entry.authTypes;
}

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
  /**
   * The one account allowed to serve this target, or empty for any account of
   * the provider.
   *
   * Empty is the normal state. A pin is hard at routing — an account that is
   * disabled, breakered or out of quota fails the request instead of spilling
   * to a sibling — so this is the operator saying which account, not which
   * account first.
   */
  credentialId: string;
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
  catalog: Catalog,
  provider: ProviderId,
  model: string,
): Pick<
  TargetDraft,
  "costInput" | "costOutput" | "costCacheRead" | "costCacheWrite5m" | "costCacheWrite1h"
> | null {
  const listed = modelEntry(catalog, provider, model)?.pricing;
  if (listed === undefined) return null;
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
  catalog: Catalog,
  provider: ProviderId,
  model: string,
): Pick<TargetDraft, "contextWindow" | "maxOutputTokens"> | null {
  // The published figures, which are the API's. A target served through an
  // OAuth backend may be narrower, and that narrowing is the gateway's to work
  // out per listing — writing it into the field here would pin it.
  const listed = modelEntry(catalog, provider, model)?.limits;
  if (listed === undefined) return null;
  return {
    contextWindow: String(listed.contextWindow),
    maxOutputTokens: String(listed.maxOutputTokens),
  };
}

/** Which ways in the installation holds, per provider. Absent means none. */
export type HeldAuths = Partial<Record<ProviderId, readonly AuthType[]>>;

const AUTH_NOUN: Readonly<Record<AuthType, string>> = {
  oauth: "OAuth",
  apiKey: "an API key",
};

function phrase(auths: readonly AuthType[]): string {
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
  const held: Record<string, AuthType[]> = {};
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
export function reachable(
  catalog: Catalog,
  provider: ProviderId,
  model: string,
  held: HeldAuths,
): boolean {
  const have = held[provider];
  if (have === undefined || have.length === 0) return true;
  const serves = modelAuths(catalog, provider, model);
  if (serves === null) return true;
  return serves.some((auth) => have.includes(auth));
}

/** The catalog choices worth offering: the ones a connected account can serve. */
export function reachableChoices(
  catalog: Catalog,
  provider: ProviderId,
  held: HeldAuths,
): readonly CatalogModel[] {
  const entry = findProvider(catalog, provider);
  if (entry === undefined) return [];
  return entry.models.filter((choice) => reachable(catalog, provider, choice.id, held));
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
  catalog: Catalog,
  provider: ProviderId,
  model: string,
  held: HeldAuths,
): string | null {
  if (model.trim().length === 0 || reachable(catalog, provider, model, held)) return null;
  const have = held[provider] ?? [];
  // Non-null by construction: `reachable` returns true for a provider the
  // catalog does not carry, so an unreachable model always had an entry.
  const serves = modelAuths(catalog, provider, model) ?? [];
  return (
    `${provider} serves this model to ${phrase(serves)} only, ` +
    `and every ${provider} account here is ${phrase(have)}. Requests routed here will fail.`
  );
}

/** Which target a pin belongs to, as far as deciding what may serve it goes. */
export type PinScope = Pick<TargetDraft, "provider" | "endpointId">;

/**
 * The accounts that could actually serve a target, for the pin picker.
 *
 * Endpoint is part of the question, not just provider. The router pairs a
 * custom target only with credentials on the same `endpointId`, and it applies
 * that check *before* the pin — so offering an account on another endpoint
 * would let the editor mint a target that saves cleanly and then reports
 * `pin:missing` on every request for the rest of its life. Same reason the
 * picker is scoped to one provider.
 */
export function pinChoices(
  scope: PinScope,
  credentials: readonly Credential[],
): ReadonlyArray<{ id: string; label: string }> {
  // The shared rule with the pin deliberately left off, so this reads "which
  // accounts could this target reach" rather than "which does it reach now".
  // Same function the router filters with, so the picker cannot offer an
  // account the router would then refuse.
  const address = { provider: scope.provider, endpointId: scope.endpointId };
  return credentials
    .filter((credential) => servesTarget(address, credential))
    .map((credential) => ({
      id: credential.id,
      label: credential.accountEmail ?? credential.label,
    }));
}

/**
 * Why a pin cannot be served, or null when it can.
 *
 * A saved pin outlives the account it names — removing a credential is not
 * refused, and neither is saving a model that still mentions it — so the editor
 * has to say what the router will do rather than hide the id or drop it.
 *
 * States the consequence, like `unreachableNote`, and states it in full: the
 * failure is the point of a pin, and an operator who reads "will fail" without
 * "rather than falling back" may reasonably assume the gateway covers for it.
 */
export function pinNote(
  credentialId: string,
  scope: PinScope,
  credentials: readonly Credential[],
): string | null {
  if (credentialId.length === 0) return null;
  // No accounts at all is unknown, not broken — the same reading `reachable`
  // takes two functions up. `ModelEditor` passes `credentials.data ?? []`, so
  // an empty list is also what a request still in flight looks like, and what a
  // failed one looks like permanently. Calling a live pin dead because a
  // listing has not arrived is the worse error of the two: it accuses working
  // configuration, in red, on a screen the operator came to for the truth.
  if (credentials.length === 0) return null;
  if (pinChoices(scope, credentials).some((choice) => choice.id === credentialId)) return null;
  return (
    "No connected account has this id. Requests routed here will fail rather than " +
    "falling back to another account."
  );
}

/**
 * Points a target at a different endpoint, dropping a pin the move invalidates.
 *
 * An account belongs to one endpoint as firmly as it belongs to one provider,
 * and the router checks endpoint before pin, so a pin carried across is one it
 * can only ever report as missing.
 */
export function reEndpointDraft(target: TargetDraft, endpointId: string): TargetDraft {
  return {
    ...target,
    endpointId,
    ...(endpointId === target.endpointId ? {} : { credentialId: "" }),
  };
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
 *
 * A pin is cleared on a provider change and kept otherwise. An account belongs
 * to one provider, so carrying it across leaves a pin that can only ever report
 * `pin:missing`; clearing it on a model change instead would undo the
 * operator's choice on every keystroke in the model field.
 */
export function retargetDraft(
  catalog: Catalog,
  target: TargetDraft,
  next: Pick<TargetDraft, "provider" | "model">,
): TargetDraft {
  return {
    ...target,
    ...next,
    ...(catalogPrices(catalog, next.provider, next.model) ?? {}),
    ...(next.provider === target.provider ? {} : { credentialId: "" }),
    contextWindow: "",
    maxOutputTokens: "",
  };
}

/**
 * A fresh target, on a named provider or on the first the catalog lists.
 *
 * The default used to be the literal `"anthropic"`. On an installation whose
 * catalog does not carry it, the provider `<Select>` in `TargetEditor` shows
 * its first option while the draft — and the model this saves — says
 * `anthropic`: a target pointed at a provider the operator never chose and the
 * screen never showed. `"anthropic"` survives only as the value for an empty
 * catalog, which the gate in `routes/_app.tsx` makes unreachable.
 */
export function blankTarget(catalog: Catalog, provider?: ProviderId): TargetDraft {
  const on = provider ?? ((catalog[0]?.id ?? "anthropic") as ProviderId);
  // Empty for a provider the catalog does not name — the same state `custom`
  // is in permanently, since the models an operator's own endpoint serves are
  // not knowable from here. The field is required and the operator fills it.
  const model = findProvider(catalog, on)?.defaultModel ?? "";
  const prices = catalogPrices(catalog, on, model);
  return {
    key: nextKey(),
    provider: on,
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
    // Any account of the provider, which is what every model saved before
    // pinning existed already means.
    credentialId: "",
    tools: true,
    images: true,
    reasoning: true,
  };
}

export function blankModel(catalog: Catalog): ModelDraft {
  return { id: "", strategy: "score", isAlias: false, targets: [blankTarget(catalog)] };
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
      credentialId: target.credentialId ?? "",
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
    const credentialId = target.credentialId.trim();
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
      // Omitted rather than sent empty: the control schema refuses "" because
      // it is an id nothing matches, not a third state between pinned and not.
      ...(credentialId.length > 0 ? { credentialId } : {}),
      capabilities: { tools: target.tools, images: target.images, reasoning: target.reasoning },
    });
  }

  return { ok: true, model: { id, strategy: draft.strategy, isAlias: draft.isAlias, targets } };
}
