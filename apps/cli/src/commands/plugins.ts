import {
  installPlugin,
  listPlugins,
  nodePluginFs,
  type PluginDeps,
  type PluginSummary,
  pluginsDir,
  removePlugin,
  verifyPlugin,
} from "@omni/control";
import { DASHBOARD_SDK_VERSION } from "@omni/plugins";
import { boolFlag, requirePositional } from "../args.ts";
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
        return `no plugins installed; unpack one into ${pluginsDir(root)} with: omni plugin install <path>`;
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
  usage: "plugin install <path-or-tarball>",
  summary: "Unpack a plugin into this installation, running nothing from it",
  async run(args, { ctx, writer }) {
    const spec = requirePositional(args, 0, "plugin directory or tarball");
    const result = await installPlugin(pluginDeps(), ctx.root.root, spec);

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

    const result = removePlugin(deps, ctx.root.root, id, { purge });

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
