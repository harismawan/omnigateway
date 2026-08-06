import { afterEach, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DryRunPanel } from "../../src/features/models/DryRunPanel.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const RESULT = {
  modelId: "fast",
  strategy: "score" as const,
  deterministic: true,
  rankedAt: 1_700_000_000_000,
  candidates: [
    {
      credentialId: "a",
      credentialLabel: "work",
      provider: "anthropic" as const,
      model: "claude-opus-4",
      tier: 1,
      score: 12.5,
      reasons: { tier: 1, health: 1, quota: 0.75, cost: 0.5, latency: 0.9, recency: 0.2 },
    },
    {
      credentialId: "b",
      credentialLabel: "personal",
      provider: "anthropic" as const,
      model: "claude-opus-4",
      tier: 1,
      score: 11.1,
      reasons: { tier: 1, health: 0.5, quota: 1, cost: 0.5, latency: 0.4, recency: 1 },
    },
  ],
  excluded: [
    { credentialId: "c", model: "claude-opus-4", reason: "breaker:open" },
    { credentialId: "d", model: "gpt-5", reason: "capability:images" },
  ],
};

test("the panel does not rank until the operator asks", () => {
  const stub = createFetchStub({ "POST /api/models/fast/dry-run": () => RESULT });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  expect(screen.getByRole("button", { name: /run/i })).toBeDefined();
  expect(stub.calls).toHaveLength(0);
});

test("running shows the candidates best first with their scores", async () => {
  createFetchStub({ "POST /api/models/fast/dry-run": () => RESULT });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /run/i }));

  const rows = await screen.findAllByRole("row", { name: /claude-opus-4/i });
  expect(within(rows[0] as HTMLElement).getByText("work")).toBeDefined();
  expect(within(rows[0] as HTMLElement).getByText("anthropic")).toBeDefined();
  expect(within(rows[0] as HTMLElement).getByText("12.50")).toBeDefined();
  expect(within(rows[1] as HTMLElement).getByText("personal")).toBeDefined();
});

test("expanding a candidate breaks its score into the six weighted terms", async () => {
  createFetchStub({ "POST /api/models/fast/dry-run": () => RESULT });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /run/i }));
  await screen.findAllByRole("row", { name: /claude-opus-4/i });

  await user.click(screen.getByRole("button", { name: /score breakdown for work/i }));
  for (const term of ["tier", "health", "quota", "cost", "latency", "recency"]) {
    expect(screen.getAllByText(new RegExp(`^${term}$`, "i")).length).toBeGreaterThan(0);
  }
  expect(screen.getByText("0.75")).toBeDefined();
});

test("excluded candidates are listed with the reason each was dropped", async () => {
  createFetchStub({ "POST /api/models/fast/dry-run": () => RESULT });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /run/i }));

  const excluded = await screen.findByRole("region", { name: /excluded/i });
  expect(within(excluded).getByText(/breaker:open/i)).toBeDefined();
  expect(within(excluded).getByText(/capability:images/i)).toBeDefined();
});

test("the capability toggles are sent in the dry-run body", async () => {
  const stub = createFetchStub({ "POST /api/models/fast/dry-run": () => RESULT });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("checkbox", { name: /needs tools/i }));
  await user.click(screen.getByRole("checkbox", { name: /needs images/i }));
  await user.click(screen.getByRole("button", { name: /run/i }));

  await waitFor(() => expect(stub.calls).toHaveLength(1));
  expect(stub.calls[0]?.init?.body).toBe(
    JSON.stringify({ tools: true, images: true, reasoning: false }),
  );
});

test("a weighted model warns that the live ordering will differ", async () => {
  createFetchStub({
    "POST /api/models/fast/dry-run": () => ({
      ...RESULT,
      strategy: "weighted",
      deterministic: false,
    }),
  });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /run/i }));
  expect(await screen.findByText(/live ordering will differ/i)).toBeDefined();
});

test("a result without exclusions states that nothing was filtered out", async () => {
  createFetchStub({ "POST /api/models/fast/dry-run": () => ({ ...RESULT, excluded: [] }) });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /run/i }));
  const excluded = await screen.findByRole("region", { name: /excluded/i });
  expect(within(excluded).getByText("Nothing was filtered out.")).toBeDefined();
});

test("collapsing dry-run results does not refetch and rerunning opens them", async () => {
  const stub = createFetchStub({ "POST /api/models/fast/dry-run": () => RESULT });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: /run/i }));
  const results = await screen.findByRole("group", { name: "Dry-run results" });
  expect(results).toHaveProperty("open", true);

  await user.click(screen.getByText("Dry-run results"));
  expect(results).toHaveProperty("open", false);
  expect(stub.calls.filter((call) => call.url === "/api/models/fast/dry-run")).toHaveLength(1);

  await user.click(screen.getByRole("button", { name: /run/i }));
  await waitFor(() => expect(stub.calls).toHaveLength(2));
  expect(results).toHaveProperty("open", true);
});

test("no eligible candidate is stated plainly rather than as an empty table", async () => {
  createFetchStub({ "POST /api/models/fast/dry-run": () => ({ ...RESULT, candidates: [] }) });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /run/i }));
  expect(await screen.findByText(/no candidate would be eligible/i)).toBeDefined();
});

test("a failed dry run surfaces the gateway's message", async () => {
  createFetchStub({
    "POST /api/models/fast/dry-run": () => ({
      status: 404,
      body: { error: { code: "MODEL_UNAVAILABLE", message: 'no virtual model "fast"' } },
    }),
  });
  renderWithProviders(<DryRunPanel modelId="fast" />);
  await (await userEvent.setup()).click(screen.getByRole("button", { name: /run/i }));
  expect(await screen.findByText(/no virtual model "fast"/i)).toBeDefined();
});
