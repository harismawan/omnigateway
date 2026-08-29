import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, screen, waitFor, within } from "@testing-library/react";
import { useProviderCatalog } from "../../src/api/queries.ts";
import type { ProviderId, UsageBucket } from "../../src/api/types.ts";
import { AccountsBoard } from "../../src/features/accounts/AccountsBoard.tsx";
import { ConnectDialog } from "../../src/features/accounts/ConnectDialog.tsx";
import { blankTarget } from "../../src/features/models/draft.ts";
import { TargetEditor } from "../../src/features/models/TargetEditor.tsx";
import { ModelTrafficPanel } from "../../src/features/usage/ModelTrafficPanel.tsx";
import { ProviderPanel } from "../../src/features/usage/ProviderPanel.tsx";
import { metricOf } from "../../src/features/usage/shared.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import {
  catalogFixture,
  credential,
  settings,
  usageBucket,
  wireCatalogFixture,
} from "../helpers/fixtures.ts";
import { queryWrapper, renderWithProviders } from "../helpers/render.tsx";

/**
 * One rule, six places that have to obey it.
 *
 * `/api/catalog` sends `order` and no promise about the array; the console
 * sorts once, in `catalogQuery`, and every screen then walks the array it was
 * handed. That is the whole contract, and `release/provider-modularity` had a
 * test for it which this branch deleted and replaced with nothing — after which
 * the sort could be removed, reversed, or ignored by any board, with the suite
 * still green.
 *
 * The reason it went uncovered is worth stating: a fixture already in ascending
 * `order` makes "sorted" and "unsorted" the same array, so nothing written
 * against one can tell them apart. `wireCatalogFixture()` is deliberately out
 * of order and `catalogFixture()` is that run through the rule, restated there
 * rather than imported from the code under test.
 */
const DRAWN = ["Anthropic", "OpenAI", "Kimi", "Kilo", "Grok", "OpenAI Compatible"];

const HOUR_MS = 3_600_000;
const NOW = Date.now();
const THIS_HOUR = String(Math.floor(NOW / HOUR_MS));

function bucket(split: string, requests: number): UsageBucket {
  return usageBucket({ key: THIS_HOUR, split, requests, errors: 0, costUsd: requests / 10 });
}

/** The window the panels below chart, one hour wide and ending now. */
const WINDOW = { by: "hour", since: NOW - HOUR_MS, until: NOW } as const;

describe("the catalog arrives in display order", () => {
  test("the loaded catalog is sorted by order, whatever the wire said", async () => {
    // The endpoint's own docstring says wire order is not a contract, so this
    // states it in the fixture: the payload below is a permutation, and the
    // list every screen reads must not be.
    const wire = wireCatalogFixture();
    expect(wire.map((entry) => entry.order)).not.toEqual([...wire.map((e) => e.order)].sort());

    createFetchStub({ "GET /api/catalog": () => ({ providers: wire }) });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const { result } = renderHook(() => useProviderCatalog(), { wrapper: queryWrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.map((entry) => entry.label)).toEqual(DRAWN);
  });
});

describe("every screen draws providers in that order", () => {
  test("the accounts board groups by provider in catalog order", async () => {
    // The one board that re-derives the order rather than walking the array:
    // the *set* comes from the connected accounts, so it needs a rank. Given
    // in the opposite order on purpose — a rank that is constant, or reversed,
    // leaves them exactly as they arrived.
    createFetchStub({
      "GET /api/credentials": () => ({
        credentials: [
          credential({ id: "c-kimi", provider: "kimi", label: "kimi-main" }),
          credential({ id: "c-grok", provider: "grok", label: "grok-main" }),
          credential({ id: "c-anthropic", provider: "anthropic", label: "claude-main" }),
        ],
      }),
      "GET /api/credentials/health": () => ({ health: [], quota: [], burn: [] }),
      "GET /api/settings": () => ({ settings, bodyLoggingAllowed: false }),
      "GET /api/models": () => ({ models: [] }),
    });
    renderWithProviders(<AccountsBoard />);

    const labels = await screen.findAllByLabelText(/^Label for /);
    expect(labels.map((input) => input.getAttribute("aria-label"))).toEqual([
      "Label for claude-main",
      "Label for kimi-main",
      "Label for grok-main",
    ]);
  });

  test("the provider usage table is ranked by the catalog, not by traffic", () => {
    // `bySplit` returns the busiest first, which is a different order and the
    // one that would show if the panel simply used what it was given. Hue is
    // categorical here: a provider must not change place between two windows
    // because it had a quiet afternoon.
    const { container } = renderWithProviders(
      <ProviderPanel
        buckets={[bucket("grok", 90), bucket("anthropic", 10), bucket("kimi", 50)]}
        metric={metricOf("requests")}
        {...WINDOW}
      />,
    );

    const rows = [...container.querySelectorAll("tbody tr td:first-child")];
    expect(rows.map((cell) => (cell.textContent ?? "").trim())).toEqual([
      "Anthropic",
      "Kimi",
      "Grok",
    ]);
  });

  test("the model traffic bands are grouped in catalog order", () => {
    // Each band keeps its provider's hue and gives up a step of it per model,
    // so the walk order decides which model gets the strongest shade as well as
    // where it sits. Reversed, the ramp reads backwards too.
    const { container } = renderWithProviders(
      <ModelTrafficPanel
        buckets={[bucket("grok-4.6", 90), bucket("claude-opus-5", 10), bucket("k3-256k", 50)]}
        metric={metricOf("requests")}
        providers={new Map<string, ProviderId>()}
        {...WINDOW}
      />,
    );

    const bands = [...container.querySelectorAll("[title]")];
    expect(bands.map((band) => (band.textContent ?? "").trim())).toEqual([
      "claude-opus-5",
      "k3-256k",
      "grok-4.6",
    ]);
  });

  test("the target editor's provider picker lists them in catalog order", () => {
    const catalog = catalogFixture();
    renderWithProviders(
      <TargetEditor
        target={blankTarget(catalog)}
        index={0}
        onChange={() => {}}
        onRemove={() => {}}
        removable={false}
        catalog={catalog}
        endpoints={[]}
        held={{}}
        credentials={[]}
      />,
    );

    const picker = screen.getByLabelText("Provider");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(DRAWN);
  });

  test("the connect dialog's provider picker lists them in catalog order", () => {
    createFetchStub({});
    renderWithProviders(<ConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />);

    const picker = screen.getByLabelText("Provider");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(DRAWN);
  });
});

/**
 * What each surface does with a provider the catalog does not name.
 *
 * Two different facts wear the same shape, and the console has to keep them
 * apart. A provider *removed* from a build — or supplied by a plugin that is no
 * longer installed — still has accounts connected to it, targets pointed at it
 * and requests logged against it, and all of that is real. `unknown` is the
 * store's own word for a request whose provider was never resolved, which is
 * the other fact.
 *
 * `AccountsBoard` already answered this correctly and said why. These are the
 * surfaces that answered it the other way in the same change.
 */
describe("a provider the catalog no longer names", () => {
  const catalogWithoutAnthropic = () =>
    catalogFixture().filter((provider) => provider.id !== "anthropic");

  test("its traffic stays on the usage panel instead of vanishing", () => {
    // Built from the catalog alone, the row was not moved to an "other" band or
    // folded into "Unresolved": it was dropped from the chart, the legend and
    // the table at once, while its requests stayed in the totals beside them.
    const { container } = renderWithProviders(
      <ProviderPanel
        buckets={[bucket("kimi", 10), bucket("anthropic", 90), bucket("unknown", 5)]}
        metric={metricOf("requests")}
        {...WINDOW}
      />,
      { client: clientWithout("anthropic") },
    );

    const rows = [...container.querySelectorAll("tbody tr td:first-child")];
    // Its own id, not "Unresolved": traffic really did go there, under a name
    // the operator chose. `unknown` keeps "Unresolved", which is a claim about
    // a request the gateway could not attribute at all.
    expect(rows.map((cell) => (cell.textContent ?? "").trim())).toEqual([
      "Kimi",
      "anthropic",
      "Unresolved",
    ]);
  });

  test("a target on it says so rather than reading as the first option", () => {
    // `<Select value="anthropic">` over options that do not include it falls
    // back to showing the first, so the target read as "Anthropic" — and one
    // keystroke anywhere else on the form saved it that way.
    const catalog = catalogWithoutAnthropic();
    renderWithProviders(
      <TargetEditor
        target={{ ...blankTarget(catalog), provider: "anthropic" as ProviderId }}
        index={0}
        onChange={() => {}}
        onRemove={() => {}}
        removable={false}
        catalog={catalog}
        endpoints={[]}
        held={{}}
        credentials={[]}
      />,
    );

    const picker = screen.getByLabelText<HTMLSelectElement>("Provider");
    expect(picker.value).toBe("anthropic");
    expect(within(picker).getByText("anthropic (not in the catalog)")).toBeTruthy();
  });
});

/**
 * What a picker starts on when the catalog does not list `anthropic`.
 *
 * The hardcoded default was invisible in exactly the way that matters: the
 * control showed its first option, so the screen looked right, while the state
 * behind it — and the request it sends — named a provider that is not there.
 */
describe("the default provider is the first the catalog lists", () => {
  test("a new target starts on it", () => {
    const catalog = catalogFixture().filter((provider) => provider.id !== "anthropic");
    expect(catalog[0]?.id).toBe("openai");
    expect(blankTarget(catalog).provider).toBe("openai");
    // And the model that goes with it, rather than an empty field the operator
    // has to notice.
    expect(blankTarget(catalog).model).toBe("gpt-5.6");
  });

  test("the connect dialog starts on it, and posts what it shows", async () => {
    const stub = createFetchStub({
      "POST /api/connect/start": () => ({
        flowId: "flow-1",
        authorizeUrl: "https://example.test/authorize",
        userCode: null,
        kind: "pkce",
        supportsManualPaste: true,
        pollIntervalMs: 5_000,
      }),
    });
    renderWithProviders(<ConnectDialog open onOpenChange={() => {}} onConnected={() => {}} />, {
      client: clientWithout("anthropic"),
    });

    const picker = screen.getByLabelText<HTMLSelectElement>("Provider");
    expect(picker.value).toBe("openai");

    screen.getByRole("button", { name: "Start authorization" }).click();
    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url === "/api/connect/start");
      expect(call?.init?.body).toBe(JSON.stringify({ provider: "openai", label: "OpenAI" }));
    });
  });
});

/** A seeded client whose catalog is missing one provider, as a build might be. */
function clientWithout(id: string): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryDefaults(["catalog"], { gcTime: Number.POSITIVE_INFINITY });
  client.setQueryData(
    ["catalog"],
    catalogFixture().filter((provider) => provider.id !== id),
  );
  return client;
}
