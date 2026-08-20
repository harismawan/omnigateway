import { Suspense, useMemo } from "react";
import styled from "styled-components";
import { usePlugins } from "../../api/queries.ts";
import { PageHead } from "../../components/Rack.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Stack } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { pluginComponent, usePluginModuleLoader } from "./mount.tsx";
import { PluginBoundary } from "./PluginBoundary.tsx";

const Mismatch = styled.p`
  font-size: 13px;
  color: ${({ theme }) => theme.color.warn};
`;

const Advice = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 68ch;
`;

/**
 * One installed plugin's screen.
 *
 * The catalog is the only thing consulted about what to render. The console
 * never decides for itself that a bundle looks loadable: the gateway hands out
 * a URL for a compatible UI and withholds it otherwise, so the incompatible
 * case here has nothing to import even if this code tried.
 */
export function PluginBoard({ pluginId }: { pluginId: string }) {
  const plugins = usePlugins();
  const loader = usePluginModuleLoader();
  const plugin = plugins.data?.find((candidate) => candidate.id === pluginId);
  const ui = plugin?.ui ?? null;
  const entry = ui?.compatible === true ? ui.entry : null;

  // Memoised on the entry URL rather than rebuilt per render: a fresh
  // `React.lazy` is a fresh module payload, which remounts the plugin's whole
  // tree and throws away its state on every parent render.
  const Panel = useMemo(
    () => (entry === null ? null : pluginComponent(pluginId, entry, loader)),
    [pluginId, entry, loader],
  );

  if (plugins.isError) {
    return (
      <>
        <PageHead legend="Plugin" title="Plugins" summary="The installed plugins are unknown." />
        <Failure legend="Plugins unavailable" error={plugins.error} />
      </>
    );
  }

  if (plugin === undefined) {
    return (
      <>
        <PageHead
          legend="Plugin"
          title={plugins.isPending ? "Loading…" : pluginId}
          summary={
            plugins.isPending
              ? "Reading the installed plugins."
              : "This gateway does not run a plugin with that id."
          }
        />
        {plugins.isPending ? (
          <SkeletonRows />
        ) : (
          <Empty
            legend="Not installed"
            message={`No plugin with the id ${pluginId} is installed. Install it and restart the gateway.`}
          />
        )}
      </>
    );
  }

  const head = (
    <PageHead
      legend="Plugin"
      title={plugin.nav?.label ?? plugin.name}
      summary={`${plugin.name} ${plugin.version}, installed as ${plugin.id}.`}
    />
  );

  // A plugin with no UI at all. Unreachable from the rail, which gives it no
  // entry, and reached only by someone typing the path — so it is answered
  // plainly rather than treated as an error, because nothing has gone wrong.
  if (ui === null) {
    return (
      <>
        {head}
        <Empty
          legend="No interface"
          message={`${plugin.name} runs entirely in the gateway and has no console screen.`}
        />
      </>
    );
  }

  if (Panel === null) {
    return (
      <>
        {head}
        <Module legend="Interface unavailable" meta={plugin.id}>
          <Stack $gap={2}>
            <Mismatch>
              {ui.reason ?? "This plugin's interface does not match this gateway."}
            </Mismatch>
            <Advice>
              The plugin's server half is unaffected and keeps running. Update the plugin, or the
              gateway, so the two agree on a dashboard SDK version.
            </Advice>
          </Stack>
        </Module>
      </>
    );
  }

  return (
    <>
      {head}
      <PluginBoundary pluginId={plugin.id} pluginName={plugin.name}>
        <Suspense fallback={<SkeletonRows />}>
          <Panel />
        </Suspense>
      </PluginBoundary>
    </>
  );
}
