import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
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
    renderWithRouter(<PromptsBoard />);
    await user.click(await screen.findByRole("button", { name: "New prompt" }));
    await user.type(screen.getByLabelText("ID"), "new-rules");
    await user.type(screen.getByLabelText("Name"), "New rules");
    await user.type(screen.getByLabelText("Prompt text"), "New text");
    await user.click(screen.getByRole("button", { name: "Save and activate" }));
    await screen.findByRole("button", { name: "Version 1" });
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
