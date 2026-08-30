import { expect, test } from "bun:test";
import { usePluginChannel } from "@omnigateway/dashboard-sdk";
import { act, screen } from "@testing-library/react";
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
import { renderWithRouter } from "../helpers/render.tsx";
import { createStubTimer, installSocketStub, type StubFrame } from "../helpers/socketStub.ts";

/**
 * A plugin panel receiving a frame, over the whole chain.
 *
 * Every other test in this change covers one seam: the gateway's unsubscribe,
 * the console's `hold`, the SDK hook against a stubbed transport. This one is
 * the join — a bundle loaded the way the console loads one, calling the hook a
 * published plugin would call, holding a topic on the console's real socket
 * client, and rendering what arrived. It is the test that would notice the
 * pieces being individually correct and wired to nothing, which is the state
 * this repository was in before the change: `ctx.channels.open` worked, the
 * gateway authorised the topic, and no browser could subscribe to it.
 */

const ENTRY = "/plugin-assets/atlas/index.js";
const TOPIC = "plugin:atlas:companion";

function catalogEntry(): PluginCatalogEntry {
  return {
    id: "atlas",
    name: "Atlas",
    version: "1.2.0",
    nav: { label: "Atlas" },
    ui: { entry: ENTRY, compatible: true },
  };
}

/** A panel written the way `docs/writing-a-plugin.md` tells an author to write one. */
function Companion({ pluginId }: PluginUiProps) {
  const [lines, setLines] = useState<string[]>([]);
  const { status, send } = usePluginChannel(pluginId, "companion", (payload) => {
    setLines((previous) => [...previous, String((payload as { line?: unknown }).line)]);
  });

  return (
    <div>
      <p>channel is {status}</p>
      <p>{lines.join(" ")}</p>
      <button type="button" onClick={() => send({ ask: "hello" })}>
        ask
      </button>
    </div>
  );
}

const loaderFor = (module: unknown): PluginModuleLoader => {
  return async (entry) => {
    if (entry !== ENTRY) throw new Error(`no bundle at ${entry}`);
    return module;
  };
};

const framesOfType = (frames: StubFrame[], type: string): StubFrame[] =>
  frames.filter((frame) => frame.type === type);

test("a mounted plugin panel holds its own channel and renders what is pushed to it", async () => {
  createFetchStub({ "GET /api/plugins": () => ({ plugins: [catalogEntry()] }) });
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithRouter(
    <PluginModuleLoaderProvider value={loaderFor({ default: { mount: Companion } })}>
      <Rack>
        <PluginBoard pluginId="atlas" />
      </Rack>
    </PluginModuleLoaderProvider>,
    { stream: { enabled: true, timer: timer.schedule } },
  );

  // The bundle is lazy, so the panel is not mounted — and the topic not held —
  // until the import resolves.
  expect(await screen.findByText("channel is idle")).toBeTruthy();

  act(() => {
    stub.last().open();
  });
  expect(framesOfType(stub.last().frames(), "subscribe").map((f) => f.topic)).toContain(TOPIC);

  act(() => {
    stub.last().emit({ type: "ack", topic: TOPIC });
  });
  expect(screen.getByText("channel is open")).toBeTruthy();

  act(() => {
    stub.last().emit({ type: "event", topic: TOPIC, payload: { line: "pikachu" } });
    stub.last().emit({ type: "event", topic: TOPIC, payload: { line: "used" } });
  });
  expect(screen.getByText("pikachu used")).toBeTruthy();

  // And back the other way, which is the half that makes it a channel rather
  // than a drain.
  act(() => {
    screen.getByRole("button", { name: "ask" }).click();
  });
  expect(framesOfType(stub.last().frames(), "send")).toEqual([
    { type: "send", topic: TOPIC, payload: { ask: "hello" } },
  ]);
});

test("a panel whose channel the host refuses says so rather than waiting", async () => {
  // What a viewer sees: `authorised` gives a plugin topic to an admin and to
  // nobody else. Silence here would be indistinguishable from a plugin that
  // simply has nothing to say, and an operator cannot act on that.
  createFetchStub({ "GET /api/plugins": () => ({ plugins: [catalogEntry()] }) });
  const stub = installSocketStub();
  const timer = createStubTimer();

  renderWithRouter(
    <PluginModuleLoaderProvider value={loaderFor({ default: { mount: Companion } })}>
      <Rack>
        <PluginBoard pluginId="atlas" />
      </Rack>
    </PluginModuleLoaderProvider>,
    { stream: { enabled: true, timer: timer.schedule } },
  );
  expect(await screen.findByText("channel is idle")).toBeTruthy();

  act(() => {
    stub.last().open();
    stub.last().emit({ type: "error", topic: TOPIC, message: "not permitted" });
  });

  expect(screen.getByText("channel is refused")).toBeTruthy();
  // Nothing is sent on a refused channel, so a panel cannot turn its own
  // refusal into a second one.
  act(() => {
    screen.getByRole("button", { name: "ask" }).click();
  });
  expect(framesOfType(stub.last().frames(), "send")).toEqual([]);
});
