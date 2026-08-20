import { createFileRoute } from "@tanstack/react-router";
import { PluginBoard } from "../features/plugins/PluginBoard.tsx";

/**
 * One route for every plugin, parameterised by id.
 *
 * Plugins are discovered at runtime, so there is nothing for the file-based
 * router to generate per plugin: the id is a path parameter and the catalog
 * decides what — if anything — that id may render.
 */
function PluginScreen() {
  const { pluginId } = Route.useParams();
  return <PluginBoard pluginId={pluginId} />;
}

export const Route = createFileRoute("/_app/plugins/$pluginId")({ component: PluginScreen });
