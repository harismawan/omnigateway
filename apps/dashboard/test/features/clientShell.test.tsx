import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientShell } from "../../src/components/ClientShell.tsx";
import { ClientBoard } from "../../src/features/client/ClientBoard.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { apiKey, log, usageBucket } from "../helpers/fixtures.ts";
import { renderWithProviders } from "../helpers/render.tsx";
import { createStubTimer, installSocketStub, restoreSocketStub } from "../helpers/socketStub.ts";

afterEach(() => {
  restoreSocketStub();
});

function boardStub(over: Record<string, () => unknown> = {}) {
  return createFetchStub({
    "GET /api/client/summary": () => apiKey(),
    "GET /api/client/usage": () => [usageBucket({ key: "fast" })],
    "GET /api/client/logs": () => ({ logs: [log()] }),
    "GET /api/client/quota": () => ({ headroom: [] }),
    ...over,
  });
}

describe("client shell", () => {
  test("signing out posts to the client route, not the operator's", async () => {
    const user = userEvent.setup();
    const stub = createFetchStub({ "POST /api/client/logout": () => ({ ok: true }) });
    const { client } = renderWithProviders(
      <ClientShell>
        <div>panel</div>
      </ClientShell>,
    );
    client.setQueryData(["client", "summary"], { id: "key-1" });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.url === "/api/client/logout")).toBe(true);
    });
    // A client session is not an admin session, and `/api/logout` would be a
    // 401 that leaves the cookie in place — signed out in the UI, still signed
    // in on the wire.
    expect(stub.calls.some((call) => call.url === "/api/logout")).toBe(false);
  });

  test("signing out empties the cache rather than merely navigating", async () => {
    const user = userEvent.setup();
    createFetchStub({ "POST /api/client/logout": () => ({ ok: true }) });

    // A client of its own, with garbage collection off.
    //
    // `makeQueryClient` sets `gcTime: 0`, so an entry nothing is observing is
    // collected the moment it is written — and this test passed against a
    // sign-out that cleared nothing at all, because the data was gone either
    // way. Found by mutation; the fixture was the whole assertion.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Number.POSITIVE_INFINITY } },
    });
    renderWithProviders(
      <ClientShell>
        <div>panel</div>
      </ClientShell>,
      { client },
    );
    client.setQueryData(["client", "summary"], { id: "key-1", label: "laptop" });
    client.setQueryData(["client", "logs", 50], [{ id: "req-1" }]);
    expect(client.getQueryCache().getAll().length).toBe(2);

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    // The next person at this browser starts clean. Leaving the cache would
    // render one key holder's label and spend to whoever signs in next.
    await waitFor(() => {
      expect(client.getQueryCache().getAll().length).toBe(0);
    });
    expect(client.getQueryData(["client", "summary"])).toBeUndefined();
  });

  test("the shell renders no navigation to the operator's console", async () => {
    createFetchStub({});
    const { container } = renderWithProviders(
      <ClientShell>
        <div>panel</div>
      </ClientShell>,
    );

    // A rail offering /keys or /accounts would be links a client session 401s
    // on — an invitation to a screen that cannot load.
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((href) => href !== null && href !== "/client")).toEqual([]);
    expect(container.textContent).not.toMatch(/accounts|models|database|settings/i);
  });
});

/**
 * The provider order the board's `cadence()` calls depend on.
 *
 * `StreamProvider` has to sit above `StreamedLiveProvider`: the LIVE switch
 * reads transport state, so the provider owning the transport must be outer.
 * Reversed, `useStreamConnection` finds nothing, falls through to its no-socket
 * default, and every panel polls forever with nothing thrown and nothing
 * logged. The console's nesting is pinned by `render.tsx`; the client route
 * writes its own copy, and a second copy is one that can be wrong on its own.
 */
describe("client route wiring", () => {
  /**
   * What a client's socket actually gets, which is not what it asks for.
   *
   * `StreamProvider` subscribes to the whole topic table regardless of
   * principal, so a client session asks for eight and the gateway acks the two
   * `authorised()` grants it and errors the rest. That is fail-safe rather than
   * accidental: an `error` frame drops the topic from `acked`, and the panel
   * falls back to polling — see `stream.tsx`, where `error` and `gap` are
   * handled distinctly for this reason.
   *
   * The refusals are simulated here rather than acked away with `ackAll()`,
   * because acking everything would test a gateway that does not exist and
   * would hide a board that cannot cope with being refused.
   */
  test("a client's two topics push, and the six it is refused fall back", async () => {
    const stub = boardStub();
    const socket = installSocketStub();
    const timer = createStubTimer();

    renderWithProviders(<ClientBoard />, { stream: { enabled: true, timer: timer.schedule } });
    await screen.findByText("laptop");

    // Exactly the split `authorised()` applies on the server.
    const GRANTED = ["res:usage", "res:logs"];
    act(() => {
      socket.last().open();
      for (const frame of socket.last().frames()) {
        if (frame.type !== "subscribe" || frame.topic === undefined) continue;
        socket
          .last()
          .emit(
            GRANTED.includes(frame.topic)
              ? { type: "ack", topic: frame.topic }
              : { type: "error", topic: frame.topic, message: "not permitted" },
          );
      }
    });

    // The board renders through the refusals rather than showing an error.
    expect(screen.getByText("laptop")).toBeTruthy();
    expect(screen.getByText("Your limits")).toBeTruthy();

    // And a frame on a granted topic still reaches the cache, so the two that
    // were acked are genuinely wired through.
    const before = stub.calls.length;
    act(() => {
      socket.last().emit({ type: "event", topic: "res:logs", payload: { keys: ["logs"] } });
    });
    await waitFor(() => {
      expect(stub.calls.length).toBeGreaterThan(before);
    });
  });

  test("the board still loads with no socket at all", async () => {
    // The ordinary case, and the one a provider-order regression breaks
    // silently: no transport means `cadence` returns its interval and the
    // panels poll. Rendering at all is the assertion.
    boardStub();
    renderWithProviders(<ClientBoard />);

    expect(await screen.findByText("laptop")).toBeTruthy();
    expect(await screen.findByText("Your limits")).toBeTruthy();
  });
});
