import { beforeEach, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { Rack } from "../../src/components/Rack.tsx";
import { createFetchStub } from "../helpers/fetchStub.ts";
import { renderWithRouter } from "../helpers/render.tsx";

// The rail asks which plugins are installed. Stubbed to an empty answer so
// these assertions stay about the chassis, and so nothing here reaches a socket.
beforeEach(() => {
  createFetchStub({ "GET /api/plugins": () => ({ plugins: [] }) });
});

test("the rack owns viewport height and scrolls only its main content", async () => {
  renderWithRouter(
    <Rack>
      <div>page content</div>
    </Rack>,
  );

  const shell = await screen.findByTestId("rack-shell");
  const main = screen.getByRole("main");
  const navigation = screen.getByRole("navigation", { name: "Console sections" });

  expect(getComputedStyle(shell).height).toBe("768px");
  expect(getComputedStyle(shell).overflow).toBe("hidden");
  expect(getComputedStyle(main).overflowY).toBe("auto");
  expect(getComputedStyle(main).minHeight).toBe("0");
  expect(getComputedStyle(navigation).overflowY).toBe("auto");
});

test("the rail reaches the database screen", async () => {
  renderWithRouter(
    <Rack>
      <div>page content</div>
    </Rack>,
  );

  const link = await screen.findByRole("link", { name: "Database" });
  expect(link.getAttribute("href")).toBe("/database");
});
