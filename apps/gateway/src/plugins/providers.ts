import type { ProviderAdapter, ProviderCodec, ProviderDescriptor } from "@omni/providers";
import { codecAdapter, isProviderIdFormat, PROVIDER_ID_PATTERN } from "@omni/providers";

/**
 * What a plugin registered, joined into the two tables routing reads.
 *
 * The host keeps its own record rather than writing straight into
 * `PROVIDER_DESCRIPTORS` and `ADAPTERS`, so that a plugin that fails later in
 * `setup` can be skipped whole. A provider half-registered by a plugin the host
 * then rejected would be worse than one that never registered: routing would
 * admit it and dispatch would throw `INTERNAL` on every request.
 */
export type RegisteredProvider = {
  descriptor: ProviderDescriptor;
  adapter: ProviderAdapter;
};

/**
 * The structural checks behind `validateRegistration`'s field loop.
 *
 * Split out because the list is long and the reason each entry is on it is the
 * same one sentence: some consumer dereferences that field without asking. Each
 * failure names the path, because "provider acme is malformed" sends a plugin
 * author to read their whole descriptor.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number. `NaN` and the infinities are prices that corrupt a total silently. */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function checkAt(ok: boolean, id: string, path: string, expected: string): void {
  if (!ok) throw new Error(`provider ${id} descriptor: ${path} must be ${expected}`);
}

function checkLimits(id: string, path: string, value: unknown): void {
  checkAt(isRecord(value), id, path, "an object");
  const limits = value as Record<string, unknown>;
  checkAt(isNumber(limits.contextWindow), id, `${path}.contextWindow`, "a finite number");
  checkAt(isNumber(limits.maxOutputTokens), id, `${path}.maxOutputTokens`, "a finite number");
}

function checkDescriptor(id: string, record: Record<string, unknown>): void {
  // Absence first, and phrased as absence. An author who left a field out and
  // one who spelled its shape wrong are looking for two different things, and
  // "catalog must be an object" sends the first to stare at a field they never
  // wrote.
  for (const field of [
    "capabilities",
    "writeOverInput",
    "catalog",
    "modelPrefixes",
    "presentation",
  ] as const) {
    if (record[field] === undefined) {
      throw new Error(`provider ${id} is missing ${field}`);
    }
  }

  const capabilities = record.capabilities;
  checkAt(isRecord(capabilities), id, "capabilities", "an object");
  for (const flag of ["tools", "images", "reasoning"] as const) {
    const value = (capabilities as Record<string, unknown>)[flag];
    checkAt(typeof value === "boolean", id, `capabilities.${flag}`, "a boolean");
  }

  // Read by `priceOf` inside `finishLog`, where a throw would break usage
  // accounting for a request that already succeeded — so it is checked here or
  // it is not checked anywhere it can still be reported.
  const write = record.writeOverInput;
  checkAt(isRecord(write), id, "writeOverInput", "an object");
  for (const ttl of ["fiveMinute", "oneHour"] as const) {
    const value = (write as Record<string, unknown>)[ttl];
    checkAt(isNumber(value), id, `writeOverInput.${ttl}`, "a finite number");
  }

  const catalog = record.catalog;
  checkAt(isRecord(catalog), id, "catalog", "an object");
  const entry = catalog as Record<string, unknown>;
  checkAt(typeof entry.defaultModel === "string", id, "catalog.defaultModel", "a string");
  checkAt(Array.isArray(entry.authTypes), id, "catalog.authTypes", "an array");
  for (const [index, auth] of (entry.authTypes as unknown[]).entries()) {
    const known = auth === "oauth" || auth === "apiKey";
    checkAt(known, id, `catalog.authTypes[${index}]`, `"oauth" or "apiKey"`);
  }
  checkAt(Array.isArray(entry.models), id, "catalog.models", "an array");
  for (const [index, model] of (entry.models as unknown[]).entries()) {
    const at = `catalog.models[${index}]`;
    checkAt(isRecord(model), id, at, "an object");
    const choice = model as Record<string, unknown>;
    checkAt(typeof choice.id === "string", id, `${at}.id`, "a string");
    checkAt(typeof choice.label === "string", id, `${at}.label`, "a string");
    checkAt(isRecord(choice.pricing), id, `${at}.pricing`, "an object");
    const pricing = choice.pricing as Record<string, unknown>;
    for (const field of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) {
      checkAt(isNumber(pricing[field]), id, `${at}.pricing.${field}`, "a finite number");
    }
    checkLimits(id, `${at}.limits`, choice.limits);
    // Absent means one set of limits covers both ways in, so absence is a fact
    // rather than a gap. Present-and-malformed is still refused.
    if (choice.oauthLimits !== undefined) {
      checkLimits(id, `${at}.oauthLimits`, choice.oauthLimits);
    }
  }

  const prefixes = record.modelPrefixes;
  checkAt(Array.isArray(prefixes), id, "modelPrefixes", "an array");
  for (const [index, prefix] of (prefixes as unknown[]).entries()) {
    checkAt(typeof prefix === "string", id, `modelPrefixes[${index}]`, "a string");
  }

  const presentation = record.presentation;
  checkAt(isRecord(presentation), id, "presentation", "an object");
  const shown = presentation as Record<string, unknown>;
  for (const field of ["label", "tone"] as const) {
    checkAt(typeof shown[field] === "string", id, `presentation.${field}`, "a string");
  }
  checkAt(isNumber(shown.order), id, "presentation.order", "a finite number");
  checkAt(isRecord(shown.colour), id, "presentation.colour", "an object");
  for (const scheme of ["light", "dark"] as const) {
    const value = (shown.colour as Record<string, unknown>)[scheme];
    // A string, not a *safe* colour: `isPaletteSafeColour` in `@omni/control`
    // decides that, and it already substitutes a neutral rather than failing.
    // Refusing the whole provider for an unrenderable colour would be a worse
    // trade than showing it grey.
    checkAt(typeof value === "string", id, `presentation.colour.${scheme}`, "a string");
  }
  if (shown.pasteHint !== undefined) {
    checkAt(typeof shown.pasteHint === "string", id, "presentation.pasteHint", "a string");
  }
}

/**
 * Validates what a plugin passed to `ctx.provider.register`.
 *
 * `PluginProviderRegistry` types its argument as `unknown` — that package is
 * published and cannot import `@omni/ir`, so the real types are not available
 * to it until a later sub-project. This is where that looseness is paid for:
 * nothing is trusted because it typechecked on the plugin's side.
 *
 * Every failure throws. `setup` failures skip the plugin and are reported, which
 * is rule 15 and is what makes this safe to be strict about: the cost of
 * refusing a malformed provider is one plugin missing, never a gateway that will
 * not boot.
 */
export function validateRegistration(
  pluginId: string,
  entry: { descriptor: unknown; codec: unknown },
): RegisteredProvider {
  const descriptor = entry.descriptor;
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new Error("provider registration needs a descriptor object");
  }

  const record = descriptor as Record<string, unknown>;
  const id = record.id;
  // The shared predicate rather than the pattern open-coded. It narrows to
  // `ProviderId`, which is what lets the rest of this function treat `id` as
  // one — and it had no caller until now, which the design note said meant
  // either this or deleting it.
  if (!isProviderIdFormat(id)) {
    throw new Error(
      `provider id ${JSON.stringify(id)} is not a usable provider id; ` +
        `expected ${PROVIDER_ID_PATTERN.source}`,
    );
  }

  // The id is the plugin's own, and the host does not take its word for it. A
  // plugin registering a provider under another plugin's name would take that
  // name's traffic, its credentials and its `--p-<id>` colour; the same rule
  // keeps `plugin:<id>:` topics and `plugin_<id>_` tables inside their owner.
  // Both ids are named, because "id mismatch" sends a reader to look at one.
  if (id !== pluginId) {
    throw new Error(
      `plugin ${pluginId} registered a provider named ${id}; a plugin may only register its own id`,
    );
  }

  // Required with no defaults, exactly as a built-in descriptor is. The failure
  // this prevents is `writeOverInput` defaulting to zero, which underprices
  // cache writes silently and permanently.
  //
  // Checked **structurally**, not for presence. `!== undefined` was what this
  // did first, and it admitted `catalog: 42` and `catalog: {}` — which the
  // router then dereferenced as `entry.models.find(…)`, throwing a raw
  // `TypeError` out of `resolveModel`. `classify` reads that `INTERNAL`,
  // `RETRYABLE.INTERNAL` is false, and the message reaches the client body: the
  // same shape as the `constructor/foo` bug, re-opened through a different
  // table. `/api/catalog` had the twin, where a 500 turns the console's
  // all-or-nothing gate into "Console unavailable" on every screen.
  //
  // The rule for what is checked here is exactly "what a consumer
  // dereferences", and nothing beyond it. A validator that went deeper would be
  // asserting taste rather than safety, and one that went shallower would leave
  // the next consumer to find out at runtime — which is what happened. The
  // consumers are `entryPricing`/`entryLimits` in the router, `providerCatalog`
  // in `@omni/control`, `priceOf` in dispatch, and the palette.
  checkDescriptor(id, record);

  const codec = entry.codec;
  if (typeof codec !== "object" || codec === null) {
    throw new Error(`provider ${id} registered no codec`);
  }
  const codecRecord = codec as Record<string, unknown>;
  for (const fn of ["buildRequest", "decode"] as const) {
    if (typeof codecRecord[fn] !== "function") {
      throw new Error(`provider ${id} codec has no ${fn}`);
    }
  }
  if (codecRecord.classifyError !== undefined && typeof codecRecord.classifyError !== "function") {
    throw new Error(`provider ${id} codec has a non-callable classifyError`);
  }

  const typed = descriptor as ProviderDescriptor;
  return {
    descriptor: typed,
    adapter: codecAdapter(id, typed.capabilities, codec as ProviderCodec),
  };
}

/**
 * Collects one plugin's registrations during its `setup`.
 *
 * Registrations are held here and applied by the loader once `setup` has
 * returned without throwing, rather than written into the live tables as they
 * arrive — see `RegisteredProvider` for why a half-registered provider is worse
 * than an absent one.
 */
export function createProviderRegistry(pluginId: string): {
  capability: { register(entry: { descriptor: unknown; codec: unknown }): void };
  registered: () => readonly RegisteredProvider[];
} {
  const collected: RegisteredProvider[] = [];
  return {
    capability: {
      register(entry) {
        const provider = validateRegistration(pluginId, entry);
        // One provider per plugin today. Registering twice is a plugin bug
        // rather than a supported way to supply two, and the second would
        // silently win — so it is refused rather than tolerated.
        if (collected.length > 0) {
          throw new Error(`plugin ${pluginId} registered more than one provider`);
        }
        collected.push(provider);
      },
    },
    registered: () => collected,
  };
}
