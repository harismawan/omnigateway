import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import stylesheet from "../src/index.css" with { type: "text" };
import { cn } from "../src/lib/utils.ts";

test("cn merges conditional classes and lets the later utility win", () => {
  expect(cn("p-2", false && "hidden", "p-4")).toBe("p-4");
});

test("the dashboard stylesheet defines shadcn semantic tokens", () => {
  expect(stylesheet).toContain("--background:");
  expect(stylesheet).toContain("--primary:");
  expect(stylesheet).toContain("--surface-subtle:");
  expect(stylesheet).toContain("--info:");
  expect(stylesheet).toContain("color-scheme: dark;");
  expect(stylesheet).toContain("prefers-reduced-motion: reduce");
  expect(stylesheet).toContain("--color-background: var(--background);");
  expect(stylesheet).toContain("--color-ring: var(--ring);");
});

test("the dom environment renders a react component", () => {
  render(<p>OmniGateway</p>);
  expect(screen.getByText("OmniGateway")).toBeDefined();
});
