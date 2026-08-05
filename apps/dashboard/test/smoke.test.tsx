import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { cn } from "../src/lib/utils.ts";

test("cn merges conditional classes and lets the later utility win", () => {
  expect(cn("p-2", false && "hidden", "p-4")).toBe("p-4");
});

test("the dom environment renders a react component", () => {
  render(<p>OmniGateway</p>);
  expect(screen.getByText("OmniGateway")).toBeDefined();
});
