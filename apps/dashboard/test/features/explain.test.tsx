import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExplainPanel } from "../../src/features/models/ExplainPanel.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { dryRunResult, settings } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

function stubExplain(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/settings": () => ({ settings }),
    "POST /api/models/fast/dry-run": () => dryRunResult,
    ...overrides,
  });
}

describe("ExplainPanel", () => {
  test("does nothing until a model is chosen", async () => {
    stubExplain();
    renderWithProviders(<ExplainPanel modelId={null} />);

    expect(
      await screen.findByText("Select a model to see which account the router would pick for it."),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Rank candidates/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("sends only the capabilities, never a prompt", async () => {
    const user = userEvent.setup();
    const stub = stubExplain();
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByLabelText("Probe request uses tools"));
    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/models/fast/dry-run");
      expect(call?.init?.body).toBe(
        JSON.stringify({ tools: true, images: false, reasoning: false }),
      );
    });
  });

  test("names the winner and decomposes its score", async () => {
    const user = userEvent.setup();
    stubExplain();
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));

    expect(await screen.findByText("would be used")).toBeTruthy();
    expect(screen.getByText("claude-main")).toBeTruthy();
    expect(screen.getByText("13.50")).toBeTruthy();
    // tier 1 × weight 10 is the dominant term and is shown as such.
    expect(screen.getByLabelText("tier contributes 10.00 of 13.50")).toBeTruthy();
    expect(screen.getByLabelText("health contributes 3.00 of 13.50")).toBeTruthy();
  });

  test("lists what was filtered out and why", async () => {
    const user = userEvent.setup();
    stubExplain();
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));

    expect(await screen.findByText("Filtered out")).toBeTruthy();
    expect(screen.getByText("breaker:open")).toBeTruthy();
    // Which account, not just which model. Without it the row cannot say which
    // of a provider's accounts was dropped.
    expect(screen.getByText("cred-2")).toBeTruthy();
    expect(screen.getByText("1 eligible · 1 filtered out")).toBeTruthy();
  });

  test("a dangling pin names the account the target points at", async () => {
    const user = userEvent.setup();
    stubExplain({
      "POST /api/models/fast/dry-run": () => ({
        ...dryRunResult,
        candidates: [],
        excluded: [
          { credentialId: "cred-gone", model: "claude-opus-4", reason: "pin:missing" },
          // Same model and reason as the row above, one per target. Keyed on
          // content alone these collide and React drops one.
          { credentialId: "also-gone", model: "claude-opus-4", reason: "pin:missing" },
        ],
      }),
    });
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));

    await waitFor(() => expect(screen.getByText("cred-gone")).toBeTruthy());
    expect(screen.getByText("also-gone")).toBeTruthy();
    // `pin:missing` alone sends the operator back to the model editor to work
    // out which pin; the id is the whole finding.
    expect(screen.getAllByText("pin:missing")).toHaveLength(2);
  });

  test("warns that a weighted model does not rank the same way twice", async () => {
    const user = userEvent.setup();
    stubExplain({
      "POST /api/models/fast/dry-run": () => ({
        ...dryRunResult,
        strategy: "weighted",
        deterministic: false,
      }),
    });
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));
    expect(await screen.findByText("order varies per request")).toBeTruthy();
  });

  test("an empty candidate set explains itself rather than showing a blank list", async () => {
    const user = userEvent.setup();
    stubExplain({
      "POST /api/models/fast/dry-run": () => ({ ...dryRunResult, candidates: [] }),
    });
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));
    expect(
      await screen.findByText(
        "Every target was filtered out. The reasons below say which rule removed each one.",
      ),
    ).toBeTruthy();
  });

  test("a rejected model reports the gateway's message", async () => {
    const user = userEvent.setup();
    stubExplain({
      "POST /api/models/fast/dry-run": () => ({
        status: 404,
        body: { error: { code: "MODEL_UNAVAILABLE", message: 'no virtual model "fast"' } },
      }),
    });
    renderWithProviders(<ExplainPanel modelId="fast" />);

    await user.click(screen.getByRole("button", { name: /Rank candidates/ }));
    expect(await screen.findByText('no virtual model "fast"')).toBeTruthy();
  });
});
