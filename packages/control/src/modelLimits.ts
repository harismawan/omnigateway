import type { ProviderId } from "@omni/ir";
import { type CatalogAuth, catalogLimits, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import type { Target, VirtualModel } from "@omni/store";

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
 * The credential facts this needs: which ways in a provider actually has. Only
 * `provider` and `authType` are read, so a `CredentialView` from the store
 * satisfies it without anything here touching a secret.
 */
export type ServingCredential = { provider: ProviderId; authType: CatalogAuth; enabled: boolean };

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
 */
function targetLimits(target: Target, auths: ReadonlySet<CatalogAuth>): ModelLimits {
  // No credential for this provider: nothing can serve the target, so there is
  // no serving path to narrow to and the published figures are the honest
  // answer.
  const ways: CatalogAuth[] = auths.size === 0 ? ["apiKey"] : [...auths];
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

/** Which ways in each provider has, from the credentials that can route. */
function servingAuths(
  credentials: readonly ServingCredential[],
): Map<ProviderId, Set<CatalogAuth>> {
  const byProvider = new Map<ProviderId, Set<CatalogAuth>>();
  for (const credential of credentials) {
    if (!credential.enabled) continue;
    const ways = byProvider.get(credential.provider) ?? new Set<CatalogAuth>();
    ways.add(credential.authType);
    byProvider.set(credential.provider, ways);
  }
  return byProvider;
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
 * `credentials` is required rather than defaulted: an empty list is not
 * "unknown", it is "nothing serves this provider", which resolves to the widest
 * published figures. A caller that forgot the argument would get that answer
 * silently, and on an OAuth-only installation it is the wrong one.
 */
export function resolveModelLimits(
  model: VirtualModel,
  credentials: readonly ServingCredential[],
): ModelLimits {
  const auths = servingAuths(credentials);
  let limits: ModelLimits = {};
  for (const target of model.targets) {
    limits = narrower(
      limits,
      targetLimits(target, auths.get(target.provider) ?? new Set<CatalogAuth>()),
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
