import type { ProviderId } from "@omni/ir";
import { type CatalogAuth, catalogLimits, PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import type { Target, VirtualModel } from "@omni/store";

/**
 * One entry of `GET /v1/models`, in both dialects at once.
 *
 * The gateway serves Anthropic-compatible and OpenAI-compatible clients from a
 * single listing, so an entry carries both spellings of the same facts rather
 * than the surface being split in two: `object`/`created`/`owned_by` are what
 * an OpenAI client reads, `type`/`display_name`/`created_at`/`max_input_tokens`
 * what an Anthropic one reads. Neither is troubled by the other's keys.
 *
 * `max_input_tokens` is the field that matters: a client that cannot read a
 * context window falls back to its own default — 200K in Claude Code's case,
 * for every model — so a 1M-context target silently loses 800K of it.
 */
export type ModelDescription = {
  id: string;
  object: "model";
  type: "model";
  display_name: string;
  created: number;
  created_at: string;
  owned_by: string;
  max_input_tokens?: number;
  max_tokens?: number;
};

export type ModelListBody = {
  object: "list";
  data: ModelDescription[];
  has_more: false;
  first_id: string | null;
  last_id: string | null;
};

/**
 * The credential facts the listing needs: which ways in a provider actually
 * has. Only `provider` and `authType` are read, so a `CredentialView` from the
 * store satisfies it without the listing touching a secret.
 */
export type ServingCredential = { provider: ProviderId; authType: CatalogAuth; enabled: boolean };

/** Virtual models carry no creation time, so every entry reports the epoch. */
const CREATED_AT = new Date(0).toISOString();

type Limits = { contextWindow?: number; maxOutputTokens?: number };

/** The narrower of two limits, treating an unknown figure as no constraint. */
function narrower(a: Limits, b: Limits): Limits {
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
function targetLimits(target: Target, auths: ReadonlySet<CatalogAuth>): Limits {
  // No credential for this provider: nothing can serve the target, so there is
  // no serving path to narrow to and the published figures are the honest
  // answer.
  const ways: CatalogAuth[] = auths.size === 0 ? ["apiKey"] : [...auths];
  let listed: Limits = {};
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
 * The limits a virtual model advertises: the smallest any of its targets holds.
 *
 * A pool is one model to the client but several upstreams to the gateway, and
 * failover can land on any of them. Advertising the largest window would make a
 * request that fits the primary fail on the target it fails over to, so the
 * pool is described by its narrowest member. A model where nothing is known
 * reports nothing at all, which leaves the client on its own default exactly as
 * before.
 */
function limitsOf(model: VirtualModel, authsByProvider: Map<ProviderId, Set<CatalogAuth>>): Limits {
  let limits: Limits = {};
  for (const target of model.targets) {
    limits = narrower(
      limits,
      targetLimits(target, authsByProvider.get(target.provider) ?? new Set<CatalogAuth>()),
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
function displayName(model: VirtualModel): string {
  const only = model.targets.length === 1 ? model.targets[0] : undefined;
  if (only === undefined) return model.id;
  const labelled = PROVIDER_MODEL_CATALOG[only.provider]?.models.find(
    (choice) => choice.id === only.model,
  );
  return labelled?.label ?? model.id;
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
 * `credentials` is required rather than defaulted: an empty list is not
 * "unknown", it is "nothing serves this provider", which resolves to the
 * widest published figures. A caller that forgot the argument would get that
 * answer silently, and on an OAuth-only installation it is the wrong one.
 */
export function describeModel(
  model: VirtualModel,
  credentials: readonly ServingCredential[],
): ModelDescription {
  const limits = limitsOf(model, servingAuths(credentials));
  return {
    id: model.id,
    object: "model",
    type: "model",
    display_name: displayName(model),
    created: 0,
    created_at: CREATED_AT,
    owned_by: "omnigateway",
    ...(limits.contextWindow === undefined ? {} : { max_input_tokens: limits.contextWindow }),
    ...(limits.maxOutputTokens === undefined ? {} : { max_tokens: limits.maxOutputTokens }),
  };
}

export function modelListBody(
  models: readonly VirtualModel[],
  credentials: readonly ServingCredential[],
): ModelListBody {
  const data = models.map((model) => describeModel(model, credentials));
  return {
    object: "list",
    data,
    // The listing is never paginated: an installation configures tens of
    // models, not thousands, and a client that follows the cursor would loop.
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  };
}
