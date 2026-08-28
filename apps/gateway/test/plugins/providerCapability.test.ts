import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { entryOf } from "@omni/testkit";
import { createProviderRegistry, validateRegistration } from "../../src/plugins/providers.ts";

/**
 * What a plugin hands the host, and what the host refuses to take its word for.
 *
 * `PluginProviderRegistry` types its argument as `unknown` on both sides, since
 * `@omnigateway/plugin-api` is published and cannot import `@omni/ir` until a
 * later sub-project. That looseness is deliberate and it is paid for here: every
 * one of these cases would have typechecked on the plugin's side.
 */

const anthropic = entryOf(PROVIDER_DESCRIPTORS, "anthropic", "PROVIDER_DESCRIPTORS");

function descriptor(over: Record<string, unknown> = {}) {
  return { ...anthropic, id: "acme-ai", ...over };
}

const codec = {
  buildRequest: () => ({ request: { url: "https://x", method: "POST", headers: [], body: "{}" } }),
  decode: async function* () {},
};

test("a well-formed registration becomes an adapter under the plugin's own id", () => {
  const registered = validateRegistration("acme-ai", { descriptor: descriptor(), codec });

  expect(registered.descriptor.id).toBe("acme-ai");
  expect(registered.adapter.id).toBe("acme-ai");
  // The adapter reports the descriptor's capabilities, because routing filters
  // on them before dispatch ever runs.
  expect(registered.adapter.capabilities).toEqual(anthropic.capabilities);
});

test("a plugin cannot register a provider under another plugin's id", () => {
  // The rule that keeps `plugin:<id>:` topics and `plugin_<id>_` tables inside
  // their owner, applied to the registry. A plugin shadowing `anthropic` would
  // take its traffic and its stored credentials.
  expect(() =>
    validateRegistration("acme-ai", { descriptor: descriptor({ id: "anthropic" }), codec }),
  ).toThrow(/may only register its own id/);

  // Both ids are named, because "id mismatch" sends a reader to look at one.
  try {
    validateRegistration("acme-ai", { descriptor: descriptor({ id: "anthropic" }), codec });
  } catch (error) {
    expect((error as Error).message).toContain("acme-ai");
    expect((error as Error).message).toContain("anthropic");
  }
});

test("an id that cannot name a provider is refused before anything else is read", () => {
  // The id becomes a `--p-<id>` custom property, a table prefix and a topic, so
  // it is checked against the one grammar rather than trusted.
  for (const id of ["Acme AI", "1acme", "acme_ai", "", "a".repeat(33)]) {
    expect(() => validateRegistration(id, { descriptor: descriptor({ id }), codec })).toThrow(
      /not a usable provider id/,
    );
  }
});

test("a descriptor missing a required field is refused, naming the field", () => {
  // Required with no defaults, exactly as a built-in is. `writeOverInput`
  // defaulting to zero underprices cache writes silently and permanently, which
  // is the failure the whole descriptor shape exists to prevent.
  for (const field of [
    "capabilities",
    "writeOverInput",
    "catalog",
    "modelPrefixes",
    "presentation",
  ]) {
    const incomplete = descriptor();
    delete (incomplete as Record<string, unknown>)[field];
    expect(() => validateRegistration("acme-ai", { descriptor: incomplete, codec })).toThrow(
      new RegExp(`missing ${field}`),
    );
  }
});

test("a codec missing a function is refused, and a non-callable hook too", () => {
  expect(() => validateRegistration("acme-ai", { descriptor: descriptor(), codec: {} })).toThrow(
    /no buildRequest/,
  );
  expect(() =>
    validateRegistration("acme-ai", {
      descriptor: descriptor(),
      codec: { buildRequest: codec.buildRequest },
    }),
  ).toThrow(/no decode/);
  expect(() =>
    validateRegistration("acme-ai", {
      descriptor: descriptor(),
      codec: { ...codec, classifyError: "not a function" },
    }),
  ).toThrow(/non-callable classifyError/);
});

test("nothing that is not an object is accepted for either half", () => {
  for (const bad of [null, undefined, "descriptor", 42, []]) {
    expect(() => validateRegistration("acme-ai", { descriptor: bad, codec })).toThrow();
  }
  for (const bad of [null, undefined, "codec", 42]) {
    expect(() =>
      validateRegistration("acme-ai", { descriptor: descriptor(), codec: bad }),
    ).toThrow();
  }
});

test("a plugin registering twice is refused rather than silently keeping the last", () => {
  const registry = createProviderRegistry("acme-ai");
  registry.capability.register({ descriptor: descriptor(), codec });
  expect(() => registry.capability.register({ descriptor: descriptor(), codec })).toThrow(
    /more than one provider/,
  );
  // And the first survives, so the refusal costs nothing that already worked.
  expect(registry.registered()).toHaveLength(1);
});

test("a registration collected before a later failure is never applied", () => {
  // The reason registrations are collected rather than written straight into the
  // live tables: `setup` can register a provider and then throw, and a provider
  // installed by a plugin the host went on to reject would be admitted by
  // routing and then fail every request with INTERNAL.
  //
  // Asserted at this boundary because it is a property of the registry object,
  // not of the loader: the loader reads `registered()` only after `setup`
  // returns, so a throw means nothing is ever read.
  const registry = createProviderRegistry("acme-ai");
  try {
    registry.capability.register({ descriptor: descriptor(), codec });
    throw new GatewayError("INTERNAL", "setup failed after registering");
  } catch {
    // Swallowed, exactly as the loader's own catch does.
  }
  // The registration is *held*, and it is the loader's `continue` that drops it.
  // What matters is that nothing was written anywhere global.
  expect(Object.hasOwn(PROVIDER_DESCRIPTORS, "acme-ai")).toBe(false);
});
