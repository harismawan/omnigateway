import type { PluginCatalogEntry } from "../../api/types.ts";

/** Where a plugin's screen lives. One place, so the rail and the route agree. */
export function pluginPath(pluginId: string): string {
  return `/plugins/${pluginId}`;
}

export type PluginNavEntry = {
  id: string;
  label: string;
  /**
   * `null` when the entry is a working link. Otherwise the reason it is not,
   * shown on the entry itself rather than hidden behind a hover.
   */
  disabledReason: string | null;
};

/**
 * What the rail shows for the installed plugins, in the order it shows them.
 *
 * A pure function so the three cases can be checked without a renderer, and
 * because all three are decided here:
 *
 * - `ui === null` is a backend-only plugin. It contributes nothing: no entry,
 *   no route, and no error, because there is nothing wrong with it.
 * - `nav === null` is a plugin that asked for no screen. Same treatment.
 * - `compatible === false` is a plugin whose bundle this console cannot load.
 *   It gets an entry that says so, because silence would read as "not
 *   installed" and send an operator looking in the wrong place.
 *
 * Sorted by id rather than by label, and after the core entries: the rail's own
 * order is an argument about how a gateway is set up and then watched, and a
 * plugin has no place in the middle of it. Id rather than label because a label
 * is the plugin author's to change, and a rail that reorders itself when a
 * plugin updates is a rail an operator stops trusting.
 */
export function pluginNavEntries(plugins: readonly PluginCatalogEntry[]): PluginNavEntry[] {
  return plugins
    .filter((plugin) => plugin.nav !== null && plugin.ui !== null)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.nav?.label ?? plugin.name,
      disabledReason: navReason(plugin),
    }));
}

function navReason(plugin: PluginCatalogEntry): string | null {
  const ui = plugin.ui;
  if (ui === null) return null;
  if (ui.compatible && ui.entry !== null) return null;
  // The gateway withholds the URL for an incompatible bundle, so an entry with
  // no reason is still an entry that must not be followed.
  return ui.reason ?? "This plugin's interface does not match this gateway.";
}
