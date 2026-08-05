import { afterEach, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyTarget } from "../../src/features/models/ModelEditor.tsx";
import { ModelsScreen } from "../../src/routes/_app.models.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { modelFixture, targetFixture } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubModels(models = [modelFixture()]) {
  return createFetchStub({
    "GET /api/models": () => ({ models }),
    "PUT /api/models/fast": () => ({ ok: true }),
    "DELETE /api/models/fast": () => ({ ok: true }),
  });
}

test("every configured model is listed", async () => {
  stubModels([modelFixture({ id: "fast" }), modelFixture({ id: "smart" })]);
  renderWithProviders(<ModelsScreen />);
  expect(await screen.findByRole("button", { name: "fast" })).toBeDefined();
  expect(screen.getByRole("button", { name: "smart" })).toBeDefined();
});

test("an alias is marked so the operator knows it was synthesized", async () => {
  stubModels([modelFixture({ id: "claude-opus-4", isAlias: true })]);
  renderWithProviders(<ModelsScreen />);
  await screen.findByRole("button", { name: "claude-opus-4" });
  expect(screen.getByText(/alias/i)).toBeDefined();
});

test("selecting a model loads its targets into the editor", async () => {
  stubModels([
    modelFixture({
      targets: [
        targetFixture({ model: "claude-haiku-4" }),
        targetFixture({ provider: "openai", model: "gpt-5-mini", tier: 2 }),
      ],
    }),
  ]);
  renderWithProviders(<ModelsScreen />);
  await (await userEvent.setup()).click(await screen.findByRole("button", { name: "fast" }));
  expect(screen.getByDisplayValue("claude-haiku-4")).toBeDefined();
  expect(screen.getByDisplayValue("gpt-5-mini")).toBeDefined();
});

test("the strategy picker offers exactly the four router strategies", async () => {
  stubModels();
  renderWithProviders(<ModelsScreen />);
  await (await userEvent.setup()).click(await screen.findByRole("button", { name: "fast" }));
  const picker = screen.getByLabelText(/strategy/i);
  expect(Array.from(picker.querySelectorAll("option")).map((o) => o.getAttribute("value"))).toEqual(
    ["score", "priority", "roundRobin", "weighted"],
  );
});

test("saving puts the whole model back with a matching id", async () => {
  const stub = stubModels();
  renderWithProviders(<ModelsScreen />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "fast" }));
  await user.clear(screen.getByLabelText(/target 1 tier/i));
  await user.type(screen.getByLabelText(/target 1 tier/i), "2");
  await user.click(screen.getByRole("button", { name: /save model/i }));
  await waitFor(() =>
    expect(stub.calls.some((call) => call.url === "/api/models/fast")).toBe(true),
  );
  const put = stub.calls.find((call) => call.url === "/api/models/fast");
  const body = JSON.parse(String(put?.init?.body)) as { id: string; targets: { tier: number }[] };
  expect(put?.init?.method).toBe("PUT");
  expect(body.id).toBe("fast");
  expect(body.targets[0]?.tier).toBe(2);
});

test("the last target cannot be removed", async () => {
  stubModels();
  renderWithProviders(<ModelsScreen />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "fast" }));
  await user.click(screen.getByRole("button", { name: /remove target 1/i }));
  expect(screen.getByText(/at least one target/i)).toBeDefined();
});

test("empty targets contain complete store defaults", () => {
  expect(emptyTarget("kimi")).toEqual({
    provider: "kimi",
    model: "",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 0, output: 0 },
    capabilities: { tools: false, images: false, reasoning: false },
  });
});
