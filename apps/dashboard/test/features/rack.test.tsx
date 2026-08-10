import { expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { Rack } from "../../src/components/Rack.tsx";
import { renderWithRouter } from "../helpers/render.tsx";

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
