import { expect, test } from "bun:test";
import { usePluginChannel } from "../src/channel.ts";
import * as sdk from "../src/index.ts";

/**
 * The half of `usePluginChannel` that needs no DOM, for the reason
 * `live.test.ts` sets out: the hook needs a renderer, registering happy-dom
 * mutates process-wide globals, and that is why the root `bun test` excludes
 * the dashboard suite. Behaviour — status, composition, what a send refuses —
 * is covered in `apps/dashboard/test/session/pluginChannel.test.tsx`, which
 * `bun run test:all` and CI both run.
 *
 * What is worth pinning here is the export surface. A plugin bundle resolves
 * this package through the console's import map, where a missing binding is a
 * load-time SyntaxError in the plugin rather than an `undefined` at the call —
 * so a rename breaks every published panel at mount, and does it in a message
 * that names the plugin.
 */

test("the package exports the channel hook by the name a panel imports", () => {
  expect(Object.keys(sdk)).toContain("usePluginChannel");
  expect(typeof sdk.usePluginChannel).toBe("function");
});

test("the index re-export is the module's own binding", () => {
  // Not a wrapper. A wrapper would be a second identity for a hook, which is
  // the same class of mistake as a second copy of the context it reads.
  expect(sdk.usePluginChannel).toBe(usePluginChannel);
});
