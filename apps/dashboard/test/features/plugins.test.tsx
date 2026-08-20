import { describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { useState } from "react";
import type { PluginCatalogEntry } from "../../src/api/types.ts";
import { Rack } from "../../src/components/Rack.tsx";
import {
  type PluginModuleLoader,
  PluginModuleLoaderProvider,
  type PluginUiProps,
} from "../../src/features/plugins/mount.tsx";
import { PluginBoard } from "../../src/features/plugins/PluginBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders, renderWithRouter } from "../helpers/render.tsx";

function plugin(patch: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  return {
    id: "atlas",
    name: "Atlas",
    version: "1.2.0",
    nav: { label: "Atlas" },
    ui: { entry: "/plugin-assets/atlas/index.js", compatible: true },
    ...patch,
  };
}

function stubCatalog(plugins: PluginCatalogEntry[]) {
  return createFetchStub({ "GET /api/plugins": () => ({ plugins }) });
}

/**
 * A stub for the one thing a test cannot serve: the plugin bundle itself.
 *
 * The loader is a React context with the real `import()` as its default, so
 * production needs no provider and a test supplies modules by URL. The
 * alternatives were worse in ways that matter under bun's runner: mocking the
 * module registry cannot intercept a dynamic import of a runtime URL that
 * resolves to no file on disk, and serving a real bundle would mean building
 * one from the test.
 */
function loaderFor(modules: Record<string, unknown>): {
  loader: PluginModuleLoader;
  loaded: string[];
} {
  const loaded: string[] = [];
  const loader: PluginModuleLoader = async (entry) => {
    loaded.push(entry);
    const module = modules[entry];
    if (module === undefined) throw new Error(`no bundle at ${entry}`);
    return module;
  };
  return { loader, loaded };
}

function renderConsole(ui: ReactElement, loader: PluginModuleLoader) {
  return renderWithRouter(
    <PluginModuleLoaderProvider value={loader}>
      <Rack>{ui}</Rack>
    </PluginModuleLoaderProvider>,
  );
}

/** A well-behaved plugin: an object with a `mount`, exactly as the SDK types it. */
const WORKING = {
  default: {
    mount: ({ pluginId }: PluginUiProps) => <p>atlas panel for {pluginId}</p>,
  },
};

describe("the rail", () => {
  test("lists a plugin that declares nav, after the core entries and sorted by id", async () => {
    stubCatalog([
      plugin({ id: "zephyr", name: "Zephyr", nav: { label: "Zephyr" } }),
      plugin({ id: "atlas", name: "Atlas", nav: { label: "Atlas" } }),
    ]);
    renderWithRouter(
      <Rack>
        <div>page content</div>
      </Rack>,
    );

    const link = await screen.findByRole("link", { name: "Atlas" });
    expect(link.getAttribute("href")).toBe("/plugins/atlas");

    // Re-queried after the catalog resolved: the rail draws its core entries
    // first and fills the rest in when the request answers.
    const rail = screen.getByRole("navigation", { name: "Console sections" });
    const order = Array.from(rail.children).map((node) => node.textContent ?? "");
    const database = order.findIndex((text) => text.includes("Database"));
    const atlas = order.findIndex((text) => text.includes("Atlas"));
    const zephyr = order.findIndex((text) => text.includes("Zephyr"));

    expect(database).toBeGreaterThan(-1);
    expect(atlas).toBeGreaterThan(database);
    expect(zephyr).toBeGreaterThan(atlas);
  });

  test("disables an incompatible plugin's entry and shows the reason on it", async () => {
    stubCatalog([
      plugin({
        ui: {
          entry: null,
          compatible: false,
          reason: "needs dashboard SDK ^2.0.0, this gateway ships 1.4.0",
        },
      }),
    ]);
    renderWithRouter(
      <Rack>
        <div>page content</div>
      </Rack>,
    );

    // Visible on the entry rather than behind a hover: an operator has to be
    // able to read why without discovering that the entry can be hovered.
    expect(
      await screen.findByText("needs dashboard SDK ^2.0.0, this gateway ships 1.4.0"),
    ).toBeTruthy();

    const entry = await screen.findByRole("button", { name: /Atlas/ });
    expect((entry as HTMLButtonElement).disabled).toBe(true);
    // And it is not a link, so there is nothing to follow to a blank page.
    expect(screen.queryByRole("link", { name: /Atlas/ })).toBeNull();
  });

  test("gives a backend-only plugin no entry at all", async () => {
    stubCatalog([
      plugin({ id: "collector", name: "Collector", nav: { label: "Collector" }, ui: null }),
      plugin(),
    ]);
    renderWithRouter(
      <Rack>
        <div>page content</div>
      </Rack>,
    );

    // Waited on through the plugin that does render, so the absence below is
    // asserted after the catalog arrived rather than before it.
    expect(await screen.findByRole("link", { name: "Atlas" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Collector/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Collector/ })).toBeNull();
    expect(screen.queryByText(/Collector/)).toBeNull();
  });

  test("stays usable when the catalog request fails", async () => {
    createFetchStub({
      "GET /api/plugins": () => ({ status: 500, body: { error: { message: "boom" } } }),
    });
    renderWithRouter(
      <Rack>
        <div>page content</div>
      </Rack>,
    );

    expect(await screen.findByRole("link", { name: "Database" })).toBeTruthy();
  });
});

describe("a plugin's screen", () => {
  test("imports the bundle from the catalog's entry and renders its mount", async () => {
    stubCatalog([plugin()]);
    const { loader, loaded } = loaderFor({ "/plugin-assets/atlas/index.js": WORKING });
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    expect(await screen.findByText("atlas panel for atlas")).toBeTruthy();
    expect(loaded).toEqual(["/plugin-assets/atlas/index.js"]);
    // The screen names the plugin it is showing, so a panel that renders
    // nothing recognisable is still attributable.
    expect(screen.getByRole("heading", { name: "Atlas" })).toBeTruthy();
  });

  test("contains a throwing plugin in a failure panel and leaves the console up", async () => {
    stubCatalog([plugin()]);
    const { loader } = loaderFor({
      "/plugin-assets/atlas/index.js": {
        default: {
          mount: () => {
            throw new Error("cannot read properties of undefined");
          },
        },
      },
    });
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    expect(await screen.findByText("Atlas stopped rendering.")).toBeTruthy();
    expect(screen.getByText("cannot read properties of undefined")).toBeTruthy();

    // The point of the boundary: everything outside it still works.
    expect(screen.getByRole("navigation", { name: "Console sections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Database" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Atlas" })).toBeTruthy();
  });

  test("contains a bundle that fails to load in the same panel", async () => {
    stubCatalog([plugin()]);
    const { loader } = loaderFor({});
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    // A rejected import reaches the boundary rather than suspending forever.
    expect(await screen.findByText("Atlas stopped rendering.")).toBeTruthy();
    expect(screen.getByText(/no bundle at/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Database" })).toBeTruthy();
  });

  test("names the plugin that exported the wrong shape", async () => {
    stubCatalog([plugin()]);
    const { loader } = loaderFor({
      "/plugin-assets/atlas/index.js": { default: () => <p>a bare component</p> },
    });
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    expect(
      await screen.findByText("plugin atlas exported a default without a mount function"),
    ).toBeTruthy();
  });

  test("shows the reason for an incompatible plugin and imports nothing", async () => {
    stubCatalog([
      plugin({
        ui: { entry: null, compatible: false, reason: "built against dashboard SDK 0.9.0" },
      }),
    ]);
    const { loader, loaded } = loaderFor({ "/plugin-assets/atlas/index.js": WORKING });
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    // Scoped to the screen: the rail carries the same sentence, and the point
    // here is that the screen the operator lands on says it too.
    const main = within(await screen.findByRole("main"));
    expect(await main.findByText("built against dashboard SDK 0.9.0")).toBeTruthy();
    expect(loaded).toEqual([]);
    expect(screen.queryByText("atlas panel for atlas")).toBeNull();
  });

  test("refuses an incompatible bundle even when a URL comes with it", async () => {
    // The gateway withholds the URL for an incompatible UI, so this state should
    // not arrive. Asserted anyway, because `compatible` is the field the console
    // is told to obey, and a console that only ever reads `entry` obeys it by
    // luck — which holds until the day the gateway stops doing the favour.
    stubCatalog([
      plugin({
        ui: {
          entry: "/plugin-assets/atlas/index.js",
          compatible: false,
          reason: "built against dashboard SDK 0.9.0",
        },
      }),
    ]);
    const { loader, loaded } = loaderFor({ "/plugin-assets/atlas/index.js": WORKING });
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    const main = within(await screen.findByRole("main"));
    expect(await main.findByText("built against dashboard SDK 0.9.0")).toBeTruthy();
    expect(loaded).toEqual([]);
    expect(screen.queryByText("atlas panel for atlas")).toBeNull();
    // And the rail agrees: no link to a screen that cannot render.
    expect(screen.queryByRole("link", { name: /Atlas/ })).toBeNull();
  });

  test("says a backend-only plugin has no screen rather than failing", async () => {
    stubCatalog([plugin({ ui: null })]);
    const { loader, loaded } = loaderFor({});
    renderConsole(<PluginBoard pluginId="atlas" />, loader);

    expect(await screen.findByText(/runs entirely in the gateway/)).toBeTruthy();
    expect(loaded).toEqual([]);
    expect(screen.queryByText("Atlas stopped rendering.")).toBeNull();
  });

  test("does not blame the next plugin for the last one's failure", async () => {
    stubCatalog([
      plugin(),
      plugin({
        id: "broken",
        name: "Broken",
        nav: { label: "Broken" },
        ui: { entry: "/plugin-assets/broken/index.js", compatible: true },
      }),
    ]);
    const { loader } = loaderFor({
      "/plugin-assets/atlas/index.js": WORKING,
      "/plugin-assets/broken/index.js": {
        default: {
          mount: () => {
            throw new Error("cannot read properties of undefined");
          },
        },
      },
    });

    // The boundary sits at the same position in the tree for every plugin, so
    // React reuses the instance across a navigation between two of them. Left
    // sticky, the second plugin renders the first one's failure panel having
    // done nothing wrong.
    function Screens() {
      const [id, setId] = useState("broken");
      return (
        <>
          <button type="button" onClick={() => setId("atlas")}>
            open atlas
          </button>
          <PluginBoard pluginId={id} />
        </>
      );
    }

    renderWithProviders(
      <PluginModuleLoaderProvider value={loader}>
        <Screens />
      </PluginModuleLoaderProvider>,
    );

    expect(await screen.findByText("Broken stopped rendering.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "open atlas" }));

    expect(await screen.findByText("atlas panel for atlas")).toBeTruthy();
    expect(screen.queryByText("Broken stopped rendering.")).toBeNull();
  });

  test("says so when the id belongs to no installed plugin", async () => {
    stubCatalog([plugin()]);
    const { loader } = loaderFor({});
    renderConsole(<PluginBoard pluginId="ghost" />, loader);

    expect(await screen.findByText(/No plugin with the id ghost is installed/)).toBeTruthy();
  });
});
