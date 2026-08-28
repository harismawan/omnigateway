import type { ProviderAdapter, ProviderCodec, ProviderDescriptor } from "@omni/providers";
import { codecAdapter, PROVIDER_ID_PATTERN } from "@omni/providers";

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
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
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
