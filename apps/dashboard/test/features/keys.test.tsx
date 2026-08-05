import { afterEach, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WireApiKey } from "../../src/api/types.ts";
import { KeysScreen, parseAllowlist } from "../../src/routes/_app.keys.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { modelFixture, NOW } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEY: WireApiKey = {
  id: "k1",
  label: "laptop",
  prefix: "omni_sk_abcd",
  modelAllowlist: null,
  rateLimitPerMin: null,
  createdAt: NOW - 86_400_000,
  revokedAt: null,
};

const MINTED = { id: "k9", label: "ci", prefix: "omni_sk_wxyz", key: "omni_sk_wxyz_test-key-1" };

function stubKeys(keys: WireApiKey[] = [KEY]) {
  return createFetchStub({
    "GET /api/keys": () => ({ keys }),
    "GET /api/models": () => ({
      models: [modelFixture({ id: "fast" }), modelFixture({ id: "smart" })],
    }),
    "POST /api/keys": () => MINTED,
    "DELETE /api/keys/k1": () => ({ ok: true }),
  });
}

test("an empty allowlist means unrestricted, not a key that permits nothing", () => {
  expect(parseAllowlist("   ", ["fast"])).toEqual({ models: null, unknown: [] });
});

test("the allowlist splits on commas and newlines and drops blanks", () => {
  expect(parseAllowlist("fast, smart\n\n fast ", ["fast", "smart"])).toEqual({
    models: ["fast", "smart"],
    unknown: [],
  });
});

test("a model that is not configured is reported back", () => {
  expect(parseAllowlist("fast, nope", ["fast"])).toEqual({
    models: ["fast", "nope"],
    unknown: ["nope"],
  });
});

test("existing keys are listed in named table by label and prefix, never in full", async () => {
  stubKeys();
  renderWithProviders(<KeysScreen now={NOW} />);
  expect(await screen.findByRole("table", { name: /api keys/i })).toBeDefined();
  expect(screen.getByText("laptop")).toBeDefined();
  expect(screen.getByText("omni_sk_abcd…")).toBeDefined();
  expect(screen.queryByText(/last used/i)).toBeNull();
  expect(screen.queryByText("omni_sk_wxyz_test-key-1")).toBeNull();
});

test("mint sends unrestricted null and optional rate limit", async () => {
  const stub = stubKeys();
  renderWithProviders(<KeysScreen now={NOW} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /create key/i }));
  await user.type(screen.getByLabelText(/label/i), "ci");
  await user.type(screen.getByLabelText(/rate limit/i), "60");
  await user.click(screen.getByRole("button", { name: /mint key/i }));
  await waitFor(() =>
    expect(
      stub.calls.some((call) => call.url === "/api/keys" && call.init?.method === "POST"),
    ).toBe(true),
  );
  const call = stub.calls.find((item) => item.url === "/api/keys" && item.init?.method === "POST");
  expect(JSON.parse(String(call?.init?.body))).toEqual({
    label: "ci",
    modelAllowlist: null,
    rateLimitPerMin: 60,
  });
  expect(await screen.findByRole("heading", { name: "Copy your API key" })).toBeDefined();
  expect(screen.getByText(/cannot be shown again/i)).toBeDefined();
  const mintedInput = screen.getByDisplayValue(MINTED.key) as HTMLInputElement;
  expect(mintedInput.readOnly).toBe(true);
  expect(mintedInput.className).toContain("font-mono");
  expect(localStorage.getItem("api-key") ?? "").not.toContain(MINTED.key);
});

test("an empty label is rejected locally without minting", async () => {
  const stub = stubKeys();
  renderWithProviders(<KeysScreen now={NOW} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /create key/i }));
  await user.type(screen.getByLabelText(/label/i), "   ");
  await user.click(screen.getByRole("button", { name: /mint key/i }));
  expect(await screen.findByText("Label is required.")).toBeDefined();
  expect(stub.calls.some((call) => call.init?.method === "POST" && call.url === "/api/keys")).toBe(
    false,
  );
});

test("invalid rate limits are rejected locally without minting", async () => {
  const stub = stubKeys();
  renderWithProviders(<KeysScreen now={NOW} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /create key/i }));
  await user.type(screen.getByLabelText(/label/i), "ci");
  await user.type(screen.getByLabelText(/rate limit/i), "0");
  await user.click(screen.getByRole("button", { name: /mint key/i }));
  expect(await screen.findByText("Rate limit must be a positive whole number.")).toBeDefined();
  expect(stub.calls.some((call) => call.init?.method === "POST" && call.url === "/api/keys")).toBe(
    false,
  );
});

test("the minted key is only copied from local dialog state and dismissed safely", async () => {
  stubKeys();
  const clipboard = navigator.clipboard;
  const writeText = async (_value: string) => undefined;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  try {
    renderWithProviders(<KeysScreen now={NOW} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /create key/i }));
    await user.type(screen.getByLabelText(/label/i), "ci");
    await user.click(screen.getByRole("button", { name: /mint key/i }));
    await screen.findByRole("heading", { name: "Copy your API key" });
    await user.click(screen.getByRole("button", { name: /copy/i }));
    expect(await screen.findByText("Copied")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "I saved this key" }));
    expect(screen.queryByText(MINTED.key)).toBeNull();
    await user.click(screen.getByRole("button", { name: /create key/i }));
    expect(screen.queryByText(MINTED.key)).toBeNull();
    expect(localStorage.getItem("api-key") ?? "").not.toContain(MINTED.key);
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  }
});

test("a clipboard rejection keeps the key visible without exposing it in the message", async () => {
  stubKeys();
  const clipboard = navigator.clipboard;
  const writeText = clipboard.writeText;
  Object.defineProperty(clipboard, "writeText", {
    configurable: true,
    value: async (_value: string) => Promise.reject(new Error("denied")),
  });
  try {
    renderWithProviders(<KeysScreen now={NOW} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /create key/i }));
    await user.type(screen.getByLabelText(/label/i), "ci");
    await user.click(screen.getByRole("button", { name: /mint key/i }));
    await screen.findByRole("heading", { name: "Copy your API key" });
    await user.click(screen.getByRole("button", { name: /^copy$/i }));
    expect(
      await screen.findByText("Could not copy key; select and copy it manually."),
    ).toBeDefined();
    expect(screen.getByDisplayValue(MINTED.key)).toBeDefined();
  } finally {
    Object.defineProperty(clipboard, "writeText", { configurable: true, value: writeText });
  }
});

test("a null rate limit is displayed as No limit", async () => {
  stubKeys();
  renderWithProviders(<KeysScreen now={NOW} />);
  expect(await screen.findByText("No limit")).toBeDefined();
});

test("revoking requires confirmation and invalidates the keys list", async () => {
  const stub = stubKeys();
  renderWithProviders(<KeysScreen now={NOW} />);
  const user = userEvent.setup();
  const row = await screen.findByRole("row", { name: /laptop/i });
  await user.click(within(row).getByRole("button", { name: /revoke/i }));
  expect(screen.getByText(/permanently revoke/i)).toBeDefined();
  await user.click(screen.getByRole("button", { name: /^revoke key$/i }));
  await waitFor(() =>
    expect(
      stub.calls.some((call) => call.url === "/api/keys/k1" && call.init?.method === "DELETE"),
    ).toBe(true),
  );
  expect(
    stub.calls.filter((call) => call.url === "/api/keys" && call.init?.method === "GET").length,
  ).toBe(2);
});

test("a revoke failure is rendered without removing the key", async () => {
  createFetchStub({
    "GET /api/keys": () => ({ keys: [KEY] }),
    "GET /api/models": () => ({ models: [] }),
    "DELETE /api/keys/k1": () => ({
      status: 500,
      body: { error: { code: "INTERNAL", message: "revoke failed" } },
    }),
  });
  renderWithProviders(<KeysScreen now={NOW} />);
  const user = userEvent.setup();
  const row = await screen.findByRole("row", { name: /laptop/i });
  await user.click(within(row).getByRole("button", { name: /revoke/i }));
  await user.click(screen.getByRole("button", { name: /^revoke key$/i }));
  expect(await screen.findByText("revoke failed")).toBeDefined();
  expect(screen.getByText("laptop")).toBeDefined();
});

test("a failed mint surfaces the gateway message and keeps the form open", async () => {
  createFetchStub({
    "GET /api/keys": () => ({ keys: [] }),
    "GET /api/models": () => ({ models: [] }),
    "POST /api/keys": () => ({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "label is required" } },
    }),
  });
  renderWithProviders(<KeysScreen now={NOW} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /create key/i }));
  await user.type(screen.getByLabelText(/label/i), "ci");
  await user.click(screen.getByRole("button", { name: /mint key/i }));
  expect(await screen.findByText("label is required")).toBeDefined();
  expect(screen.getByRole("dialog")).toBeDefined();
});
