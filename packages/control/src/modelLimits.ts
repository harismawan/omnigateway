import type { ProviderId } from "@omni/ir";
import { type CatalogAuth, catalogLimits, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { resolvePin, type Target, type VirtualModel } from "@omni/store";

/**
 * How much a virtual model holds, and what to call it.
 *
 * Lives here rather than beside the `/v1/models` route because it is not an
 * HTTP concern: `GET /v1/models` states these figures to a client, and the CLI
 * writes the same ones into an agent's configuration file, because no agent in
 * this set reads its context window from the listing. Two places deriving the
 * window separately is two places to be wrong in, and an operator would have no
 * way to tell which one was.
 */

/**
 * The credential facts this needs: which ways in a provider actually has, and
 * which account each one is. Nothing here is a secret, so a `CredentialView`
 * from the store satisfies it as it stands.
 *
 * `id` is required rather than optional because a target can be pinned to one
 * account, and a caller that omitted it would silently make every pin
 * unresolvable — the listing would keep answering, just with the wrong figures,
 * which is the failure mode this whole module exists to prevent.
 */
export type ServingCredential = {
  id: string;
  provider: ProviderId;
  authType: CatalogAuth;
  enabled: boolean;
  /**
   * Carried because a custom endpoint is part of whether an account can serve a
   * target at all, and the shared rule reads it. Without it a pin at a custom
   * account on another endpoint would resolve here and be described by that
   * account's way in, while the router refuses it as `pin:missing`.
   */
  providerData: Record<string, unknown>;
};

export type ModelLimits = { contextWindow?: number; maxOutputTokens?: number };

/** The narrower of two limits, treating an unknown figure as no constraint. */
function narrower(a: ModelLimits, b: ModelLimits): ModelLimits {
  const context = [a.contextWindow, b.contextWindow].filter((n) => n !== undefined);
  const output = [a.maxOutputTokens, b.maxOutputTokens].filter((n) => n !== undefined);
  return {
    ...(context.length === 0 ? {} : { contextWindow: Math.min(...context) }),
    ...(output.length === 0 ? {} : { maxOutputTokens: Math.min(...output) }),
  };
}

/**
 * What one target holds, given who can serve it.
 *
 * A figure the operator saved on the target wins outright: it is the only place
 * an account's own limits can be stated. Otherwise the catalog answers, and the
 * answer depends on how the credential authenticates — an OAuth credential for
 * OpenAI is routed to the Codex backend, whose 272K window is under a third of
 * the API's. A provider offering both ways in is described by the narrower,
 * for the same reason a pool is described by its smallest member: the router
 * decides per request, and the client sizes its context once.
 *
 * A pinned target is the exception, and it is the same reasoning read the other
 * way: the narrowing is justified by failover landing anywhere in the provider,
 * and a pin means it cannot. Such a target is described by its own account's
 * way in alone, so an installation holding an OpenAI key beside a Codex
 * subscription stops advertising 272K for the target that reaches 922K.
 */
function targetLimits(
  target: Target,
  auths: ReadonlySet<CatalogAuth>,
  pinned: ServingCredential | undefined,
): ModelLimits {
  // No credential for this provider: nothing can serve the target, so there is
  // no serving path to narrow to and the published figures are the honest
  // answer.
  const ways: CatalogAuth[] =
    pinned !== undefined ? [pinned.authType] : auths.size === 0 ? ["apiKey"] : [...auths];
  let listed: ModelLimits = {};
  for (const auth of ways) {
    const entry = catalogLimits(target.provider, target.model, auth);
    if (entry === null) continue;
    listed = narrower(listed, {
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
    });
  }

  const contextWindow = target.contextWindow ?? listed.contextWindow;
  const maxOutputTokens = target.maxOutputTokens ?? listed.maxOutputTokens;
  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

/**
 * Which ways in each provider has, and the accounts a pin may resolve against,
 * from the credentials that can route.
 *
 * One filtered pass feeds both, so a pin can never resolve to an account the
 * provider-wide answer left out.
 *
 * A pin that does not resolve — deleted, disabled, another provider, another
 * custom endpoint, all of which the router reports alike as `pin:missing` —
 * falls back to the provider-wide narrowing rather than to the catalog's
 * published figures, and the direction matters: narrowing across every way in
 * is by construction no wider than any single one of them, so an unresolvable
 * pin never advertises more than the same target would unpinned. The opposite
 * reading would state a window for an account that does not exist, and the
 * request fails anyway.
 */
function servingAuths(credentials: readonly ServingCredential[]): {
  byProvider: Map<ProviderId, Set<CatalogAuth>>;
  routable: ServingCredential[];
} {
  const byProvider = new Map<ProviderId, Set<CatalogAuth>>();
  const routable: ServingCredential[] = [];
  for (const credential of credentials) {
    if (!credential.enabled) continue;
    const ways = byProvider.get(credential.provider) ?? new Set<CatalogAuth>();
    ways.add(credential.authType);
    byProvider.set(credential.provider, ways);
    routable.push(credential);
  }
  return { byProvider, routable };
}

/**
 * The limits a virtual model advertises: the smallest any of its targets holds.
 *
 * A pool is one model to the client but several upstreams to the gateway, and
 * failover can land on any of them. Advertising the largest window would make a
 * request that fits the primary fail on the target it fails over to, so the
 * pool is described by its narrowest member. A model where nothing is known
 * reports nothing at all, which leaves the client on its own default exactly as
 * before.
 *
 * A pin narrows which accounts serve one target; it says nothing about the
 * other targets, so the pool is still described by its narrowest member.
 *
 * `credentials` is required rather than defaulted: an empty list is not
 * "unknown", it is "nothing serves this provider", which resolves to the widest
 * published figures. A caller that forgot the argument would get that answer
 * silently, and on an OAuth-only installation it is the wrong one.
 */
export function resolveModelLimits(
  model: VirtualModel,
  credentials: readonly ServingCredential[],
): ModelLimits {
  const { byProvider, routable } = servingAuths(credentials);
  let limits: ModelLimits = {};
  for (const target of model.targets) {
    limits = narrower(
      limits,
      targetLimits(
        target,
        byProvider.get(target.provider) ?? new Set<CatalogAuth>(),
        resolvePin(target, routable),
      ),
    );
  }
  return limits;
}

/**
 * A readable name for the pool: the catalog's label for the model it routes to,
 * where that is the whole story. A pool of several targets keeps the operator's
 * own id, because no one target's label describes the others, and so does a
 * model the catalog does not list.
 */
export function modelDisplayName(model: VirtualModel): string {
  const only = model.targets.length === 1 ? model.targets[0] : undefined;
  if (only === undefined) return model.id;
  const labelled = PROVIDER_MODEL_CATALOG[only.provider]?.models.find(
    (choice) => choice.id === only.model,
  );
  return labelled?.label ?? model.id;
}
