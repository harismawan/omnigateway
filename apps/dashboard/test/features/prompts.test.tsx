import { describe, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSetKeyPrompts } from "../../src/api/queries.ts";
import { RailNav } from "../../src/components/RailNav.tsx";
import { PromptSelector } from "../../src/features/prompts/PromptSelector.tsx";
import { PromptsBoard } from "../../src/features/prompts/PromptsBoard.tsx";
import { invalidateTopic } from "../../src/session/invalidation.ts";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, settings } from "../helpers/fixtures.ts";
import { renderWithProviders, renderWithRouter } from "../helpers/render.tsx";

const currentText = "Current team instructions";
const team = {
  id: "team",
  name: "Team rules",
  description: "Shared rules",
  builtin: false,
  activeVersion: 3,
  estimatedTokens: 17,
  assignments: { global: true, keyIds: ["key-1"] },
  versions: [
    { version: 3, text: currentText, note: "latest", createdAt: 3 },
    { version: 1, text: "Original instructions", note: null, createdAt: 1 },
  ],
};
const builtin = {
  ...team,
  id: "ponytail-full",
  name: "Ponytail Full",
  builtin: true,
  activeVersion: "v4.9.0",
  versions: [{ version: "v4.9.0", text: "Pinned rules", note: null, createdAt: null }],
};
function stubPrompts() {
  return createFetchStub({
    "GET /api/status": () => ({ authenticated: true, principal: { kind: "admin" } }),
    "GET /api/prompts": () => [team, builtin],
    "GET /api/prompts/team": () => team,
    "GET /api/prompts/ponytail-full": () => builtin,
    "GET /api/settings": () => ({ settings: { ...settings, prompts: ["team"] } }),
    "GET /api/keys": () => ({
      keys: [apiKey({ prompts: { ids: ["team"], inheritGlobal: false } })],
    }),
    "GET /api/plugins": () => ({ plugins: [] }),
  });
}
describe("Prompt Management", () => {
  test("save keeps fields locked through delayed routed selection commit", async () => {
    const stub = stubPrompts();
    stub.set("POST /api/prompts/team/versions", () => ({
      promptId: "team",
      version: 4,
      text: currentText,
      note: null,
      createdAt: 4,
    }));
    let release: () => void = () => {
      throw new Error("navigation not started");
    };
    let started = false;
    const root = createRootRoute({
      beforeLoad: async ({ location }) => {
        if (location.searchStr.includes("version")) {
          started = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      },
      pendingMs: 60_000,
    });
    const route = createRoute({
      getParentRoute: () => root,
      path: "/",
      validateSearch: (search: Record<string, unknown>): { version?: string } =>
        typeof search.version === "string" ? { version: search.version } : {},
      component: Page,
    });
    function Page() {
      // Test router is deliberately separate from the app's registered route tree.
      const search = route.useSearch() as { version?: string };
      const navigate = route.useNavigate();
      return (
        <PromptsBoard
          id="team"
          {...search}
          onSelect={(_id, version) => navigate({ search: version ? { version } : {} })}
        />
      );
    }
    const router = createRouter({
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    renderWithProviders(<RouterProvider router={router as never} />);
    const user = userEvent.setup();
    await screen.findByDisplayValue(currentText);
    await user.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(started).toBe(true));
    expect(router.state.status).toBe("pending");
    for (const label of ["Name", "Description", "Prompt text", "Change note"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
      await user.type(screen.getByLabelText(label), " later edits");
    }
    expect(screen.queryByText("Saved.")).toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(router.state.status).toBe("idle"));
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(false),
    );
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(currentText);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Team rules");
    expect(router.state.location.search).toEqual({ version: "4" });
    await user.type(screen.getByLabelText("Prompt text"), " accepted after commit");
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      `${currentText} accepted after commit`,
    );
  });
  test("loaded historical detail is hidden after authoritative deletion, even with cached data", async () => {
    const stub = stubPrompts();
    const { client } = renderWithRouter(<PromptsBoard id="team" version="1" />);
    await screen.findByDisplayValue("Original instructions");
    stub.set("GET /api/prompts/team", () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "no such prompt" } },
    }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["prompts"] });
    });
    await waitFor(() => expect(client.getQueryState(["prompts", "team"])?.status).toBe("error"));
    await waitFor(() => expect(screen.queryByDisplayValue("Original instructions")).toBeNull());
    expect(screen.getByText("Version unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save as draft" })).toBeNull();
  });
  test("transient historical refresh failure retains exact cached draft read-only and recovers", async () => {
    const stub = stubPrompts();
    const user = userEvent.setup();
    const { client } = renderWithRouter(<PromptsBoard id="team" version="1" />);
    const text = await screen.findByLabelText("Prompt text");
    await user.type(text, " local");
    stub.set("GET /api/prompts/team", () => ({
      status: 503,
      body: { error: { code: "INTERNAL", message: "temporary failure" } },
    }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["prompts"] });
    });
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      "Original instructions local",
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(true),
    );
    expect(screen.getByRole("button", { name: "Save as draft" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByText(/Refresh failed/)).toBeTruthy();
    stub.set("GET /api/prompts/team", () => team);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["prompts"] });
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(false),
    );
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      "Original instructions local",
    );
  });
  test("remote refresh synchronizes clean text and metadata", async () => {
    const stub = stubPrompts();
    const { client } = renderWithRouter(<PromptsBoard id="team" />);
    await screen.findByDisplayValue(currentText);
    stub.set("GET /api/prompts/team", () => ({
      ...team,
      name: "Remote name",
      description: "Remote description",
      activeVersion: 4,
      versions: [{ version: 4, text: "Remote text", note: null, createdAt: 4 }, ...team.versions],
    }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["prompts"] });
    });
    await screen.findByRole("button", { name: "Version 4" });
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe("Remote text");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Remote name");
    await waitFor(() =>
      expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
        "Remote description",
      ),
    );
  });
  test("remote refresh preserves dirty fields and notes, flags conflicts, and still updates clean fields", async () => {
    const stub = stubPrompts();
    const user = userEvent.setup();
    const { client } = renderWithRouter(<PromptsBoard id="team" />);
    await screen.findByDisplayValue(currentText);
    await user.type(screen.getByLabelText("Name"), " local");
    await user.type(screen.getByLabelText("Prompt text"), " local");
    await user.type(screen.getByLabelText("Change note"), "unsaved note");
    stub.set("GET /api/prompts/team", () => ({
      ...team,
      name: "Remote name",
      description: "Remote description",
      activeVersion: 4,
      versions: [{ version: 4, text: "Remote text", note: null, createdAt: 4 }, ...team.versions],
    }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["prompts"] });
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Team rules local");
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      `${currentText} local`,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
        "Remote description",
      ),
    );
    expect(screen.getByDisplayValue("unsaved note")).toBeTruthy();
    expect(screen.getByText(/Changed remotely: Name, Prompt text/)).toBeTruthy();
  });
  for (const operation of ["create", "version", "metadata"] as const) {
    test(`pending ${operation} locks fields until the submitted snapshot is acknowledged`, async () => {
      const stub = stubPrompts();
      let release: (value: Record<string, unknown>) => void = () => {
        throw new Error("request not started");
      };
      const path =
        operation === "create"
          ? "POST /api/prompts"
          : operation === "version"
            ? "POST /api/prompts/team/versions"
            : "PUT /api/prompts/team";
      stub.set(
        path,
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const user = userEvent.setup();
      renderWithRouter(<PromptsBoard {...(operation === "create" ? {} : { id: "team" })} />);
      if (operation === "create") {
        await user.click(await screen.findByRole("button", { name: "New prompt" }));
        await user.type(screen.getByLabelText("ID"), "team");
        await user.type(screen.getByLabelText("Name"), "Team rules");
        await user.type(screen.getByLabelText("Description"), "Shared rules");
        await user.type(screen.getByLabelText("Prompt text"), currentText);
      } else await screen.findByDisplayValue(currentText);
      await user.click(
        screen.getByRole("button", {
          name: operation === "metadata" ? "Save metadata" : "Save as draft",
        }),
      );
      await waitFor(() =>
        expect(stub.calls.some((c) => `${c.init?.method} ${c.url}` === path)).toBe(true),
      );
      for (const label of ["Name", "Description", "Prompt text", "Change note"]) {
        expect((screen.getByLabelText(label) as HTMLInputElement).readOnly).toBe(true);
        await user.type(screen.getByLabelText(label), " later edits");
      }
      if (operation === "create")
        expect((screen.getByLabelText("ID") as HTMLInputElement).readOnly).toBe(true);
      await act(async () => {
        release(
          operation === "version"
            ? { promptId: "team", version: 4, text: currentText, note: null, createdAt: 4 }
            : team,
        );
      });
      await waitFor(() =>
        expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(false),
      );
      expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(currentText);
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Team rules");
      expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
        "Shared rules",
      );
    });
  }
  test("rail puts Prompt Management after Keys before Usage", async () => {
    stubPrompts();
    renderWithRouter(<RailNav />);
    const labels = (await screen.findAllByRole("link")).map((link) => link.textContent);
    expect(labels.indexOf("Prompt Management")).toBe(labels.indexOf("Keys") + 1);
    expect(labels.indexOf("Usage")).toBe(labels.indexOf("Prompt Management") + 1);
  });
  test("builtins first, read-only and duplicable", async () => {
    stubPrompts();
    const user = userEvent.setup();
    renderWithRouter(<PromptsBoard />);
    const library = await screen.findByRole("region", { name: "Library" });
    expect(within(library).getAllByRole("button")[1]?.textContent).toBe("Ponytail Full");
    await user.click(within(library).getByRole("button", { name: "Ponytail Full" }));
    expect(((await screen.findByLabelText("Prompt text")) as HTMLTextAreaElement).readOnly).toBe(
      true,
    );
    expect(screen.getByText("built-in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Duplicate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and activate" })).toBeNull();
  });
  test("missing history never substitutes current text", async () => {
    stubPrompts();
    renderWithRouter(<PromptsBoard id="team" version="2" />);
    expect(await screen.findByText("Version unavailable")).toBeTruthy();
    expect(screen.queryByDisplayValue(currentText)).toBeNull();
  });
  test("create error preserves ID and draft; retry sends draft mode", async () => {
    const stub = stubPrompts();
    stub.set("POST /api/prompts", () => ({
      status: 409,
      body: { error: { code: "CONFLICT", message: "Try again" } },
    }));
    const user = userEvent.setup();
    renderWithRouter(<PromptsBoard />);
    await user.click(await screen.findByRole("button", { name: "New prompt" }));
    await user.type(screen.getByLabelText("ID"), "new-rules");
    await user.type(screen.getByLabelText("Name"), "New rules");
    await user.type(screen.getByLabelText("Prompt text"), "  Keep leading spaces");
    await user.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(await screen.findByText("Try again")).toBeTruthy();
    expect(screen.getByDisplayValue("new-rules")).toBeTruthy();
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      "  Keep leading spaces",
    );
    const call = stub.calls.find((c) => c.init?.method === "POST");
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      id: "new-rules",
      name: "New rules",
      description: null,
      text: "  Keep leading spaces",
      note: null,
      activate: false,
    });
  });
  test("rollback, token feedback, explicit assignment counts, pruned predecessor", async () => {
    const stub = stubPrompts();
    stub.set("PUT /api/prompts/team/active", () => ({ ...team, activeVersion: 1 }));
    const user = userEvent.setup();
    renderWithRouter(<PromptsBoard id="team" />);
    await screen.findByLabelText("Name");
    expect(screen.getByText(/25 characters/)).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Editor" })).getByText(/17 estimated tokens/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Cannot delete: assigned globally and to 1 key/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Activate version 1" }));
    await waitFor(() =>
      expect(
        stub.calls.some((c) => c.url.endsWith("/active") && c.init?.body === '{"version":1}'),
      ).toBe(true),
    );
    expect(screen.getByText("Previous version unavailable (pruned)")).toBeTruthy();
  });
  test("readers have no enabled mutation controls", async () => {
    const stub = stubPrompts();
    stub.set("GET /api/status", () => ({ authenticated: true, principal: { kind: "viewer" } }));
    renderWithRouter(<PromptsBoard id="team" />);
    await screen.findByDisplayValue(currentText);
    for (const name of [
      "New prompt",
      "Save metadata",
      "Save and activate",
      "Save as draft",
      "Duplicate",
      "Delete",
      "Save global prompts",
    ]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });
  test("invalidation refetches library and detail", async () => {
    const stub = stubPrompts();
    const { client } = renderWithRouter(<PromptsBoard id="team" />);
    await screen.findByDisplayValue(currentText);
    const before = stub.calls.length;
    invalidateTopic(client, "res:prompts");
    await waitFor(() => {
      const urls = stub.calls.slice(before).map((c) => c.url);
      expect(urls).toContain("/api/prompts");
      expect(urls).toContain("/api/prompts/team");
    });
  });
  test("metadata save changes metadata only and retains unsaved text", async () => {
    const stub = stubPrompts();
    stub.set("PUT /api/prompts/team", () => ({ ...team, name: "Renamed" }));
    const user = userEvent.setup();
    renderWithRouter(<PromptsBoard id="team" />);
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.type(screen.getByLabelText("Prompt text"), " unsaved");
    await user.click(screen.getByRole("button", { name: "Save metadata" }));
    await waitFor(() =>
      expect(stub.calls.find((c) => c.init?.method === "PUT")?.init?.body).toBe(
        JSON.stringify({ name: "Renamed", description: "Shared rules" }),
      ),
    );
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      `${currentText} unsaved`,
    );
  });
  test("save and activate selects returned exact version, retry does not recreate", async () => {
    const stub = stubPrompts();
    stub.set("POST /api/prompts", () => ({
      ...team,
      id: "new-rules",
      versions: [{ version: 1, text: "New text", note: null, createdAt: 1 }],
    }));
    stub.set("GET /api/prompts/new-rules", () => ({
      status: 503,
      body: { error: { code: "INTERNAL", message: "unavailable" } },
    }));
    stub.set("POST /api/prompts/new-rules/versions", () => ({
      status: 503,
      body: { error: { code: "INTERNAL", message: "Save failed" } },
    }));
    const user = userEvent.setup();
    const { client } = renderWithRouter(<PromptsBoard />);
    await user.click(await screen.findByRole("button", { name: "New prompt" }));
    await user.type(screen.getByLabelText("ID"), "new-rules");
    await user.type(screen.getByLabelText("Name"), "New rules");
    await user.type(screen.getByLabelText("Prompt text"), "New text");
    await user.click(screen.getByRole("button", { name: "Save and activate" }));
    await screen.findByRole("button", { name: "Version 1" });
    await screen.findByText(/Refresh failed/);
    stub.set("GET /api/prompts/new-rules", () => ({
      ...team,
      id: "new-rules",
      versions: [{ version: 1, text: "New text", note: null, createdAt: 1 }],
    }));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["prompts"] });
    });
    await waitFor(() =>
      expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).readOnly).toBe(false),
    );
    await user.type(screen.getByLabelText("Prompt text"), " retry");
    await user.click(screen.getByRole("button", { name: "Save as draft" }));
    expect(await screen.findByText("Save failed")).toBeTruthy();
    expect(
      stub.calls.filter((c) => c.url === "/api/prompts" && c.init?.method === "POST"),
    ).toHaveLength(1);
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe(
      "New text retry",
    );
  });
  test("alias and ordered global list reconcile through authoritative settings refetch", async () => {
    const stub = stubPrompts();
    let stored = { ...settings, prompts: ["team"], ponytailMode: "off", maxRetries: 7 };
    stub.set("GET /api/settings", () => ({ settings: stored }));
    stub.set("PUT /api/settings", ({ init }) => {
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(input.maxRetries).toBe(7);
      if (input.prompts === undefined) {
        expect(input.ponytailMode).toBe("full");
        stored = { ...stored, ponytailMode: "full", prompts: ["team", "ponytail-full"] };
      } else {
        expect(input.prompts).toEqual(["team"]);
        stored = { ...stored, ponytailMode: "off", prompts: ["team"] };
      }
      return { ok: true };
    });
    const user = userEvent.setup();
    renderWithRouter(<PromptsBoard />);
    await user.click(await screen.findByRole("combobox", { name: "Lazy senior dev mode" }));
    await user.click(screen.getByRole("option", { name: "Full" }));
    await user.click(await screen.findByRole("button", { name: "Remove Ponytail Full" }));
    await user.click(screen.getByRole("button", { name: "Save global prompts" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Lazy senior dev mode" }) as HTMLButtonElement).value,
      ).toBe("off"),
    );
    expect(screen.getByRole("link", { name: /Edit prompts for/ }).getAttribute("href")).toBe(
      "/keys?prompts=key-1",
    );
  });
  test("selector orders IDs, removes, and filters second builtin", async () => {
    stubPrompts();
    const changes: string[][] = [];
    const user = userEvent.setup();
    renderWithRouter(
      <PromptSelector
        value={["team", "ponytail-full"]}
        library={[team, builtin, { ...builtin, id: "ponytail-lite", name: "Ponytail Lite" }]}
        onChange={(ids) => changes.push(ids)}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Move Ponytail Full up" }));
    expect(changes.at(-1)).toEqual(["ponytail-full", "team"]);
    await user.click(screen.getByRole("button", { name: "Remove Team rules" }));
    expect(changes.at(-1)).toEqual(["ponytail-full"]);
    await user.click(screen.getByRole("combobox", { name: "Add prompt" }));
    expect(screen.queryByRole("option", { name: "Ponytail Lite" })).toBeNull();
  });
  test("exact builtin version is readable", async () => {
    stubPrompts();
    renderWithRouter(<PromptsBoard id="ponytail-full" version="v4.9.0" />);
    expect(await screen.findByDisplayValue("Pinned rules")).toBeTruthy();
  });
  test("deleted requested historical detail stays unavailable", async () => {
    const stub = stubPrompts();
    stub.set("GET /api/prompts/team", () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "no such prompt" } },
    }));
    renderWithRouter(<PromptsBoard id="team" version="1" />);
    expect(await screen.findByText("Version unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save and activate" })).toBeNull();
    expect(screen.queryByDisplayValue(currentText)).toBeNull();
  });
  test("inactive draft explicit membership still blocks deletion", async () => {
    const stub = stubPrompts();
    stub.set("GET /api/prompts/team", () => ({
      ...team,
      activeVersion: null,
      assignments: { global: false, keyIds: ["revoked-key"] },
    }));
    renderWithRouter(<PromptsBoard id="team" />);
    await screen.findByDisplayValue(currentText);
    expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Cannot delete: assigned to 1 key/)).toBeTruthy();
  });
  test("five assigned IDs disable adding, including restored unavailable IDs", () => {
    renderWithProviders(
      <PromptSelector
        library={[team, builtin]}
        value={["a", "b", "c", "d", "e"]}
        onChange={() => {
          throw new Error("must not change");
        }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Add prompt" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
  test("existing draft save selects returned row, not active version", async () => {
    const stub = stubPrompts();
    stub.set("POST /api/prompts/team/versions", () => ({
      promptId: "team",
      version: 4,
      text: "New draft",
      note: "draft",
      createdAt: 4,
    }));
    const user = userEvent.setup();
    renderWithRouter(<PromptsBoard id="team" />);
    const text = await screen.findByLabelText("Prompt text");
    await user.clear(text);
    await user.type(text, "New draft");
    await user.click(screen.getByRole("button", { name: "Save as draft" }));
    await screen.findByRole("button", { name: "Version 4" });
    expect((screen.getByLabelText("Prompt text") as HTMLTextAreaElement).value).toBe("New draft");
    expect(stub.calls.find((c) => c.url.endsWith("/versions"))?.init?.body).toBe(
      JSON.stringify({ text: "New draft", note: null, activate: false }),
    );
  });
  test("shared key mutation sends strict assignment and refreshes explicit counts", async () => {
    const stub = stubPrompts();
    stub.set("PUT /api/keys/key-1/prompts", () => ({ ok: true }));
    function KeyMutation() {
      const mutation = useSetKeyPrompts();
      return (
        <button
          type="button"
          onClick={() => mutation.mutate({ id: "key-1", ids: ["team"], inheritGlobal: false })}
        >
          Set key prompts
        </button>
      );
    }
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <PromptsBoard id="team" />
        <KeyMutation />
      </>,
    );
    await screen.findByDisplayValue(currentText);
    const before = stub.calls.length;
    await user.click(screen.getByRole("button", { name: "Set key prompts" }));
    await waitFor(() =>
      expect(stub.calls.slice(before).filter((c) => c.url === "/api/prompts/team")).toHaveLength(1),
    );
    expect(stub.calls.find((c) => c.init?.method === "PUT")?.init?.body).toBe(
      '{"ids":["team"],"inheritGlobal":false}',
    );
    expect(stub.calls.slice(before).map((c) => c.url)).toContain("/api/keys");
  });
});
