import { describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatabaseBoard } from "../../src/features/database/DatabaseBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { databaseOverview, snapshot } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";

/**
 * Records where the console tries to send the browser.
 *
 * A full navigation rather than a router hop is the behaviour under test, so it
 * is captured at the one place that performs one instead of being mocked away.
 */
function captureNavigation(): { to: string[]; restore: () => void } {
  const to: string[] = [];
  Object.defineProperty(window.location, "assign", {
    configurable: true,
    value: (url: string) => {
      to.push(url);
    },
  });
  return {
    to,
    restore: () => {
      Reflect.deleteProperty(window.location, "assign");
    },
  };
}

function stubDatabase(overrides: Parameters<typeof createFetchStub>[0] = {}) {
  return createFetchStub({
    "GET /api/database": () => databaseOverview(),
    "GET /api/database/snapshots": () => ({ snapshots: [snapshot()] }),
    ...overrides,
  });
}

describe("DatabaseBoard", () => {
  test("reads the file on disk and the share of it a vacuum would give back", async () => {
    stubDatabase();
    renderWithProviders(<DatabaseBoard />);

    expect(await screen.findByText("12.0 MiB")).toBeTruthy();
    expect(screen.getByText("Database file")).toBeTruthy();
    expect(screen.getByRole("meter", { name: /25% of the file is reclaimable/i })).toBeTruthy();
    expect(screen.getByText("request_logs")).toBeTruthy();
    expect(screen.queryByText("Dead rows")).toBeNull();
  });

  test("a Postgres store shows the server and hides every file operation", async () => {
    stubDatabase({
      "GET /api/database": () =>
        databaseOverview({
          engine: "postgres",
          location: "postgres://omni:***@db.internal:5432/omni",
          stats: { pageSize: 8192, pageCount: 1536, freelistCount: 0, schemaVersion: 14 },
          logicalBytes: 12_582_912,
          bodiesBytes: 5_242_880,
          tables: [{ name: "request_bodies", bytes: 5_242_880, rows: 1_200, deadRows: 37 }],
        }),
    });
    renderWithProviders(<DatabaseBoard />);

    // Host and port alone: the full URL overflows the readout and its masked
    // password is not information.
    expect(await screen.findByText("db.internal:5432")).toBeTruthy();
    expect(screen.getByText("database omni")).toBeTruthy();
    expect(screen.queryByText(/omni:\*\*\*@/)).toBeNull();
    expect(screen.getByText("1536 blocks of 8.0 KiB")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take a snapshot" })).toBeNull();
    expect(screen.queryByText("Reclaimable")).toBeNull();
    expect(screen.queryByText(/pg_dump/)).toBeTruthy();
    // The table list reads from the server: per-table size, estimated rows,
    // and the dead-tuple column SQLite has no number for.
    expect(screen.getByText("request_bodies")).toBeTruthy();
    expect(screen.getAllByText("5.0 MiB")).toHaveLength(2);
    expect(screen.getByText("Captured bodies")).toBeTruthy();
    expect(screen.getByText("Dead rows")).toBeTruthy();
    expect(screen.getByText("37")).toBeTruthy();
  });

  test("a failed read offers a retry", async () => {
    stubDatabase({
      "GET /api/database": () => ({
        status: 500,
        body: { error: { code: "INTERNAL", message: "internal error" } },
      }),
    });
    renderWithProviders(<DatabaseBoard />);

    expect(await screen.findByText("internal error")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  test("an installation with no snapshots is invited to take the first", async () => {
    stubDatabase({ "GET /api/database/snapshots": () => ({ snapshots: [] }) });
    renderWithProviders(<DatabaseBoard />);

    expect(await screen.findByText("No snapshots")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take the first snapshot" })).toBeTruthy();
  });

  test("lists each snapshot with its size and why it was taken", async () => {
    stubDatabase();
    renderWithProviders(<DatabaseBoard />);

    const row = (await screen.findByText("db_2027-01-15T09-00-00-000Z_manual.sqlite")).closest(
      "tr",
    );
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("10.0 MiB");
    expect(row?.textContent).toContain("manual");
  });

  /**
   * A snapshot carries encrypted credentials and API-key hashes, and it is as
   * large as the database. Handing the URL to the browser keeps both facts out
   * of this process: nothing is buffered in JS memory, and the cookie the
   * gateway already requires does the authenticating.
   */
  test("a snapshot is downloaded by link, never read into the console", async () => {
    const stub = stubDatabase();
    renderWithProviders(<DatabaseBoard />);

    const link = await screen.findByRole("link", { name: "Download" });
    expect(link.getAttribute("href")).toBe(
      "/api/database/snapshots/db_2027-01-15T09-00-00-000Z_manual.sqlite/download",
    );
    expect(link.hasAttribute("download")).toBe(true);
    expect(stub.calls.some((call) => call.url.includes("/download"))).toBe(false);
  });

  test("taking a snapshot posts and shows the new file without a page reload", async () => {
    const user = userEvent.setup();
    let taken = false;
    const stub = stubDatabase({
      "POST /api/database/snapshots": () => {
        taken = true;
        return snapshot({ id: "db_2027-01-15T10-00-00-000Z_manual.sqlite" });
      },
      "GET /api/database/snapshots": () => ({
        snapshots: taken
          ? [snapshot({ id: "db_2027-01-15T10-00-00-000Z_manual.sqlite" }), snapshot()]
          : [snapshot()],
      }),
    });
    renderWithProviders(<DatabaseBoard />);

    await user.click(await screen.findByRole("button", { name: "Take a snapshot" }));

    expect(await screen.findByText("db_2027-01-15T10-00-00-000Z_manual.sqlite")).toBeTruthy();
    expect(
      stub.calls.filter(
        (call) => call.url === "/api/database/snapshots" && call.init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  const RESTORE_ROUTE =
    "POST /api/database/snapshots/db_2027-01-15T09-00-00-000Z_manual.sqlite/restore";

  function restored(patch: { adminPasswordChanged?: boolean } = {}) {
    return {
      ok: true,
      counts: { request_logs: 1_204, credentials: 3 },
      preRestoreSnapshot: snapshot({ id: "db_2027-01-15T11-00-00-000Z_preRestore.sqlite" }),
      adminPasswordChanged: patch.adminPasswordChanged ?? false,
    };
  }

  /**
   * Restore replaces the file every other screen reads from, and the only undo
   * is a snapshot the gateway takes on the way past. Nothing may reach the
   * route on the strength of one click.
   */
  test("restoring asks first, and sends nothing until the operator confirms", async () => {
    const user = userEvent.setup();
    const stub = stubDatabase({ [RESTORE_ROUTE]: () => restored() });
    renderWithProviders(<DatabaseBoard />);

    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(stub.calls.some((call) => call.url.includes("/restore"))).toBe(false);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Restore database" }));

    await waitFor(() => {
      expect(
        stub.calls.some((call) => call.url.includes("/restore") && call.init?.method === "POST"),
      ).toBe(true);
    });
    // Every screen in the console reads the file that was just replaced, so the
    // ordinary ending is a re-read rather than a redirect.
    await waitFor(() => {
      expect(stub.calls.filter((call) => call.url === "/api/database").length).toBeGreaterThan(1);
    });
  });

  /**
   * The restored file brought its own admin password with it, so the gateway
   * ended every session before it answered. The cookie in this browser is
   * already dead: the only correct next move is the login screen, and a refetch
   * would collect a 401 on the way there.
   */
  test("a restore that changes the admin password signs the operator out", async () => {
    const user = userEvent.setup();
    const navigation = captureNavigation();
    const stub = stubDatabase({
      [RESTORE_ROUTE]: () => restored({ adminPasswordChanged: true }),
    });
    renderWithProviders(<DatabaseBoard />);

    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await user.click(await screen.findByRole("button", { name: "Restore database" }));

    await waitFor(() => {
      expect(navigation.to).toEqual(["/login?reason=admin-password-changed"]);
    });
    expect(stub.calls.filter((call) => call.url === "/api/database")).toHaveLength(1);
    navigation.restore();
  });

  test("retention loads from the overview and saves as numbers", async () => {
    const user = userEvent.setup();
    const stub = stubDatabase({
      "PUT /api/database/retention": () => ({ keepLatest: 8, maxAgeDays: 30 }),
    });
    renderWithProviders(<DatabaseBoard />);

    await waitFor(() => {
      expect((screen.getByLabelText("Snapshots kept") as HTMLInputElement).value).toBe("5");
    });
    expect((screen.getByLabelText("Maximum age") as HTMLInputElement).value).toBe("30");

    const keep = screen.getByLabelText("Snapshots kept");
    await user.clear(keep);
    await user.type(keep, "8");
    await user.click(screen.getByRole("button", { name: "Save retention" }));

    await waitFor(() => {
      const put = stub.calls.find((call) => call.init?.method === "PUT");
      expect(put?.url).toBe("/api/database/retention");
      expect(JSON.parse(String(put?.init?.body))).toEqual({ keepLatest: 8, maxAgeDays: 30 });
    });
  });

  test("a retention bound below its floor is named and never sent", async () => {
    const user = userEvent.setup();
    const stub = stubDatabase();
    renderWithProviders(<DatabaseBoard />);

    await waitFor(() => {
      expect((screen.getByLabelText("Snapshots kept") as HTMLInputElement).value).toBe("5");
    });

    const keep = screen.getByLabelText("Snapshots kept");
    await user.clear(keep);
    await user.type(keep, "0");
    await user.click(screen.getByRole("button", { name: "Save retention" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Snapshots kept must be a whole number of 1 or more.",
    );
    expect(stub.calls.some((call) => call.init?.method === "PUT")).toBe(false);
  });

  test("compacting asks first and then says what it gave back", async () => {
    const user = userEvent.setup();
    const stub = stubDatabase({
      "POST /api/database/vacuum": () => ({ ok: true, reclaimedBytes: 3_145_728, durationMs: 820 }),
    });
    renderWithProviders(<DatabaseBoard />);

    await user.click(await screen.findByRole("button", { name: "Compact" }));
    expect(stub.calls.some((call) => call.url.includes("vacuum"))).toBe(false);

    await user.click(await screen.findByRole("button", { name: "Compact database" }));

    expect((await screen.findByRole("status")).textContent).toContain("3.0 MiB");
  });

  /**
   * A database the operator brought with them. The bytes go up as bytes: the
   * file is as large as a database, and base64 in a JSON envelope would be a
   * third larger again and would have to be held in memory to build.
   */
  test("importing a database asks first and sends the file itself", async () => {
    const user = userEvent.setup();
    const stub = stubDatabase({ "POST /api/database/import": () => restored() });
    renderWithProviders(<DatabaseBoard />);

    const picker = await screen.findByLabelText("Database file to import");
    await user.upload(picker, new File([new Uint8Array([1, 2, 3])], "backup.sqlite"));

    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(stub.calls.some((call) => call.url === "/api/database/import")).toBe(false);

    await user.click(await screen.findByRole("button", { name: "Replace database" }));

    await waitFor(() => {
      const sent = stub.calls.find((call) => call.url === "/api/database/import");
      expect(sent?.init?.method).toBe("POST");
      expect(sent?.init?.body).toBeInstanceOf(Blob);
    });
  });

  test("deleting a snapshot asks first, then removes it", async () => {
    const user = userEvent.setup();
    const stub = stubDatabase({
      "DELETE /api/database/snapshots/db_2027-01-15T09-00-00-000Z_manual.sqlite": () => ({
        ok: true,
      }),
    });
    renderWithProviders(<DatabaseBoard />);

    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(stub.calls.some((call) => call.init?.method === "DELETE")).toBe(false);

    await user.click(await screen.findByRole("button", { name: "Delete snapshot" }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (call) =>
            call.init?.method === "DELETE" &&
            call.url === "/api/database/snapshots/db_2027-01-15T09-00-00-000Z_manual.sqlite",
        ),
      ).toBe(true);
    });
  });
});
