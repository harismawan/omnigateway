import { join } from "node:path";
import { describeError } from "@omni/ir";
import type { ProviderAdapter, ProviderCodec, ProviderDescriptor } from "@omni/providers";
import {
  codecAdapter,
  isProviderIdFormat,
  PROVIDER_DESCRIPTORS,
  PROVIDER_ID_PATTERN,
} from "@omni/providers";
import type { PluginDefinition } from "@omnigateway/plugin-api";

/**
 * Reading the providers a plugin declares, and refusing the ones it should not.
 *
 * In `@omni/control` rather than in the gateway's loader, which is where it
 * started and where rule 15 puts the loader itself. The loader still owns
 * discovery, manifests, migrations, `setup` and the UI bundle — all of which are
 * a running gateway's business. What moved is only the question two callers now
 * ask: *this* one, and the CLI's, which builds a registry so `omni setup` and
 * `omni models dry-run` can answer for a plugin-supplied provider. Control is
 * the one package both can reach, and a validation rule with two copies is the
 * shape this repository has paid for repeatedly.
 */

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
 * Validates one entry of a plugin's `providers`.
 *
 * `PluginProvider` types both halves as `unknown` — that package is published
 * and cannot import `@omni/ir`, so the real types are not available to it until
 * a later sub-project. This is where that looseness is paid for: nothing is
 * trusted because it typechecked on the plugin's side.
 *
 * Every failure throws. `setup` failures skip the plugin and are reported, which
 * is rule 15 and is what makes this safe to be strict about: the cost of
 * refusing a malformed provider is one plugin missing, never a gateway that will
 * not boot.
 */
export function validateRegistration(
  pluginId: string,
  entry: { descriptor: unknown; codec: unknown },
  /**
   * The origins the plugin's manifest declared, so the adapter can refuse a
   * request the manifest never admitted.
   *
   * Optional, and absent means unrestricted — which is right for the one caller
   * that has no manifest in hand and wrong to rely on anywhere else. Every path
   * that reaches a running plugin goes through \`readProviders\`, which always
   * has one.
   */
  origins?: readonly string[],
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
    adapter: codecAdapter(id, typed.capabilities, codec as ProviderCodec, origins),
  };
}

/**
 * The providers one plugin declares, validated.
 *
 * The single reader of `PluginDefinition.providers`, and deliberately so: the
 * gateway's loader and the CLI's descriptor reader both call this, so "what
 * counts as a usable provider" is answered once. Two readers of a plugin-supplied
 * value is how the console and the router came to disagree about custom
 * endpoints, and this package's own rules say the fix is one copy rather than
 * two careful ones.
 *
 * Throws on anything malformed. Every caller turns that into "plugin skipped and
 * reported", which is rule 15 — the cost of refusing is one plugin missing,
 * never a gateway that will not boot or a CLI that will not answer.
 *
 * Nothing here runs plugin code. The declaration is a field, so reading it costs
 * the module import the caller already did and nothing more.
 */
export function readProviders(
  pluginId: string,
  manifest: { capabilities: readonly string[]; origins?: readonly string[] | undefined },
  // The whole definition, not `Pick<…, "providers">`. Narrowing it would make
  // every caller's object literal fail TypeScript's excess-property check for
  // carrying the `setup` it is required to have — a type that refuses its only
  // real argument shape.
  definition: PluginDefinition,
): readonly RegisteredProvider[] {
  const declared = definition.providers ?? [];
  if (declared.length === 0) return [];

  // The manifest gates it, which is what keeps a plugin's reach auditable
  // without reading its code — the same argument every other capability makes.
  // Checked before the shape, so a plugin that simply forgot the capability is
  // told that rather than being walked through a descriptor it is not allowed to
  // supply.
  if (!manifest.capabilities.includes("provider")) {
    throw new Error(
      `plugin ${pluginId} declares a provider without the "provider" capability in its manifest`,
    );
  }

  // One provider per plugin today, because `descriptor.id` must equal the
  // plugin's own id and two entries cannot both satisfy that. The field is an
  // array so the day a plugin fronts several upstreams is a change to this rule
  // rather than a change to the published shape — but until that rule exists,
  // a second entry is a plugin bug and the second would silently win.
  if (declared.length > 1) {
    throw new Error(`plugin ${pluginId} declares more than one provider`);
  }

  // A plugin may not take a built-in's name, and this is the **one** place that
  // rule lives. It was written twice: `installPluginProviders` refused the
  // collision at the gateway's registry write, and the CLI's merge applied the
  // plugin's descriptor *over* the built-in — so `omni setup` wrote a plugin's
  // context window into an agent's configuration file for `anthropic` while the
  // gateway served through the real adapter at a different one. Two copies of a
  // rule is how they come to disagree, and these disagreed on their first day.
  //
  // Here rather than at either call site because this is the only function both
  // the loader and the CLI go through. `installPluginProviders` keeps its own
  // check as the guard on `registerProvider`'s throw; it is a second line now,
  // not the rule.
  //
  // The table holds only built-ins while this runs: the loader collects every
  // plugin's providers before installing any of them.
  for (const entry of declared) {
    const id = (entry.descriptor as { id?: unknown } | null)?.id;
    if (typeof id === "string" && Object.hasOwn(PROVIDER_DESCRIPTORS, id)) {
      throw new Error(`plugin ${pluginId} declares a provider named ${id}, which is built in`);
    }
  }

  // The manifest's own origins, not the plugin's word for them: this is the
  // path both the loader and the CLI go through, so it is where the audit
  // surface and the enforcement meet.
  return declared.map((entry) => validateRegistration(pluginId, entry, manifest.origins));
}

/**
 * How a caller reaches a plugin's server entry.
 *
 * Injected because it is the one genuine side effect here, and because a test
 * driving real `import()` calls against real files would be testing Bun's module
 * loader. `apps/cli` supplies the real one; the gateway does not use the function
 * below at all, since its loader already holds the imported definition.
 */
export type PluginImporter = (entry: string) => Promise<unknown>;

/**
 * How long a plugin's module may take to evaluate before it is given up on.
 *
 * `import()` runs the module's top-level code, and top-level code can `await`.
 * A plugin whose entry opens a socket to an unreachable host, or writes
 * `await new Promise(() => {})` by accident, hung `omni setup` and
 * `omni models dry-run` **forever** — no output, no exit, and every plugin after
 * it in the list unread, because the loop is sequential. Rule 15 says a load
 * failure is skipped and reported, never fatal; a hang is neither, and it landed
 * on a diagnostic an operator reaches for when something is already wrong.
 *
 * Five seconds because this is not a load, it is a read: nothing here waits on a
 * network by design, so any module taking longer is doing something the CLI
 * should not be waiting for. The gateway keeps no such bound — a plugin that
 * hangs its boot is visible as a gateway that does not start, and cutting a
 * legitimate slow initialisation short there would be worse.
 */
export const PLUGIN_IMPORT_TIMEOUT_MS = 5_000;

/**
 * Rejects if the promise has not settled in time, and clears its timer either
 * way.
 *
 * The timer is cleared in a `finally` rather than only on the happy path: a
 * pending `setTimeout` keeps a CLI process alive after its work is done, so a
 * command whose plugins all imported cleanly would still sit for the full
 * timeout before exiting. Losing the race does not cancel the import — nothing
 * can, once a module has begun evaluating — so the module goes on running in the
 * background until the process exits. That is acceptable here and would not be
 * in the gateway, which is why the gateway does not use this.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type PluginProviderRead = {
  /** Every provider read, keyed by id, ready to hand to a router or a pricer. */
  descriptors: Readonly<Record<string, ProviderDescriptor>>;
  /** One entry per plugin that declared a provider and did not yield one. */
  failures: readonly { id: string; reason: string }[];
};

/**
 * The providers installed plugins declare, without running any of them.
 *
 * This is what lets a process that is **not** the gateway answer a question the
 * descriptor owns. `omni setup` writes a model's context window into an agent's
 * configuration file and `omni models dry-run` reports what would route: both
 * consulted the six compiled-in providers, so a plugin-supplied one got no
 * window and a `provider:missing` exclusion — contradicting `omni doctor` on the
 * same installation, and leaving the wrong answer looking like the specific one.
 *
 * **It does import the plugin's module**, which runs that module's top-level
 * code. Saying otherwise here would be the sort of overstated guarantee this
 * repository keeps paying for. What it does not do is build a `PluginContext` or
 * call `setup` — so no store, channel, event bus, migration or route is
 * reachable from it, and `omni doctor` stays a diagnostic that applies no
 * migrations. That is the whole reason `providers` is a declared field rather
 * than a `ctx.provider.register` capability.
 *
 * Failures are collected, never thrown. A broken plugin is exactly the
 * installation whose operator is running these commands, and a `doctor` that
 * exited non-zero over one would be useless at the moment it is needed.
 *
 * A plugin the host will not load is reported here too, and only when it
 * declares the `provider` capability — a broken UI-only plugin is the UI's
 * problem and saying so here would be noise on every command that reads this.
 *
 * Order follows the caller's list, and `listPlugins` sorts by id, so two
 * installs holding the same plugins build the same registry.
 */
export async function readPluginProviders(
  plugins: readonly {
    id: string;
    path: string;
    loadable: boolean;
    manifest: unknown;
    /**
     * Carried so an unloadable plugin's failure can name the reason rather than
     * repeat that it is unloadable. `PluginSummary` already holds these and
     * every caller passes one whole.
     */
    /**
     * Required, not optional. Optional let a caller construct a plugin record
     * with no problems list and get "declares a provider but will not load"
     * with no cause — the half-message this field was added to replace — with
     * the compiler raising nothing. Every real caller passes a whole
     * `PluginSummary`; making it required is what keeps that true.
     */
    problems: readonly { reason: string; fatal: boolean }[];
  }[],
  importer: PluginImporter,
  // Injected so a test can drive the timeout without waiting for it, and
  // defaulted so no caller has to know it exists. `setTimeout` rather than a
  // clock, because what is being bounded is wall time inside someone else's
  // module — there is no tick to advance.
  timeoutMs: number = PLUGIN_IMPORT_TIMEOUT_MS,
): Promise<PluginProviderRead> {
  // Null-prototype, like every other provider-keyed table. A provider id arrives
  // from a client's `model` name and from unvalidated JSON in
  // `virtual_models.targets`, and on an ordinary literal `table["constructor"]`
  // answers the `Object` constructor — which reads as "installed" and then
  // throws on the next property access.
  const descriptors: Record<string, ProviderDescriptor> = Object.create(null);
  const failures: { id: string; reason: string }[] = [];

  /**
   * `headline`, with the manifest's own fatal problems appended when there are
   * any.
   *
   * One helper and not two inline copies: the two call sites below are the same
   * sentence about different states, and this whole review round was mostly
   * repairs that landed in one of a pair.
   */
  const because = (
    plugin: { problems: readonly { reason: string; fatal: boolean }[] },
    headline: string,
  ): string => {
    const fatal = plugin.problems.filter((problem) => problem.fatal);
    return fatal.length === 0
      ? headline
      : `${headline}: ${fatal.map((problem) => problem.reason).join("; ")}`;
  };

  for (const plugin of plugins) {
    const manifest = plugin.manifest;
    // **Reported, not skipped, and reported *before* the capability check.**
    //
    // `reportFor` yields `manifest: null` for a plugin with no
    // `omni-plugin.json`, an unreadable one, and an invalid one — a truncated
    // download, an interrupted `plugin install`, a hand-edit. Those are the most
    // ordinary ways a plugin breaks, and they all hit a bare `continue` here.
    //
    // The capability check below runs first for a reason — a broken UI-only
    // plugin should stay the UI's problem rather than surface as a missing
    // provider — but that ordering needs a manifest to read. With none, the
    // question "does this declare a provider?" has no answer, and skipping
    // silently answers it "no": the one reading that deletes the cause while
    // `provider:missing` is shown to the operator. Unknown is not absent.
    //
    // The earlier fix here missed this because its own commit message said
    // `loadable` is false for "exactly the three fatal manifest problems". It is
    // false for six, and three of them arrive with no manifest at all.
    if (typeof manifest !== "object" || manifest === null) {
      failures.push({
        id: plugin.id,
        reason: because(
          plugin,
          "manifest could not be read, so whether it supplies a provider is unknown",
        ),
      });
      continue;
    }
    const capabilities = (manifest as { capabilities?: unknown }).capabilities;
    // Nothing to read and nothing to report: most plugins supply no provider,
    // and asked before `loadable` so a broken *UI-only* plugin stays the UI's
    // problem rather than appearing as a missing provider.
    if (!Array.isArray(capabilities) || !capabilities.includes("provider")) continue;

    // A plugin the host will refuse is a plugin whose provider will not exist.
    // Reading it anyway would put a descriptor in this registry that no running
    // gateway has — the same lie in the opposite direction.
    //
    // **Reported, not skipped.** This was a bare `continue`, and `loadable` is
    // false for exactly the three fatal manifest problems — an id disagreeing
    // with its directory, an unsupported `api`, a missing `server` file. So a
    // plugin broken in the *ordinary* way was absent from `failures` in all
    // three commands that report them, and an operator saw the consequence
    // (`provider:missing`, an omitted context limit, a refused id) with the
    // cause deleted. That is the exact bug those commands were given
    // `pluginFailures` for.
    if (!plugin.loadable) {
      failures.push({
        id: plugin.id,
        reason: because(plugin, "declares a provider but will not load"),
      });
      continue;
    }
    const server = (manifest as { server?: unknown }).server;
    if (typeof server !== "string") {
      failures.push({ id: plugin.id, reason: "declares a provider but has no server entry" });
      continue;
    }

    try {
      const module = await withTimeout(
        importer(join(plugin.path, server)),
        timeoutMs,
        `reading its provider took longer than ${timeoutMs}ms`,
      );
      const definition = (module as { default?: unknown }).default;
      if (
        typeof definition !== "object" ||
        definition === null ||
        typeof (definition as PluginDefinition).setup !== "function"
      ) {
        failures.push({ id: plugin.id, reason: "server entry has no default export with a setup" });
        continue;
      }
      for (const read of readProviders(
        plugin.id,
        { capabilities: capabilities as string[] },
        definition as PluginDefinition,
      )) {
        descriptors[read.descriptor.id] = read.descriptor;
      }
    } catch (error) {
      failures.push({ id: plugin.id, reason: describeError(error, String(error)) });
    }
  }

  return { descriptors, failures };
}
