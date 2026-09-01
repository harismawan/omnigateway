import type { ProviderId } from "@omni/ir";
import { builtinOAuthFlows } from "@omni/providers";
import { oauthAdapter } from "./pluginFlow.ts";
import type { OAuthProvider } from "./types.ts";

/**
 * Every OAuth flow this process can run, filled at boot and never at import.
 *
 * Empty here, and that emptiness is the point. It was a five-key literal of
 * built-ins, which meant core compiled five vendors' authorize endpoints,
 * scopes and client ids in — rule 16's last enumerated violation. The vendor
 * data now lives in `@omni/providers`, where rule 2 puts provider wire detail,
 * and every flow — built-in or plugin-supplied — arrives through
 * `registerOAuthProvider`. A built-in is no longer privileged by being written
 * into a literal; it is privileged only by `trusted`, which follows authorship.
 *
 * Nothing to inherit, for the reason given on `PROVIDER_DESCRIPTORS` — and this
 * table is the one where it bites hardest. `refresh.ts` reads it by a *stored*
 * `credential.provider` and relies on `undefined` to raise a clean
 * `BAD_REQUEST`; on an ordinary literal, `OAUTH_PROVIDERS["constructor"]`
 * answers the `Object` constructor, so the guard passes and `provider.refresh`
 * throws a raw `TypeError` that `classify` turns into `INTERNAL`. That is the
 * same failure, with the same signature, as the one `resolveModel` shipped.
 *
 * `PROVIDER_ID_PATTERN` accepts `constructor`, so nothing upstream stops such
 * an id being stored. `Object.create(null)` rather than a literal plus
 * `setPrototypeOf`, because there is no longer a literal to write.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProvider> = Object.create(null);

/**
 * Installs the five flows this repository ships.
 *
 * Called by the gateway from `installPluginProviders` — which is **after**
 * `loadPlugins`, and safe only because the loader registers no flow — and by
 * the CLI from `run()`, because `omni connect` runs without a gateway. Two
 * callers because there are two hosts, one seed because two copies of the list
 * is a pair that drifts. Idempotent, so a
 * test or a second `createContext` in one process is not a crash: the built-ins
 * are the same five values either way, and `registerOAuthProvider`'s refusal
 * exists to stop a *plugin* shadowing an installed id, not to police a repeated
 * seed.
 *
 * `trusted: true` for all five. `oauthAdapter` sets `gatewayAuthored` only for
 * a trusted flow, and these remain repository-authored after the move — their
 * text is still ours. A plugin-declared flow keeps `trusted: false`. The flag
 * follows authorship, not packaging.
 */
/**
 * Which built-in ids this process installed into which registry.
 *
 * Keyed on the registry itself, **not** a module-scope boolean, and that is the
 * difference between a guard that works and one that only looks like it. The
 * boolean latched: once anything in a Bun test process had seeded, every later
 * `seedBuiltinOAuth()` was a no-op, so a test asserting "boot installs the five"
 * read whatever an earlier *file* had installed. Measured — deleting the
 * gateway's seed left the whole suite green, which is the round-1 defect this
 * function was moved to fix, reproduced inside its own fix.
 *
 * A set of **ids** rather than a set of registries, which is the second
 * iteration: marking the whole registry "seeded" made a deleted built-in
 * unrecoverable — measured, a reseed left it at four providers — so the
 * invariant "nothing deletes a built-in" was load-bearing and unstated.
 * Recording what we installed lets a reseed tell the three cases apart:
 * ours and still present (skip), ours and gone (reinstall), someone else's
 * (collide, and throw).
 */
const seededIds = new WeakMap<Record<string, OAuthProvider>, Set<string>>();

/**
 * @param registry - which table to fill; defaults to the process-wide one.
 *   Injected so a test can drive a fresh registry and observe *this call's*
 *   effect. Threaded through `registerOAuthProvider` too, because a registry
 *   threaded into part of a call graph and not all of it is this repository's
 *   most repeated bug.
 */
export function seedBuiltinOAuth(registry: Record<string, OAuthProvider> = OAUTH_PROVIDERS): void {
  const ours = seededIds.get(registry) ?? new Set<string>();
  seededIds.set(registry, ours);

  // `builtinOAuthFlows()` is called here, not read as a module-scope constant.
  // Six sites in this repository have been wrong by walking a provider table at
  // import time, and nothing in this migration may reintroduce one.
  for (const [id, flow] of builtinOAuthFlows()) {
    // Skip only what **we** installed and that is still there. A bare
    // `Object.hasOwn(registry, id)` reads as "already seeded" and also silently
    // accepts "a plugin got here first" — the case that must reach
    // `registerOAuthProvider`'s throw, which the `else` below lets it do.
    if (ours.has(id) && Object.hasOwn(registry, id)) continue;
    registerOAuthProvider(id, oauthAdapter(id, flow, { trusted: true }), registry);
    ours.add(id);
  }
}

/**
 * Which providers there is an authorization to start, in the order an operator
 * is offered them.
 *
 * Derived from the table above rather than written beside it, because the two
 * lists that used to name these by hand — one in `start`'s error, one in the
 * CLI's usage — were free to disagree with it and with each other, and did:
 * both enumerated five providers while the guard in front of them accepted six.
 */
export function oauthProviderIds(
  providers: Readonly<Record<string, OAuthProvider>> = OAUTH_PROVIDERS,
): readonly ProviderId[] {
  return Object.keys(providers) as ProviderId[];
}

/**
 * Installs an OAuth flow a plugin supplied.
 *
 * The parallel of `registerProvider`, and it obeys the same ordering rule for
 * the same reason: every consumer reads its providers at call time from a map
 * it was handed, so a flow added before `createApp` is visible to connect,
 * refresh and the usage poller with no further wiring — and one added after
 * would exist for some requests and not others, which is a race rather than a
 * feature.
 *
 * **Not for the CLI.** It never calls `loadPlugins` and must not; it merges what
 * `readPluginProviders` read instead, which is the same declaration without
 * running the plugin's `setup`.
 *
 * Refuses to replace an existing id. A plugin shadowing `anthropic` would take
 * its authorization flow and its stored credentials, and the failure would be
 * silent.
 */
export function registerOAuthProvider(
  id: ProviderId,
  provider: OAuthProvider,
  registry: Record<string, OAuthProvider> = OAUTH_PROVIDERS,
): void {
  if (Object.hasOwn(registry, id)) {
    throw new Error(`an oauth flow for ${id} is already installed`);
  }
  registry[id] = provider;
}

export type {
  AuthorizeStart,
  DeviceOAuthProvider,
  FlowResult,
  OAuthDeps,
  OAuthProvider,
  PendingFlow,
  PkceOAuthProvider,
} from "./types.ts";
export { isAuthorizationPending } from "./types.ts";
