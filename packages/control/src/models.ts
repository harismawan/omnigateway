import { GatewayError, type ProviderId } from "@omni/ir";
import { type CatalogAuth, entryModelAuths, UNKNOWN_PROVIDER_AUTHS } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import {
  type Credential,
  resolvePin,
  type Store,
  type Target,
  type VirtualModel,
} from "@omni/store";
import { modelSchema, parseOrThrow } from "./schemas.ts";

export async function listModels(store: Store): Promise<VirtualModel[]> {
  return store.config.listModels();
}

export async function getModel(store: Store, id: string): Promise<VirtualModel> {
  const model = (await store.config.listModels()).find((m) => m.id === id);
  if (model === undefined) throw new GatewayError("MODEL_UNAVAILABLE", `no virtual model "${id}"`);
  return model;
}

const AUTH_LABEL: Readonly<Record<CatalogAuth, string>> = {
  oauth: "OAuth",
  apiKey: "API key",
};

/** Reads as prose: "OAuth", "API key", "OAuth or API key". */
function phrase(auths: readonly CatalogAuth[]): string {
  return auths.map((auth) => AUTH_LABEL[auth]).join(" or ");
}

/**
 * Which ways in the installation actually holds, per provider.
 *
 * Existence, not `enabled`. A credential the gateway disabled after one
 * rejected token is still the operator's way into that provider, and letting a
 * transient auth failure make an unrelated target unsavable would turn one
 * broken account into a locked console. `resolveModelLimits` filters on
 * `enabled` for the opposite and correct reason: it describes what can serve a
 * request right now, whereas this describes what the installation is
 * configured for.
 */
function heldAuths(credentials: readonly Credential[]): Map<ProviderId, Set<CatalogAuth>> {
  const byProvider = new Map<ProviderId, Set<CatalogAuth>>();
  for (const credential of credentials) {
    const ways = byProvider.get(credential.provider) ?? new Set<CatalogAuth>();
    ways.add(credential.authType);
    byProvider.set(credential.provider, ways);
  }
  return byProvider;
}

/** A target's identity for the purpose of "was this already saved". */
function pairOf(target: Target): string {
  return `${target.provider}\u0000${target.model}`;
}

/**
 * Refuses a target no credential this installation holds could ever reach.
 *
 * Kilo splits its catalog by backend: the `:free` tier and the `kilo-auto/*`
 * routers are served to an API key and not to a subscription token. An operator
 * holding only OAuth who points a target at one gets a billing or entitlement
 * error from Kilo at request time, which reads as anything but a routing bug.
 * Saying so at save time is the whole point.
 *
 * Three states, deliberately not treated alike:
 *
 * - **Both ways in, or the only one that works**: nothing to say.
 * - **No credential for the provider at all**: also nothing to say. Composing
 *   models before connecting accounts is a normal order to work in, and there
 *   is no evidence yet about which way in this installation will have. Refusing
 *   here would make the console demand accounts in an order it never stated.
 * - **Credentials exist and none reaches the model**: refused, with the two
 *   sets named so the fix is obvious.
 *
 * And one exemption: a target already stored under this id, unchanged, passes
 * whatever the credentials now say. Removing an API key must not make the model
 * that used it unsavable — the operator would be unable to edit the target's
 * tier without first deleting a target they may be about to restore access to.
 * A target whose model or provider is *edited* is judged fresh, because that is
 * the operator asserting something new rather than carrying something forward.
 *
 * A **pinned** target replaces the provider's whole set with the pinned
 * account's one way in, because the pin is hard: a sibling of the other kind is
 * no longer evidence that anything can serve this target, and saving it anyway
 * strands every request with nothing to fail over to — a worse outcome than the
 * unpinned case this check was written for.
 *
 * The exemption does not cover that. It is deliberately *not* expressed by
 * keying `pairOf` on the pin, which would judge an edit of the pin alone fresh
 * and re-run the provider-wide check on it — and that check is exactly the one
 * a vanished credential can fail, so clearing a dangling pin, the repair an
 * operator makes after removing an account, could be refused while the broken
 * shape it replaces still saved. Instead the pin check simply is not
 * grandfatherable: it only fires when the named account exists *right now*, so
 * removing a credential can only ever silence it, never make it refuse. That
 * keeps "removing an account must not make an unrelated edit unsavable" true by
 * construction, and a target the operator repoints at an account that cannot
 * reach the model is still refused.
 */
function unreachable(
  model: VirtualModel,
  credentials: readonly Credential[],
  stored: VirtualModel | undefined,
): GatewayError | null {
  const held = heldAuths(credentials);
  const grandfathered = new Set((stored?.targets ?? []).map(pairOf));
  for (const target of model.targets) {
    // Resolved through the shared rule, so a pin at another provider — or at a
    // custom account on another endpoint — is unresolvable here for exactly the
    // reason the router calls it `pin:missing`, and cannot launder the
    // provider-wide refusal by looking like a valid pin.
    //
    // Every credential, not just the enabled ones, for the same reason
    // `heldAuths` counts a disabled one: a rejected token is still the
    // operator's way into that account.
    const pinned = resolvePin(target, credentials);
    // Only the provider-wide reading is grandfathered; see the note above on
    // why the pin check is not.
    if (pinned === undefined && grandfathered.has(pairOf(target))) continue;
    const have = pinned === undefined ? held.get(target.provider) : new Set([pinned.authType]);
    if (have === undefined) continue;
    // The **descriptor registry** at call time, not `PROVIDER_MODEL_CATALOG`.
    // `registerProvider` mutates the first and never the second, so a provider
    // loaded from `<root>/plugins/` is only ever in the first — and asking the
    // second about one returned the fail-open default while its descriptor sat
    // there declaring `auth: ["oauth"]`. `putModel` then saved a target whose
    // model the operator's only account cannot reach, while the console's
    // picker, reading the same fact off `/api/catalog`, hid it.
    //
    // A plain index read, deliberately. `target.provider` is unvalidated input —
    // `sqlite/config.ts` parses stored targets with no schema — so `constructor`
    // can arrive here, and on an ordinary object literal that answers the `Object`
    // constructor rather than `undefined`. What makes this safe is that
    // `PROVIDER_DESCRIPTORS` has a null prototype, which is the invariant
    // `packages/control/test/providerTables.test.ts` discovers and enforces.
    //
    // An `Object.hasOwn` here was written first and removed: every mutant of it
    // survived, because the invariant already decides the case. CLAUDE.md names
    // that exact move — a guard at the reader covers only the readers that ask
    // existence, and partial protection reading as total is worse than none.
    const entry = PROVIDER_DESCRIPTORS[target.provider]?.catalog;
    // Unknown provider keeps the shared default rather than a local one: an
    // empty set here would read as "no credential can reach this" and refuse
    // every target naming a provider this build does not contain.
    const reach =
      entry === undefined ? UNKNOWN_PROVIDER_AUTHS : entryModelAuths(entry, target.model);
    if (reach.some((auth) => have.has(auth))) continue;
    // The pinned case names the account rather than the provider's whole set:
    // told "every kilo credential here is OAuth" while holding an API key, an
    // operator would go looking for an account they already have.
    const holds =
      pinned === undefined
        ? `every ${target.provider} credential here is ${phrase([...have])}`
        : `this target is pinned to "${pinned.label}", which is ${phrase([...have])}`;
    const fix =
      pinned === undefined
        ? "connect the other kind, or pick a model this one can reach"
        : "pin it to the other kind, or pick a model this account can reach";
    return new GatewayError(
      "BAD_REQUEST",
      `${target.provider} serves "${target.model}" to ${phrase(reach)} credentials only, ` +
        `and ${holds} — ${fix}`,
    );
  }
  return null;
}

/**
 * Validates and writes a virtual model.
 *
 * `id` is passed separately because the HTTP surface carries it in the path;
 * a body naming a different model is a mistake worth refusing rather than
 * silently resolving one way or the other.
 *
 * The two credential checks below are the same kind of rule and live here for
 * the same reason: they read installation state, so no schema can express them,
 * and both the console's `PUT /api/models/:id` and `omni models` write through
 * this function. A rule enforced in the dashboard alone is not enforced.
 */
export async function putModel(store: Store, id: string, input: unknown): Promise<void> {
  const model: VirtualModel = parseOrThrow(modelSchema, input);
  if (model.id !== id) {
    throw new GatewayError("BAD_REQUEST", "model id in the path and body must match");
  }
  const credentials = await store.credentials.list();
  const customEndpointIds = new Set(
    credentials
      .filter((credential) => credential.provider === "custom")
      .map((credential) => credential.providerData.endpointId)
      .filter((endpointId): endpointId is string => typeof endpointId === "string"),
  );
  const missing = model.targets.find(
    (target) =>
      target.provider === "custom" &&
      (target.endpointId === undefined || !customEndpointIds.has(target.endpointId)),
  );
  if (missing !== undefined) {
    throw new GatewayError(
      "BAD_REQUEST",
      `custom endpoint "${missing.endpointId}" has no credential`,
    );
  }

  const stranded = unreachable(
    model,
    credentials,
    (await store.config.listModels()).find((existing) => existing.id === id),
  );
  if (stranded !== null) throw stranded;

  await store.config.putModel(model);
}

export async function removeModel(store: Store, id: string): Promise<void> {
  await store.config.removeModel(id);
}
