import {
  installPlugin,
  listPlugins,
  nodeFetchBytes,
  nodePluginFs,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type PluginDeps,
  type PluginProviderRead,
  type PluginSummary,
  pluginsDir,
  readPluginProviders,
  removePlugin,
  updatePlugin,
  verifyPlugin,
} from "@omni/control";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptors } from "@omni/providers/descriptors";
import { DASHBOARD_SDK_VERSION } from "@omnigateway/plugin-api";
import { boolFlag, type Parsed, requirePositional, stringFlag } from "../args.ts";
import { type Command, state } from "../command.ts";
import { CliError, type Context } from "../context.ts";
import { emit, fields, note, paint, table } from "../output.ts";

/**
 * The plugin commands.
 *
 * Every one of them is a thin rendering of `@omni/control`: boundary rule 11
 * again, and here it buys something concrete. `omni plugin verify` is what an
 * operator runs *before* restarting a production gateway, so it has to answer
 * from the same code the gateway will use — and it cannot answer by asking the
 * gateway, because the gateway it is asking about is the one that has not
 * restarted yet.
 *
 * The SDK version comes from the same constant the gateway's loader checks
 * against, so `omni plugin verify` reaches the verdict the next boot will. Two
 * sources here would let an operator verify clean and then watch a UI refuse to
 * mount. Control still treats an absent version as unknown rather than as a
 * pass, which is what a caller that genuinely cannot judge should report.
 */
function pluginDeps(): PluginDeps {
  return { fs: nodePluginFs(), sdkVersion: DASHBOARD_SDK_VERSION };
}

/**
 * The deps `install` needs, which are the read-only ones plus a way out to the
 * network.
 *
 * Only this command gets a fetcher. `list`, `verify`, and `doctor` answer from
 * the disk and would be answering a different question if a slow registry could
 * make them hang, so the dep they are handed has no way to reach one — boundary
 * rule 11's "inject every side effect" read the strict way, where a command
 * that cannot do a thing is better than one that merely does not.
 *
 * The registry comes from the flag, then from the installation's environment,
 * and otherwise from control's default. The flag wins because it is the more
 * specific statement, the same order `--db` has over `OMNI_DB_PATH`; a blank
 * value in either is the variable being unset by a shell, not a request to
 * install from the empty string.
 */
function installDeps(ctx: Context, args: Parsed): PluginDeps {
  const flag = stringFlag(args.values, "registry");
  const raw = flag ?? ctx.env.OMNI_PLUGIN_REGISTRY;
  const registry = raw === undefined || raw.trim().length === 0 ? undefined : raw.trim();
  return {
    ...pluginDeps(),
    fetchBytes: nodeFetchBytes(),
    // Injected rather than left to control's own default, per rule 11: the
    // install record is stamped from it, and "inject every side effect" is
    // cheaper to honour than to argue about.
    now: ctx.now,
    ...(registry === undefined ? {} : { registry }),
  };
}

/**
 * One plugin's state as a single cell.
 *
 * Three words rather than two, because "would not load" and "loads with
 * something wrong" are different decisions: the first is a reason to hold a
 * restart, the second is a reason to fix something before the next one.
 */
function pluginState(ctx: Context, plugin: PluginSummary): string {
  if (!plugin.loadable) return state(ctx, false, "will not load");
  if (plugin.problems.length > 0) return paint(ctx, "yellow", "loads, with warnings");
  return state(ctx, true, "ok");
}

export const pluginList: Command = {
  usage: "plugin list",
  summary: "List installed plugins and whether the gateway would load each one",
  async run(_args, { ctx, writer }) {
    const root = ctx.root.root;
    const plugins = listPlugins(pluginDeps(), root);

    emit(ctx, writer, { pluginsDir: pluginsDir(root), plugins }, () => {
      if (plugins.length === 0) {
        return `no plugins installed; unpack one into ${pluginsDir(root)} with: omni plugin install <path-or-package>`;
      }
      const rows = plugins.map((plugin) => [
        plugin.id,
        plugin.name ?? "—",
        plugin.version ?? "—",
        plugin.api === null ? "—" : String(plugin.api),
        plugin.sdk ?? "—",
        plugin.capabilities.length === 0 ? "—" : plugin.capabilities.join(","),
        pluginState(ctx, plugin),
      ]);
      const body = table(
        [
          { header: "ID" },
          { header: "NAME" },
          { header: "VERSION" },
          { header: "API" },
          { header: "SDK" },
          { header: "CAPABILITIES" },
          { header: "STATE" },
        ],
        rows,
      );

      // The reasons go under the table rather than in it: they are sentences,
      // and a sentence in a column pushes every other column off the terminal.
      const notes = plugins.flatMap((plugin) =>
        plugin.problems.map(
          (problem) =>
            `${plugin.id}: ${paint(ctx, problem.fatal ? "red" : "yellow", problem.reason)}`,
        ),
      );
      return notes.length === 0 ? body : `${body}\n\n${notes.join("\n")}`;
    });
  },
};

export const pluginVerify: Command = {
  usage: "plugin verify <id>",
  summary: "Run every load-time check on one plugin without loading it",
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "plugin id");
    const report = verifyPlugin(pluginDeps(), ctx.root.root, id);

    emit(ctx, writer, report, () => {
      const manifest = report.manifest;
      const head = fields([
        ["id", report.id],
        ["path", report.path],
        ["name", manifest?.name ?? "—"],
        ["version", manifest?.version ?? "—"],
        ["api", manifest === null ? "—" : String(manifest.api)],
        ["sdk", manifest?.sdk ?? "—"],
        ["server", manifest?.server ?? "—"],
        ["ui", manifest?.ui ?? "—"],
        [
          "capabilities",
          manifest === null || manifest.capabilities.length === 0
            ? "—"
            : manifest.capabilities.join(","),
        ],
        ["origins", manifest?.origins?.join(",") ?? "—"],
      ]);

      if (report.problems.length === 0) {
        return `${head}\n\n${state(ctx, true, "ok")}: this plugin would load`;
      }
      const lines = report.problems.map(
        (problem) =>
          `  ${paint(ctx, problem.fatal ? "red" : "yellow", problem.check)}  ${problem.reason}`,
      );
      const verdict = report.loadable
        ? paint(ctx, "yellow", "this plugin would load, with the warnings above")
        : state(ctx, false, "this plugin would be skipped at boot");
      return `${head}\n\n${lines.join("\n")}\n\n${verdict}`;
    });

    // Exit non-zero so a deployment script can gate a restart on this command
    // without parsing its output. A warning is not a failure: the plugin loads.
    if (!report.loadable) throw new CliError(`plugin "${id}" would not load`);
  },
};

export const pluginInstall: Command = {
  usage: "plugin install <path|tarball|https url|package[@version]> [--registry <url>]",
  summary: "Unpack a plugin into this installation, running nothing from it",
  options: { registry: { type: "string" } },
  async run(args, { ctx, writer }) {
    const spec = requirePositional(args, 0, "plugin directory, tarball, url, or package name");
    const result = await installPlugin(installDeps(ctx, args), ctx.root.root, spec);

    emit(ctx, writer, result, () => {
      note(
        ctx,
        writer,
        paint(ctx, "dim", "no code from the package was executed; verify it before restarting"),
      );
      const verb = result.replaced ? "replaced" : "installed";
      return [
        `${verb} ${result.name} ${result.version} at ${result.path}`,
        // Said out loud every time. Plugins are imported once at boot and their
        // routes are built into the Elysia tree at construction, so a running
        // gateway will not pick this up — and an operator watching an unchanged
        // console has no way to tell that from a plugin that failed to load.
        paint(ctx, "yellow", "restart the gateway for this to take effect: omni restart"),
      ].join("\n");
    });
  },
};

export const pluginUpdate: Command = {
  usage: "plugin update <id> [--registry <url>]",
  summary: "Reinstall a plugin from the source it was installed from",
  options: { registry: { type: "string" } },
  async run(args, { ctx, writer }) {
    const id = requirePositional(args, 0, "plugin id");
    const result = await updatePlugin(installDeps(ctx, args), ctx.root.root, id);

    emit(ctx, writer, result, () => {
      note(
        ctx,
        writer,
        paint(ctx, "dim", `re-run from ${result.spec}; no code from the package was executed`),
      );
      return [
        // "reinstalled", not "updated": re-running an unchanged spec is the
        // ordinary case and reporting an update that did not happen is a small
        // lie the operator has no way to check.
        `reinstalled ${result.name} ${result.version} at ${result.path}`,
        paint(ctx, "yellow", "restart the gateway for this to take effect: omni restart"),
      ].join("\n");
    });
  },
};

export const pluginRemove: Command = {
  usage: "plugin remove <id> [--purge]",
  summary: "Remove a plugin, optionally dropping its stored data too",
  options: { purge: { type: "boolean" } },
  async run(args, { ctx, writer, prompt }) {
    const id = requirePositional(args, 0, "plugin id");
    const purge = boolFlag(args.values, "purge");

    // Asked before anything is read, so the operator is not answering a question
    // about a plugin whose tables have already been counted. `--purge` gets its
    // own wording because it is the irreversible half: the directory can be
    // reinstalled from the package it came from, and the tables cannot be
    // reinstalled from anything.
    const question = purge
      ? `remove plugin "${id}" AND permanently drop its stored data?`
      : `remove plugin "${id}"? its stored data is kept`;
    if (!(await prompt.confirm(question))) throw new CliError("cancelled");

    // The store is opened only for a purge. Listing or removing a directory must
    // keep working on the installation whose database is the thing that is
    // broken, which is the installation whose operator is typing this.
    const deps: PluginDeps = purge
      ? { fs: nodePluginFs(), store: await ctx.store() }
      : { fs: nodePluginFs() };

    const result = await removePlugin(deps, ctx.root.root, id, { purge });

    emit(ctx, writer, result, () => {
      const lines: string[] = [];
      lines.push(result.removed ? `removed ${id}` : `no directory for ${id} to remove`);
      if (purge) {
        lines.push(
          result.droppedTables.length === 0
            ? "no stored tables to drop"
            : `dropped ${result.droppedTables.length} table(s): ${result.droppedTables.join(", ")}`,
        );
      } else {
        lines.push(
          paint(ctx, "dim", "stored tables and migration history kept; --purge drops them"),
        );
      }
      lines.push(paint(ctx, "yellow", "restart the gateway for this to take effect: omni restart"));
      return lines.join("\n");
    });
  },
};

/**
 * The plugin deps `doctor` uses, so the diagnostic and the commands cannot
 * disagree about which directory they are reading or what an sdk range means.
 */
export function doctorPluginDeps(): PluginDeps {
  return pluginDeps();
}

/**
 * The provider registry this installation would have, built without running a
 * plugin's `setup`.
 *
 * The CLI's answer to a question the gateway answers from its own boot-time
 * registry: `omni setup` needs a model's context window (it writes that number
 * into an agent's configuration file, where being wrong outlives the command)
 * and `omni models dry-run` needs to know what would route. Both consulted the
 * six compiled-in providers and were therefore wrong about every plugin-supplied
 * one, contradicting `omni doctor` on the same installation.
 *
 * `import(…)` runs the plugin module's top-level code, and this comment is the
 * place a reader will decide whether that is acceptable — so: it does. What it
 * does not do is construct a `PluginContext` or call `setup`, so no store,
 * channel, event bus, migration or route is reachable, and `omni doctor` remains
 * a diagnostic that changes nothing. That is why `providers` is a declared field
 * on `PluginDefinition` rather than the capability it started as.
 *
 * Failures are reported by the commands that ask for them rather than thrown
 * here: a broken plugin is exactly the installation whose operator is running
 * this.
 */
export async function pluginProviders(root: string): Promise<PluginProviderRead> {
  const read = await readPluginProviders(
    listPlugins(doctorPluginDeps(), root),
    (entry) => import(entry),
  );
  // **Merged with the built-ins, not returned alone.** `readPluginProviders`
  // answers "what did the plugins declare", which is the narrower question and
  // the right one for it to answer — but every caller here wants "what does this
  // installation have", and handing them the plugin half was measurably worse
  // than the bug it was fixing: `omni setup` wrote no context limit for
  // *anthropic*.
  //
  // **The two halves are disjoint**, so the argument order below decides
  // nothing — reversing it is an equivalent mutant, and deliberately left
  // untested for the reason a refinement no input can observe is worth deleting
  // rather than propping up. `readProviders` refuses a plugin declaring a
  // built-in's id, which is the one place that rule lives, and *that* is
  // pinned. It did not always — the plugin half was
  // applied *over* the built-ins here while the gateway refused the same
  // collision at `installPluginProviders`, so a plugin directory named
  // `anthropic` made `omni setup` write its window into an agent's config while
  // the gateway served the real adapter at another. Two copies of a rule, and
  // they disagreed on their first day.
  //
  // `Object.create(null)` rather than a spread, because spreading a
  // null-prototype object yields an ordinary one — `{...PROVIDER_DESCRIPTORS}`
  // silently reverts the invariant that makes `table["constructor"]` answer
  // `undefined`. The gateway does *not* normalise injected adapter maps at
  // `app.ts` — an earlier version did, and it guarded `createApp` alone while
  // the map dispatch reads may never have passed through it, so the guard moved
  // to the read site. This line is the same rule applied where the table is
  // built rather than where it is read.
  const descriptors: ProviderDescriptors = Object.assign(
    Object.create(null),
    PROVIDER_DESCRIPTORS,
    read.descriptors,
  );
  return { descriptors, oauth: read.oauth, failures: read.failures };
}

/**
 * Which plugin would supply a given provider, if any.
 *
 * The manifest is enough to answer without executing anything, because
 * registration requires `descriptor.id` to equal the plugin's own id and the
 * host enforces it — so matching on the id is not a guess. This process
 * deliberately never calls `loadPlugins`: `setup` opens channels, runs
 * migrations and registers a provider, none of which a CLI command should do.
 *
 * **The capability is permission to supply a provider, not proof that the plugin
 * does.** `packages/plugin-api/src/manifest.ts` does not even require
 * a `server` entry alongside it. So no reading of a manifest can promise the
 * provider will exist at runtime, and neither answer below claims to.
 */
function supplier(id: string, plugins: readonly PluginSummary[]): PluginSummary | undefined {
  return plugins.find((plugin) => plugin.id === id && plugin.capabilities.includes("provider"));
}

/**
 * Whether anything on disk *claims* this provider. `doctor`'s question, and now
 * the only one asked from a manifest.
 *
 * There was a stricter sibling, `providerLoadable`, which added `loadable` and
 * was meant for any command that *writes*. It is gone: `add-key` reads the real
 * registry through `pluginProviders` instead, which answers the question a
 * manifest cannot — whether the plugin actually declares a provider, rather than
 * whether it is permitted to. The sibling survived that change as dead code with
 * a docblock still describing its caller, which is how it was found.
 *
 * Deliberately not exact in one direction: a plugin that declares the capability
 * and fails to load supplies nothing, and this still counts it. That is the
 * right way to be wrong for a diagnostic — `doctor` already reports the failed
 * plugin on its own line, and a false "missing provider" beside it would send
 * the operator after the wrong thing.
 */
export function providerDeclared(id: string, plugins: readonly PluginSummary[]): boolean {
  return Object.hasOwn(PROVIDER_DESCRIPTORS, id) || supplier(id, plugins) !== undefined;
}

/**
 * One line per plugin for `doctor`, which has a two-column layout and no room
 * for a table.
 *
 * Fatal problems are named; non-fatal ones are counted. `doctor` answers "is
 * this installation healthy", and a plugin that loads with a disabled UI is not
 * the thing an operator scanning that output is looking for — but a silent one
 * would leave them without a hint that `omni plugin verify` has more to say.
 */
export function pluginDoctorLines(ctx: Context, plugins: readonly PluginSummary[]): string[] {
  return plugins.map((plugin) => {
    const version = plugin.version === null ? "" : ` ${plugin.version}`;
    const api = plugin.api === null ? "api ?" : `api ${plugin.api}`;
    const sdk = plugin.sdk === null ? "no ui" : `sdk ${plugin.sdk}`;
    const reasons = plugin.problems.filter((problem) => problem.fatal).map((p) => p.reason);
    const warnings = plugin.problems.length - reasons.length;
    const verdict =
      reasons.length > 0
        ? state(ctx, false, `will not load: ${reasons.join("; ")}`)
        : warnings > 0
          ? paint(
              ctx,
              "yellow",
              `loads, ${warnings} warning(s); see omni plugin verify ${plugin.id}`,
            )
          : state(ctx, true, "ok");
    return `${plugin.id}${version} (${api}, ${sdk}) ${verdict}`;
  });
}

/**
 * The OAuth flows this installation can start, built-ins and plugins together.
 *
 * Separate from `pluginProviders` above because the caller is different in the
 * way that matters: `connect` asks *before* opening a store, so that an unknown
 * provider is refused without a database being touched. That property is
 * asserted, and folding this into anything that needs a `Store` would lose it.
 *
 * The two halves are disjoint — `readProviders` refuses a plugin declaring a
 * built-in's id, which is the one place that rule lives — so the merge order
 * decides nothing.
 */
export type ConnectRegistry = {
  /** Built-in flows merged with whatever plugins declared. */
  providers: Readonly<Record<string, OAuthProvider>>;
  /**
   * The descriptors those flows belong to, merged the same way.
   *
   * **Both halves, from one read.** `createConnectFlows` asks the descriptor
   * registry two questions — does this provider exist, and what redirect does it
   * use — and this process never populates the module global, because it must
   * not call `loadPlugins`. Handing it only the flows admitted a provider at one
   * gate and refused it at the next, with a message naming the provider it had
   * just refused.
   */
  descriptors: ProviderDescriptors;
  /** Plugins that declared a provider and did not yield one. */
  failures: readonly { id: string; reason: string }[];
};

/**
 * Everything `omni connect` and `omni credentials refresh` need in order to
 * reach a plugin-supplied provider, from a single read of the plugin directory.
 *
 * Separate from `pluginProviders` above because the caller differs in the way
 * that matters: `connect` asks *before* opening a store, so an unknown provider
 * is refused without a database being touched. That is asserted, and folding
 * this into anything needing a `Store` would lose it.
 *
 * One read and not two: the directory could change between them, and the
 * operator would be refused a provider the flow then had.
 */
export async function connectRegistryFor(root: string): Promise<ConnectRegistry> {
  const read = await readPluginProviders(
    listPlugins(doctorPluginDeps(), root),
    (entry) => import(entry),
  );
  return {
    providers: Object.assign(Object.create(null), OAUTH_PROVIDERS, read.oauth),
    descriptors: Object.assign(Object.create(null), PROVIDER_DESCRIPTORS, read.descriptors),
    // Carried for the same reason `add-key` carries them: a plugin that failed
    // to load is the likeliest reason an id was refused, and it is the
    // operator's actual next step. Without it `omni connect acme-ai` lists five
    // built-ins and says nothing about the plugin sitting broken on disk.
    failures: read.failures,
  };
}
