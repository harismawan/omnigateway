import { describe, expect, test } from "bun:test";
import { PROVIDER_MODEL_CATALOG } from "@omni/providers/catalog";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Target } from "../../src/api/types.ts";
import {
  blankModel,
  blankTarget,
  catalogPrices,
  catalogTokenLimits,
  heldAuths,
  parseDraft,
  pinNote,
  reachableChoices,
  retargetDraft,
  toDraft,
  unreachableNote,
} from "../../src/features/models/draft.ts";
import { ModelsBoard } from "../../src/features/models/ModelsBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { credential, model, settings } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

describe("catalog pricing defaults", () => {
  test("a new target starts at the provider's list price, not at zero", () => {
    const target = blankTarget("anthropic");
    // A zero price reads as "unpriced" in the router and drops the target out
    // of cost ranking, so the default must be a real number.
    expect(target.model).toBe("claude-opus-5");
    expect(target.costInput).toBe("5");
    expect(target.costOutput).toBe("25");
    expect(target.costCacheRead).toBe("0.5");
  });

  test("each provider's default target is priced for that provider", () => {
    expect(blankTarget("openai").costInput).toBe("5");
    expect(blankTarget("kimi").costInput).toBe("3");
  });

  test("catalogPrices reports an unlisted model instead of guessing", () => {
    expect(catalogPrices("anthropic", "claude-haiku-4-5")).toEqual({
      costInput: "1",
      costOutput: "5",
      costCacheRead: "0.1",
      // 1.25x and 2x of input: what Anthropic charges to create a cache entry
      // at each TTL.
      costCacheWrite5m: "1.25",
      costCacheWrite1h: "2",
    });
    expect(catalogPrices("anthropic", "not-a-real-model")).toBeNull();
  });

  test("the defaults survive a round trip through the parser", () => {
    const parsed = parseDraft({ ...blankModel(), id: "fast" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.model.targets[0]?.costPerMTok).toEqual({
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite5m: 6.25,
        cacheWrite1h: 10,
      });
    }
  });
});

describe("catalog token limits", () => {
  test("a new target states no limits of its own", () => {
    // Saving a figure here pins it. Left blank, the gateway works the limits
    // out when it lists the model, which is the only place that can account for
    // an OpenAI target being served through the narrower Codex backend.
    const target = blankTarget("anthropic");
    expect(target.contextWindow).toBe("");
    expect(target.maxOutputTokens).toBe("");
  });

  test("changing the model clears the limits instead of pinning the new ones", () => {
    // The one path that can reach an OpenAI target: a blank target starts on
    // Anthropic, so creating one always goes through here. Carrying the API's
    // 922K across would pin it, and an OAuth account is served through Codex
    // at 272K — the narrowing this whole field exists for.
    const edited = {
      ...blankTarget("anthropic"),
      contextWindow: "500000",
      maxOutputTokens: "8000",
    };
    const retargeted = retargetDraft(edited, { provider: "openai", model: "gpt-5.6-sol" });

    expect(retargeted.contextWindow).toBe("");
    expect(retargeted.maxOutputTokens).toBe("");
    // Prices still follow the model — they have no fallback to be worked out.
    expect(retargeted.costInput).toBe("5");
    expect(retargeted.costOutput).toBe("30");
  });

  test("catalogTokenLimits reports an unlisted model instead of guessing", () => {
    expect(catalogTokenLimits("anthropic", "claude-haiku-4-5")).toEqual({
      contextWindow: "200000",
      maxOutputTokens: "64000",
    });
    expect(catalogTokenLimits("anthropic", "not-a-real-model")).toBeNull();
  });

  test("an unedited target is saved without limits, not with zeroes", () => {
    const parsed = parseDraft({ ...blankModel(), id: "fast" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.model.targets[0]).not.toHaveProperty("contextWindow");
      expect(parsed.model.targets[0]).not.toHaveProperty("maxOutputTokens");
    }
  });

  test("an edited limit survives a round trip through the parser", () => {
    const draft = blankModel();
    const target = draft.targets[0];
    if (target === undefined) throw new Error("a blank model has one target");
    const parsed = parseDraft({
      ...draft,
      id: "fast",
      targets: [{ ...target, contextWindow: "500000", maxOutputTokens: "64000" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.model.targets[0]?.contextWindow).toBe(500_000);
      expect(parsed.model.targets[0]?.maxOutputTokens).toBe(64_000);
    }
  });

  test("refuses a window that is not a whole number of tokens", () => {
    const draft = blankModel();
    const target = draft.targets[0];
    if (target === undefined) throw new Error("a blank model has one target");
    const parsed = parseDraft({
      ...draft,
      id: "fast",
      targets: [{ ...target, contextWindow: "1.5" }],
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("parseDraft", () => {
  test("requires and preserves endpoint id for custom targets", () => {
    const custom = { ...blankTarget("custom"), model: "local-model" };
    const missing = parseDraft({ ...blankModel(), id: "local", targets: [custom] });
    expect(missing).toEqual({ ok: false, problem: "Target 1 needs a custom endpoint." });

    const parsed = parseDraft({
      ...blankModel(),
      id: "local",
      targets: [{ ...custom, endpointId: "local-vllm" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.model.targets[0]).toMatchObject({ endpointId: "local-vllm" });
  });

  test("round-trips a model without inventing fields", () => {
    const original = model();
    const parsed = parseDraft(toDraft(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.model).toEqual(original);
  });

  test("omits cacheRead entirely when the field is blank", () => {
    const draft = toDraft(model());
    const target = draft.targets[0];
    if (target === undefined) throw new Error("fixture has no target");
    target.costCacheRead = "";

    const parsed = parseDraft(draft);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const [first] = parsed.model.targets;
      if (first === undefined) throw new Error("the parsed model lost its target");
      expect("cacheRead" in first.costPerMTok).toBe(false);
    }
  });

  test("refuses a model with no name", () => {
    const parsed = parseDraft({ ...blankModel(), id: "   " });
    expect(parsed).toEqual({
      ok: false,
      problem: "Give the model a name clients will ask for.",
    });
  });

  test("refuses a model with no targets", () => {
    const parsed = parseDraft({ ...blankModel(), id: "fast", targets: [] });
    expect(parsed).toEqual({
      ok: false,
      problem: "A model needs at least one target to route to.",
    });
  });

  test("names the offending target and the rule it broke", () => {
    const draft = { ...blankModel(), id: "fast", targets: [blankTarget(), blankTarget()] };
    const second = draft.targets[1];
    if (second === undefined) throw new Error("expected two targets");
    second.weight = "0";

    const parsed = parseDraft(draft);
    expect(parsed).toEqual({
      ok: false,
      problem: "Target 2: weight must be greater than zero.",
    });
  });

  test("rejects a fractional tier and a negative price", () => {
    const fractional = { ...blankModel(), id: "a", targets: [{ ...blankTarget(), tier: "1.5" }] };
    expect(parseDraft(fractional)).toEqual({
      ok: false,
      problem: "Target 1: tier must be a whole number of 1 or more.",
    });

    const negative = {
      ...blankModel(),
      id: "a",
      targets: [{ ...blankTarget(), costOutput: "-1" }],
    };
    expect(parseDraft(negative)).toEqual({
      ok: false,
      problem: "Target 1: prices cannot be negative.",
    });
  });
});

describe("per-model auth", () => {
  const oauthOnly = heldAuths([credential({ provider: "kilo", authType: "oauth" })]);

  test("a gateway-only model is not offered to an OAuth-only installation", () => {
    const ids = reachableChoices("kilo", oauthOnly).map((choice) => choice.id);
    // Present, so the filter is not simply emptying the list.
    expect(ids).toContain("anthropic/claude-sonnet-5");
    expect(ids).not.toContain("kilo-auto/frontier");
    expect(ids.some((id) => id.endsWith(":free"))).toBe(false);
  });

  test("connecting a key restores the whole list", () => {
    const both = heldAuths([
      credential({ id: "c1", provider: "kilo", authType: "oauth" }),
      credential({ id: "c2", provider: "kilo", authType: "apiKey" }),
    ]);
    expect(reachableChoices("kilo", both).map((choice) => choice.id)).toEqual(
      PROVIDER_MODEL_CATALOG.kilo.models.map((choice) => choice.id),
    );
  });

  test("a provider with no account is unknown, not blocked", () => {
    const other = heldAuths([credential({ provider: "anthropic", authType: "oauth" })]);
    expect(reachableChoices("kilo", other).map((choice) => choice.id)).toContain(
      "kilo-auto/frontier",
    );
  });

  test("a disabled credential still counts, so one bad token hides nothing", () => {
    const disabled = heldAuths([
      credential({ id: "c1", provider: "kilo", authType: "oauth" }),
      credential({ id: "c2", provider: "kilo", authType: "apiKey", enabled: false }),
    ]);
    expect(reachableChoices("kilo", disabled).map((choice) => choice.id)).toContain(
      "kilo-auto/frontier",
    );
  });

  test("the note names both sides, and says nothing about a reachable model", () => {
    expect(unreachableNote("kilo", "anthropic/claude-sonnet-5", oauthOnly)).toBeNull();
    // Unlisted is unknown, not forbidden: Kilo proxies several hundred models
    // and the catalog curates a few dozen.
    expect(unreachableNote("kilo", "qwen/qwen4-max", oauthOnly)).toBeNull();
    expect(unreachableNote("kilo", "", oauthOnly)).toBeNull();
    expect(unreachableNote("kilo", "kilo-auto/frontier", oauthOnly)).toBe(
      "kilo serves this model to an API key only, and every kilo account here is OAuth. " +
        "Requests routed here will fail.",
    );
  });
});

describe("pinning a target to one account", () => {
  test("a new target is unpinned", () => {
    // The normal state. Any account of the provider may serve it, which is what
    // every model saved before pinning existed already means.
    expect(blankTarget("anthropic").credentialId).toBe("");
  });

  test("an empty pin parses to no field rather than to an unmatchable id", () => {
    const parsed = parseDraft({ ...blankModel(), id: "fast" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect("credentialId" in (parsed.model.targets[0] ?? {})).toBe(false);
  });

  test("a pin survives the round trip", () => {
    const pinned = model({
      targets: [{ ...(model().targets[0] as Target), credentialId: "cred-2" }],
    });
    const parsed = parseDraft(toDraft(pinned));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.model).toEqual(pinned);
  });

  test("changing the provider drops the pin", () => {
    // An Anthropic account cannot serve an OpenAI target, so carrying the id
    // across would leave a pin the router can only report as `pin:missing`.
    const pinned = { ...blankTarget("anthropic"), credentialId: "cred-1" };
    expect(retargetDraft(pinned, { provider: "openai", model: "gpt-5.6-sol" }).credentialId).toBe(
      "",
    );
  });

  test("changing only the model keeps the pin", () => {
    // Same provider, same account. Clearing here would silently undo the
    // operator's choice on every keystroke in the model field.
    const pinned = { ...blankTarget("anthropic"), credentialId: "cred-1" };
    expect(
      retargetDraft(pinned, { provider: "anthropic", model: "claude-haiku-4-5" }).credentialId,
    ).toBe("cred-1");
  });

  test("the note names a pin no connected account can serve", () => {
    const held = [credential({ id: "cred-1", provider: "anthropic", label: "claude-main" })];
    expect(pinNote("cred-1", "anthropic", held)).toBeNull();
    expect(pinNote("", "anthropic", held)).toBeNull();
    expect(pinNote("cred-gone", "anthropic", held)).toBe(
      "No connected account has this id. Requests routed here will fail rather than " +
        "falling back to another account.",
    );
  });
});

function stubModels(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/models": () => ({ models: [model(), model({ id: "deep", strategy: "priority" })] }),
    "GET /api/settings": () => ({ settings }),
    ...overrides,
  });
}

/**
 * The editor mounts only once the model list has loaded, so every interaction
 * test waits for it and then re-queries; an element found earlier belongs to a
 * component that has since been replaced.
 */
async function openEditor(): Promise<void> {
  await waitFor(() => expect(screen.getByText("Edit model")).toBeTruthy());
}

describe("ModelsBoard", () => {
  test("opens the first model rather than an empty editor", async () => {
    stubModels();
    renderWithProviders(<ModelsBoard />);

    expect(await screen.findByText("2 models routing to 2 targets.")).toBeTruthy();
    await openEditor();
    expect((screen.getByLabelText("Model name") as HTMLInputElement).value).toBe("fast");
  });

  test("an existing model's name cannot be edited", async () => {
    stubModels();
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    expect((screen.getByLabelText("Model name") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/Fixed once created/)).toBeTruthy();
  });

  test("saving PUTs the whole model to its own id", async () => {
    const user = userEvent.setup();
    const stub = stubModels({ "PUT /api/models/fast": () => ({ ok: true }) });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/models/fast");
      expect(JSON.parse(String(put?.init?.body))).toEqual(model());
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  test("a new model needs a name before it is sent", async () => {
    const user = userEvent.setup();
    const stub = stubModels();
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    await user.click(screen.getByRole("button", { name: "New model" }));
    await user.click(await screen.findByRole("button", { name: "Create model" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Give the model a name clients will ask for.",
    );
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  test("custom targets choose an endpoint from connected credentials", async () => {
    const user = userEvent.setup();
    const stub = stubModels({
      "GET /api/credentials": () => ({
        credentials: [
          {
            id: "custom-1",
            provider: "custom",
            providerData: {
              endpointId: "local-vllm",
              endpointLabel: "Local vLLM",
              origin: "http://localhost:8000",
              protocol: "chat_completions",
            },
          },
        ],
      }),
      "PUT /api/models/fast": () => ({ ok: true }),
    });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    const provider = screen.getByLabelText("Provider") as HTMLSelectElement;
    expect(within(provider).getByRole("option", { name: "OpenAI Compatible" })).toBeTruthy();
    await user.selectOptions(provider, "custom");
    expect(provider.selectedOptions[0]?.textContent).toBe("OpenAI Compatible");
    await user.selectOptions(screen.getByLabelText("Endpoint"), "local-vllm");
    await user.type(screen.getByLabelText("Provider model"), "local-model");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(JSON.parse(String(put?.init?.body)).targets[0]).toMatchObject({
        provider: "custom",
        endpointId: "local-vllm",
        model: "local-model",
      });
    });
  });

  test("a target can be pinned to one connected account", async () => {
    const user = userEvent.setup();
    const stub = stubModels({
      "GET /api/credentials": () => ({
        credentials: [
          credential({ id: "cred-a", provider: "anthropic", accountEmail: "ops@example.com" }),
          credential({ id: "cred-b", provider: "anthropic", accountEmail: "billing@example.com" }),
          credential({ id: "cred-k", provider: "kimi", accountEmail: "kimi@example.com" }),
        ],
      }),
      "PUT /api/models/fast": () => ({ ok: true }),
    });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    const account = (await screen.findByLabelText("Account")) as HTMLSelectElement;
    // Only this provider's accounts. Pinning an Anthropic target to a Kimi
    // account would be a pin the router can only report as missing.
    expect(within(account).getByRole("option", { name: "billing@example.com" })).toBeTruthy();
    expect(within(account).queryByRole("option", { name: "kimi@example.com" })).toBeNull();

    await user.selectOptions(account, "cred-b");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(JSON.parse(String(put?.init?.body)).targets[0]).toMatchObject({
        credentialId: "cred-b",
      });
    });
  });

  test("an unpinned target sends no account at all", async () => {
    const user = userEvent.setup();
    const stub = stubModels({
      "GET /api/credentials": () => ({
        credentials: [credential({ id: "cred-a", provider: "anthropic" })],
      }),
      "PUT /api/models/fast": () => ({ ok: true }),
    });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      const target = JSON.parse(String(put?.init?.body)).targets[0];
      // Absent, not "": the control schema refuses the empty string, so sending
      // one would turn the default state of every target into a failed save.
      expect("credentialId" in target).toBe(false);
    });
  });

  test("a pin at a since-removed account is shown rather than silently dropped", async () => {
    stubModels({
      "GET /api/models": () => ({
        models: [
          model({
            targets: [{ ...(model().targets[0] as Target), credentialId: "cred-gone" }],
          }),
        ],
      }),
      "GET /api/credentials": () => ({
        credentials: [credential({ id: "cred-a", provider: "anthropic" })],
      }),
    });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    expect(
      await screen.findByText(
        /No connected account has this id\. Requests routed here will fail rather than/,
      ),
    ).toBeTruthy();
  });

  test("adding a target and saving includes it", async () => {
    const user = userEvent.setup();
    const stub = stubModels({ "PUT /api/models/fast": () => ({ ok: true }) });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    await user.click(screen.getByRole("button", { name: "Add target" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(JSON.parse(String(put?.init?.body)).targets).toHaveLength(2);
    });
  });

  test("the picker drops kilo models an OAuth-only account cannot reach", async () => {
    const user = userEvent.setup();
    stubModels({
      "GET /api/credentials": () => ({
        credentials: [credential({ id: "kilo-1", provider: "kilo", authType: "oauth" })],
      }),
    });
    const { container } = renderWithProviders(<ModelsBoard />);

    await openEditor();
    // Wait for the credentials query: the picker is unfiltered until it lands,
    // so asserting before it would pass against the wrong list.
    await waitFor(() => {
      const options = container.querySelectorAll("datalist option");
      expect([...options].some((option) => option.getAttribute("value") === "claude-opus-5")).toBe(
        true,
      );
    });

    await user.selectOptions(screen.getByLabelText("Provider"), "kilo");
    const offered = [...container.querySelectorAll("datalist option")].map((option) =>
      option.getAttribute("value"),
    );
    expect(offered).toContain("anthropic/claude-sonnet-5");
    expect(offered).not.toContain("kilo-auto/frontier");
    // No note yet: kilo's default model is served both ways, so the warning
    // below is about the model and not about the provider.
    expect(screen.queryByRole("note")).toBeNull();

    const field = screen.getByLabelText("Provider model");
    await user.clear(field);
    await user.type(field, "kilo-auto/frontier");
    expect((await screen.findByRole("note")).textContent).toContain(
      "kilo serves this model to an API key only",
    );
  });

  test("the last target cannot be removed", async () => {
    stubModels();
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    expect((screen.getByLabelText("Remove target 1") as HTMLButtonElement).disabled).toBe(true);
  });

  test("deleting a model explains what breaks first", async () => {
    const user = userEvent.setup();
    const stub = stubModels({ "DELETE /api/models/fast": () => ({ ok: true }) });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/makes it unroutable/i)).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Delete model" }));
    await waitFor(() => {
      expect(stub.calls.some((call) => call.init?.method === "DELETE")).toBe(true);
    });
  });

  test("choosing a different provider model re-prices the target", async () => {
    const user = userEvent.setup();
    const stub = stubModels({ "PUT /api/models/fast": () => ({ ok: true }) });
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    const model = screen.getByLabelText("Provider model");
    await user.clear(model);
    await user.type(model, "claude-haiku-4-5");

    await waitFor(() => {
      expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("1");
    });
    expect((screen.getByLabelText("Output") as HTMLInputElement).value).toBe("5");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(JSON.parse(String(put?.init?.body)).targets[0].costPerMTok).toEqual({
        input: 1,
        output: 5,
        cacheRead: 0.1,
        cacheWrite5m: 1.25,
        cacheWrite1h: 2,
      });
    });
  });

  test("a hand-edited price sticks until the model changes", async () => {
    const user = userEvent.setup();
    stubModels();
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    const input = screen.getByLabelText("Input");
    await user.clear(input);
    await user.type(input, "12.5");
    expect((input as HTMLInputElement).value).toBe("12.5");

    // Editing an unrelated field leaves the operator's price alone.
    const weight = screen.getByLabelText("Weight");
    await user.clear(weight);
    await user.type(weight, "2");
    expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("12.5");
  });

  test("list price can be restored after a hand edit", async () => {
    const user = userEvent.setup();
    stubModels();
    renderWithProviders(<ModelsBoard />);

    await openEditor();
    // The fixture is already at the catalog price for claude-haiku-4-5.
    expect(
      (screen.getByRole("button", { name: /Use list price/ }) as HTMLButtonElement).disabled,
    ).toBe(true);

    const input = screen.getByLabelText("Input");
    await user.clear(input);
    await user.type(input, "99");

    const reset = screen.getByRole("button", { name: /Use list price/ });
    expect((reset as HTMLButtonElement).disabled).toBe(false);
    await user.click(reset);

    await waitFor(() => {
      expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("1");
    });
  });

  test("with nothing configured the list invites the first model", async () => {
    createFetchStub({
      "GET /api/models": () => ({ models: [] }),
      "GET /api/settings": () => ({ settings }),
    });
    renderWithProviders(<ModelsBoard />);

    expect(
      await screen.findByText(
        "No virtual models exist yet, so no client request can resolve to an upstream.",
      ),
    ).toBeTruthy();
  });
});
