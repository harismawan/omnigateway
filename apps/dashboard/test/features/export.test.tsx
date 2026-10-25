import { describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ExportDestinationView,
  ExportWorkerState,
  StatusResponse,
} from "../../src/api/types.ts";
import { ExportBoard } from "../../src/features/export/ExportBoard.tsx";
import { createFetchStub, type StubHandler } from "../helpers/fetchStub.ts";
import { renderWithProviders } from "../helpers/render.tsx";
import { choose } from "../helpers/select.ts";

const NOW = Date.now();

const ADMIN: StatusResponse = {
  configured: true,
  authenticated: true,
  principal: { kind: "admin" },
  viewerConfigured: false,
};

function destination(patch: Partial<ExportDestinationView> = {}): ExportDestinationView {
  return {
    id: "hook",
    generation: "gen-1",
    type: "webhook",
    enabled: true,
    config: { url: "https://receiver.example/in", headers: {} },
    filter: {},
    filterMalformed: false,
    includeBodies: false,
    maxRequestBytes: null,
    startAt: NOW - 3_600_000,
    hasSecret: true,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
    status: {
      lagMs: 12_000,
      lastSuccessAt: NOW - 60_000,
      lastError: null,
      lastErrorAt: null,
      exportedTotal: 120,
      droppedTotal: 0,
      gapPossibleAt: null,
      skipRequestedAt: null,
      retryAt: null,
      failing: false,
    },
    ...patch,
  };
}

function stubExport(
  input: {
    destinations?: ExportDestinationView[];
    state?: ExportWorkerState;
    status?: StatusResponse;
  } = {},
  overrides: Record<string, StubHandler> = {},
) {
  return createFetchStub({
    "GET /api/status": () => input.status ?? ADMIN,
    "GET /api/export/destinations": () => ({
      destinations: input.destinations ?? [destination()],
      worker: { state: input.state ?? "running", restarts: 0 },
    }),
    ...overrides,
  });
}

function bodyOf(stub: ReturnType<typeof createFetchStub>, method: string, url: string): unknown {
  const call = stub.calls.find(
    (c) => (c.init?.method ?? "GET").toUpperCase() === method && c.url === url,
  );
  if (call === undefined) throw new Error(`no ${method} ${url}`);
  return JSON.parse(String(call.init?.body ?? "null"));
}

async function rowOf(id: string): Promise<HTMLElement> {
  const cell = await screen.findByText(id);
  const row = cell.closest("tr");
  if (row === null) throw new Error(`no row for ${id}`);
  return row;
}

describe("ExportBoard", () => {
  test("lists each destination with its type, target, lag, last success and last error", async () => {
    stubExport({
      destinations: [
        destination(),
        destination({
          id: "es",
          generation: "gen-2",
          type: "elasticsearch",
          config: {
            url: "https://es.internal:9200",
            index: "omni-logs-{yyyy.MM.dd}",
            auth: "apiKey",
            flavor: "elasticsearch",
          },
          status: {
            ...(destination().status as NonNullable<ExportDestinationView["status"]>),
            lagMs: 7_200_000,
            lastError: "HTTP 401",
            lastErrorAt: NOW - 30_000,
            failing: true,
          },
        }),
      ],
    });
    renderWithProviders(<ExportBoard />);

    const hook = await rowOf("hook");
    expect(hook.textContent).toContain("webhook");
    expect(hook.textContent).toContain("https://receiver.example/in");
    expect(hook.textContent).toContain("12s");
    expect(hook.textContent).toContain("1m ago");

    const es = await rowOf("es");
    expect(es.textContent).toContain("elasticsearch");
    expect(es.textContent).toContain("2h");
    expect(es.textContent).toContain("HTTP 401");
    expect(within(es).getByText("failing")).toBeTruthy();
  });

  test("an installation with no destinations is invited to add one", async () => {
    stubExport({ destinations: [], state: "idle" });
    renderWithProviders(<ExportBoard />);

    expect(await screen.findByText("No destinations")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Export worker" })).toBeNull();
  });

  test("the enabled toggle saves at once", async () => {
    const user = userEvent.setup();
    const stub = stubExport(
      {},
      {
        "PUT /api/export/destinations/hook": () => ({
          destination: destination({ enabled: false }),
        }),
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("switch", { name: "Export to hook" }));
    await waitFor(() =>
      expect(bodyOf(stub, "PUT", "/api/export/destinations/hook")).toEqual({ enabled: false }),
    );
  });

  test("Send test reports the receiver's answer, and a failed delivery as such", async () => {
    const user = userEvent.setup();
    const stub = stubExport(
      {},
      {
        "POST /api/export/destinations/hook/test": () => ({ ok: true, status: 200, latencyMs: 42 }),
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Send test to hook" }));
    expect(await screen.findByText("Test record accepted: HTTP 200 in 42ms")).toBeTruthy();
    expect(stub.calls.some((c) => c.url === "/api/export/destinations/hook/test")).toBe(true);

    stub.set("POST /api/export/destinations/hook/test", () => ({
      ok: false,
      status: 401,
      error: "HTTP 401",
    }));
    await user.click(screen.getByRole("button", { name: "Send test to hook" }));
    expect(await screen.findByText("Test failed: HTTP 401")).toBeTruthy();
  });

  test("Skip to now asks first, then posts", async () => {
    const user = userEvent.setup();
    let skipped = false;
    stubExport(
      {},
      {
        "POST /api/export/destinations/hook/skip": () => {
          skipped = true;
          return { ok: true, at: NOW };
        },
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Skip hook to now" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("dropped");
    expect(skipped).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Skip to now" }));
    await waitFor(() => expect(skipped).toBe(true));
  });

  test("a gap warning is shown until acknowledged, and the acknowledgement names what was seen", async () => {
    const user = userEvent.setup();
    const gapAt = NOW - 5_000;
    const stub = stubExport(
      {
        destinations: [
          destination({
            status: {
              ...(destination().status as NonNullable<ExportDestinationView["status"]>),
              gapPossibleAt: gapAt,
            },
          }),
        ],
      },
      {
        "POST /api/export/destinations/hook/gap/acknowledge": () => ({ ok: true, cleared: true }),
      },
    );
    renderWithProviders(<ExportBoard />);

    expect(await screen.findByText(/rows may have been pruned before export/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Acknowledge gap warning for hook" }));
    await waitFor(() =>
      expect(bodyOf(stub, "POST", "/api/export/destinations/hook/gap/acknowledge")).toEqual({
        seenAt: gapAt,
      }),
    );
  });

  for (const [state, words] of [
    ["down", /stopped after failing repeatedly/],
    ["stopping", /previous export worker has not exited yet/],
    ["halted", /restore failed/],
    ["paused", /database is being restored/],
    ["restarting", /restarting/],
  ] as const) {
    test(`a worker that is ${state} is announced, and test, skip and acknowledge are disabled`, async () => {
      stubExport({
        state,
        destinations: [
          destination({
            status: {
              ...(destination().status as NonNullable<ExportDestinationView["status"]>),
              gapPossibleAt: NOW,
            },
          }),
        ],
      });
      renderWithProviders(<ExportBoard />);

      const banner = await screen.findByRole("status", { name: "Export worker" });
      expect(banner.textContent).toMatch(words);
      const send = screen.getByRole("button", { name: "Send test to hook" }) as HTMLButtonElement;
      const skip = screen.getByRole("button", { name: "Skip hook to now" }) as HTMLButtonElement;
      const ack = screen.getByRole("button", {
        name: "Acknowledge gap warning for hook",
      }) as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      expect(skip.disabled).toBe(true);
      expect(ack.disabled).toBe(true);
    });
  }

  test("a running worker shows no banner", async () => {
    stubExport();
    renderWithProviders(<ExportBoard />);

    await rowOf("hook");
    expect(screen.queryByRole("status", { name: "Export worker" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Send test to hook" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("a viewer reads the list but is offered no control", async () => {
    stubExport({ status: { ...ADMIN, principal: { kind: "viewer" } } });
    renderWithProviders(<ExportBoard />);

    await rowOf("hook");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Add a destination" })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Send test to hook" })).toBeNull();
    expect(
      (screen.getByRole("switch", { name: "Export to hook" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("creating a webhook sends its config and secret, and starts from now unless asked", async () => {
    const user = userEvent.setup();
    const stub = stubExport(
      { destinations: [] },
      {
        "POST /api/export/destinations": () => ({ destination: destination() }),
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Add a destination" }));
    const dialog = await screen.findByRole("dialog");
    await choose(user, within(dialog).getByLabelText("Type"), "webhook");
    await user.type(within(dialog).getByLabelText("ID"), "hook");
    await user.type(within(dialog).getByLabelText("URL"), "https://receiver.example/in");
    await user.type(within(dialog).getByLabelText("Headers"), "x-team: gateway");
    await user.type(within(dialog).getByLabelText("Signing secret"), "whsec-1");
    await user.type(within(dialog).getByLabelText("Only these models"), "a, b");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));

    await waitFor(() =>
      expect(bodyOf(stub, "POST", "/api/export/destinations")).toEqual({
        id: "hook",
        type: "webhook",
        startFrom: "now",
        enabled: true,
        config: { url: "https://receiver.example/in", headers: { "x-team": "gateway" } },
        filter: { models: ["a", "b"] },
        maxRequestBytes: null,
        secret: { signingSecret: "whsec-1" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("creating an Elasticsearch destination takes the credential its auth mode needs", async () => {
    const user = userEvent.setup();
    const stub = stubExport(
      { destinations: [] },
      { "POST /api/export/destinations": () => ({ destination: destination() }) },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Add a destination" }));
    const dialog = await screen.findByRole("dialog");
    await choose(user, within(dialog).getByLabelText("Type"), "elasticsearch");
    await user.type(within(dialog).getByLabelText("ID"), "es");
    await user.type(within(dialog).getByLabelText("URL"), "https://es:9200");
    await choose(user, within(dialog).getByLabelText("Authentication"), "basic");
    await user.type(within(dialog).getByLabelText("Username"), "elastic");
    await user.type(within(dialog).getByLabelText("Password"), "pw");
    await choose(user, within(dialog).getByLabelText("Start from"), "oldest");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));

    await waitFor(() =>
      expect(bodyOf(stub, "POST", "/api/export/destinations")).toMatchObject({
        id: "es",
        type: "elasticsearch",
        startFrom: "oldest",
        config: { url: "https://es:9200", auth: "basic", flavor: "elasticsearch" },
        secret: { username: "elastic", password: "pw" },
      }),
    );
  });

  test("a refusal from the gateway is shown as it was returned and keeps the dialog open", async () => {
    const user = userEvent.setup();
    stubExport(
      { destinations: [] },
      {
        "POST /api/export/destinations": () => ({
          status: 400,
          body: { error: { code: "BAD_REQUEST", message: "config.url: must be a valid URL" } },
        }),
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Add a destination" }));
    const dialog = await screen.findByRole("dialog");
    await choose(user, within(dialog).getByLabelText("Type"), "otlp");
    await user.type(within(dialog).getByLabelText("ID"), "lf");
    await user.type(within(dialog).getByLabelText("Endpoint"), "nope");
    await user.click(within(dialog).getByRole("button", { name: "Add destination" }));

    expect(await within(dialog).findByText("config.url: must be a valid URL")).toBeTruthy();
  });

  test("editing shows the secret as set, never prefilled, and keeps it unless replaced or cleared", async () => {
    const user = userEvent.setup();
    const stub = stubExport(
      {},
      {
        "PUT /api/export/destinations/hook": () => ({ destination: destination() }),
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit hook" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Secret: set")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Signing secret")).toBeNull();
    expect((within(dialog).getByLabelText("URL") as HTMLInputElement).value).toBe(
      "https://receiver.example/in",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const body = bodyOf(stub, "PUT", "/api/export/destinations/hook") as Record<string, unknown>;
      // No secret (kept) and no filter (untouched): an unrelated edit must not
      // rewrite an unreadable, match-nothing filter as "every request".
      expect(body).toEqual({
        config: { url: "https://receiver.example/in", headers: {} },
        maxRequestBytes: null,
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    stub.calls.length = 0;
    await user.click(screen.getByRole("button", { name: "Edit hook" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Replace secret" }));
    const field = within(dialog).getByLabelText("Signing secret") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    await user.type(field, "rotated");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(bodyOf(stub, "PUT", "/api/export/destinations/hook")).toMatchObject({
        secret: { signingSecret: "rotated" },
      }),
    );

    stub.calls.length = 0;
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Edit hook" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Clear secret" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(bodyOf(stub, "PUT", "/api/export/destinations/hook")).toMatchObject({ secret: null }),
    );
  });

  test("the bodies switch is shown off and disabled, as a later release", async () => {
    const user = userEvent.setup();
    stubExport();
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Edit hook" }));
    const dialog = await screen.findByRole("dialog");
    const bodies = within(dialog).getByRole("switch", {
      name: "Export bodies",
    }) as HTMLButtonElement;
    expect(bodies.disabled).toBe(true);
    expect(bodies.getAttribute("aria-checked")).toBe("false");
    expect(within(dialog).getByText(/available in a later release/)).toBeTruthy();
  });

  test("remove asks first, then deletes", async () => {
    const user = userEvent.setup();
    let removed = false;
    stubExport(
      {},
      {
        "DELETE /api/export/destinations/hook": () => {
          removed = true;
          return { ok: true };
        },
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.click(await screen.findByRole("button", { name: "Remove hook" }));
    const dialog = await screen.findByRole("dialog");
    expect(removed).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Remove destination" }));
    await waitFor(() => expect(removed).toBe(true));
  });

  test("preview shows one request as it would be sent", async () => {
    const user = userEvent.setup();
    stubExport(
      {},
      {
        "GET /api/export/preview": ({ url }) => ({
          record: {
            schema: "omni.request_log/v1",
            request_id: new URL(url, "http://x").searchParams.get("requestId"),
          },
        }),
      },
    );
    renderWithProviders(<ExportBoard />);

    await user.type(await screen.findByLabelText("Request ID"), "req_42");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const shown = await screen.findByText(/omni\.request_log\/v1/);
    expect(shown.textContent).toContain("req_42");
  });
});
