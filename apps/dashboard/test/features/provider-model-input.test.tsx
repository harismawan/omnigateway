import { expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ProviderModelInput } from "../../src/features/models/ProviderModelInput.tsx";

function renderInput(provider: "anthropic" | "openai" | "kimi" = "anthropic", initialValue = "") {
  const onChange = mock((model: string) => model);
  function ControlledInput() {
    const [value, setValue] = useState(initialValue);
    return (
      <ProviderModelInput
        onChange={(model) => {
          onChange(model);
          setValue(model);
        }}
        provider={provider}
        targetNumber={1}
        value={value}
      />
    );
  }
  render(<ControlledInput />);
  return { onChange, user: userEvent.setup() };
}

test("focus shows only current-provider curated choices", async () => {
  const { user } = renderInput("openai");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.click(input);

  expect(screen.getByRole("option", { name: "gpt-5.6" })).toBeDefined();
  expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeDefined();
  expect(screen.queryByRole("option", { name: "claude-opus-5" })).toBeNull();
  expect(screen.queryByRole("option", { name: /Kimi K3/ })).toBeNull();
});

test("typing filters IDs and labels case-insensitively while allowing custom text", async () => {
  const { onChange, user } = renderInput("kimi");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.type(input, "HIGH SPEED");

  expect(onChange).toHaveBeenCalled();
  expect(onChange.mock.calls.at(-1)?.[0]).toBe("HIGH SPEED");
  expect(
    screen.getByRole("option", {
      name: "Kimi K2.7 Code — High Speed (kimi-for-coding-highspeed)",
    }),
  ).toBeDefined();
  expect(screen.queryByRole("option", { name: /Kimi K3 — 256K/ })).toBeNull();
});

test("clicking a suggestion emits its exact upstream ID", async () => {
  const { onChange, user } = renderInput("kimi");
  await user.click(screen.getByRole("combobox", { name: "Target 1 model" }));
  await user.click(screen.getByRole("option", { name: "Kimi K3 — up to 1M (k3)" }));

  expect(onChange).toHaveBeenLastCalledWith("k3");
});

test("keyboard navigation selects the active suggestion and Escape closes the list", async () => {
  const { onChange, user } = renderInput("anthropic");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.click(input);
  await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("claude-opus-5");
  expect(input.getAttribute("aria-expanded")).toBe("false");

  await user.click(input);
  await user.keyboard("{Escape}");
  expect(input.getAttribute("aria-expanded")).toBe("false");
});

test("focus with a custom value shows all current-provider choices", async () => {
  const { user } = renderInput("anthropic", "vendor-private-model");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.click(input);

  expect(screen.getByRole("option", { name: "claude-fable-5" })).toBeDefined();
  expect(screen.getByRole("option", { name: "claude-opus-5" })).toBeDefined();
});

test("clicking a focused combobox after selection reopens all choices", async () => {
  const { user } = renderInput("anthropic");
  const input = screen.getByRole("combobox", { name: "Target 1 model" });

  await user.click(input);
  await user.click(screen.getByRole("option", { name: "claude-opus-5" }));
  await user.click(input);

  expect(screen.getByRole("option", { name: "claude-fable-5" })).toBeDefined();
  expect(screen.getByRole("option", { name: "claude-opus-5" })).toBeDefined();
});

test("existing custom values render unchanged", () => {
  renderInput("anthropic", "vendor-private-model");
  expect(screen.getByRole("combobox", { name: "Target 1 model" })).toHaveProperty(
    "value",
    "vendor-private-model",
  );
});
