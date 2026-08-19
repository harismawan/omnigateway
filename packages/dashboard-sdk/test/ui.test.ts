import { expect, test } from "bun:test";
import { createPluginApi, definePluginUI, type PluginUiProps } from "../src/index.ts";

test("definePluginUI returns its argument unchanged", () => {
  // It is an identity function and must stay one. Anything it wrapped, copied,
  // or froze would run inside the plugin's bundle rather than the host's, where
  // the host cannot rely on it having happened at all.
  const definition = { mount: (props: PluginUiProps) => props.pluginId };
  expect(definePluginUI(definition)).toBe(definition);
});

test("the definition the host looks for is an object with a callable `mount`", () => {
  // The host checks this shape before React is involved, so that a plugin which
  // exported the wrong thing gets a disabled nav entry with a reason instead of
  // "Element type is invalid" inside the error boundary.
  const definition = definePluginUI({ mount: (props) => `panel for ${props.pluginId}` });
  expect(typeof definition).toBe("object");
  expect(typeof definition.mount).toBe("function");
  expect(definition.mount({ pluginId: "pokemon", api: createPluginApi("pokemon") })).toBe(
    "panel for pokemon",
  );
});
