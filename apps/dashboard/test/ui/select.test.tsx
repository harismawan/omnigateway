import { describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Modal } from "../../src/ui/Modal.tsx";
import { Autocomplete, matchOptions, Select, type SelectOption } from "../../src/ui/Select.tsx";
import { renderWithProviders } from "../helpers/render.tsx";
import { shownLabel } from "../helpers/select.ts";

const FEW: SelectOption[] = [
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

const MANY: SelectOption[] = Array.from({ length: 12 }, (_, at) => ({
  value: `model-${at}`,
  label: at === 7 ? "claude-opus-5" : `model-${at}`,
  ...(at === 3 ? { detail: "Haiku Fast" } : {}),
}));

function Picker({ options, start }: { options: SelectOption[]; start: string }) {
  const [value, setValue] = useState(start);
  return <Select aria-label="Pick" value={value} options={options} onValueChange={setValue} />;
}

/** Set by `Shrinking` on mount: cuts its option list to three, as a refetch might. */
let shrink: (() => void) | undefined;

function Shrinking({ kind }: { kind: "select" | "autocomplete" }) {
  const [options, setOptions] = useState(MANY);
  shrink = () => setOptions(MANY.slice(0, 3));
  return kind === "select" ? (
    <Select aria-label="Pick" value="model-0" options={options} onValueChange={() => {}} />
  ) : (
    <Autocomplete aria-label="Model" value="" suggestions={options} onValueChange={() => {}} />
  );
}

/** Set by `Growing` on mount: swaps its four options for twelve. */
let grow: (() => void) | undefined;

function Growing() {
  const [options, setOptions] = useState(FEW);
  const [value, setValue] = useState("info");
  grow = () => setOptions(MANY);
  return <Select aria-label="Pick" value={value} options={options} onValueChange={setValue} />;
}

const trigger = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>("combobox");

describe("matchOptions", () => {
  test("matches label, value, and detail case-insensitively", () => {
    expect(matchOptions(MANY, "OPUS").map((o) => o.value)).toEqual(["model-7"]);
    expect(matchOptions(MANY, "model-1").map((o) => o.value)).toEqual([
      "model-1",
      "model-10",
      "model-11",
    ]);
    expect(matchOptions(MANY, "haiku").map((o) => o.value)).toEqual(["model-3"]);
    expect(matchOptions(MANY, "  ")).toBe(MANY);
  });
});

describe("Select", () => {
  test("shows the chosen label and carries the value", () => {
    renderWithProviders(<Picker options={FEW} start="warn" />);
    expect(trigger().value).toBe("warn");
    expect(shownLabel(trigger())).toBe("Warn");
  });

  test("a value naming no option is shown raw, never as the first row", () => {
    renderWithProviders(<Picker options={FEW} start="trace" />);
    expect(shownLabel(trigger())).toBe("trace");
  });

  test("clicking a row chooses it and closes the list", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={FEW} start="debug" />);
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "Error" }));
    expect(trigger().value).toBe("error");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("the keyboard walks and picks, starting from the chosen row", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={FEW} start="info" />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(trigger().value).toBe("warn");
  });

  test("Escape closes without changing anything", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={FEW} start="info" />);
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().value).toBe("info");
  });

  test("a short list takes type-ahead instead of a filter box", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={FEW} start="debug" />);
    await user.click(trigger());
    expect(screen.queryByRole("combobox", { name: "Filter options" })).toBeNull();
    await user.keyboard("w{Enter}");
    expect(trigger().value).toBe("warn");
  });

  test("a long list opens on a filter box that narrows it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={MANY} start="model-0" />);
    await user.click(trigger());
    const filter = screen.getByRole("combobox", { name: "Filter options" });
    await waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("opus");
    expect(screen.getAllByRole("option").map((row) => row.dataset.value)).toEqual(["model-7"]);
    await user.keyboard("{Enter}");
    expect(trigger().value).toBe("model-7");
  });

  test("typing on a closed long list opens it already filtered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={MANY} start="model-0" />);
    trigger().focus();
    await user.keyboard("c");
    expect(
      (screen.getByRole("combobox", { name: "Filter options" }) as HTMLInputElement).value,
    ).toBe("c");
    expect(screen.getAllByRole("option").map((row) => row.dataset.value)).toEqual(["model-7"]);
  });

  test("a filter matching nothing says so", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={MANY} start="model-0" />);
    await user.click(trigger());
    await user.keyboard("zzz");
    expect(screen.getByText("No match.")).toBeTruthy();
  });

  test("repeating one letter cycles through the rows that start with it", async () => {
    const user = userEvent.setup();
    const options = [
      { value: "a1", label: "alpha" },
      { value: "b", label: "bravo" },
      { value: "a2", label: "able" },
      { value: "a3", label: "atlas" },
    ];
    renderWithProviders(<Picker options={options} start="b" />);
    await user.click(trigger());
    await user.keyboard("aa");
    const list = screen.getByRole("listbox");
    const active = (): string | undefined =>
      document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.dataset.value;
    // From "bravo", the first "a" lands on "able" and the second moves on to
    // "atlas" — rather than searching for a row starting "aa", which is none.
    expect(active()).toBe("a3");
    await user.keyboard("a");
    expect(active()).toBe("a1");
  });

  test("a multi-letter run narrows to the row it spells", async () => {
    const user = userEvent.setup();
    const options = [
      { value: "1", label: "alpha" },
      { value: "2", label: "atlas" },
      { value: "3", label: "attic" },
    ];
    renderWithProviders(<Picker options={options} start="1" />);
    await user.click(trigger());
    await user.keyboard("att{Enter}");
    expect(trigger().value).toBe("3");
  });

  test("Tab leaves the open list for the next field, Shift+Tab for the one before", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <input aria-label="Before" />
        <Picker options={FEW} start="info" />
        <input aria-label="After" />
      </>,
    );
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{Tab}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("After")));
    // Tab moves on; it does not choose the highlighted row.
    expect(trigger().value).toBe("info");

    await user.click(trigger());
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Before")));
  });

  test("choosing or escaping hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Picker options={FEW} start="info" />);
    await user.click(trigger());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
    await user.click(trigger());
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  test("the highlight survives the list shrinking under it while open", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Shrinking kind="select" />);
    await user.click(trigger());
    await user.keyboard("{End}");
    act(() => shrink?.());
    // Three rows is below the filter box's threshold, so the listbox now
    // carries the highlight itself.
    const list = screen.getByRole("listbox");
    const pointed = document.getElementById(list.getAttribute("aria-activedescendant") ?? "");
    // It names a row that exists, so Enter still chooses something.
    expect(pointed?.dataset.value).toBe("model-2");
    // And the keyboard still reaches it, though the box that held focus is gone.
    await waitFor(() => expect(document.activeElement).toBe(list));
  });

  test("a list growing past the filter threshold while open hands the keyboard to the box", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Growing />);
    await user.click(trigger());
    expect(screen.queryByRole("combobox", { name: "Filter options" })).toBeNull();
    act(() => grow?.());
    const filter = await screen.findByRole("combobox", { name: "Filter options" });
    await waitFor(() => expect(document.activeElement).toBe(filter));
    await user.keyboard("opus{Enter}");
    expect(trigger().value).toBe("model-7");
  });

  test("in a modal, Tab from the last field wraps to the first, as the dialog's trap does", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Modal open onOpenChange={() => {}} title="Edit">
        <Picker options={FEW} start="info" />
      </Modal>,
    );
    await user.click(trigger());
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })),
    );

    await user.click(trigger());
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })),
    );
  });

  test("a disabled picker does not open", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Select aria-label="Pick" value="info" options={FEW} disabled onValueChange={() => {}} />,
    );
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("inside a modal the list mounts in the dialog, where scrolling is allowed", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Modal open onOpenChange={() => {}} title="Edit">
        <Picker options={FEW} start="info" />
      </Modal>,
    );
    await user.click(trigger());
    expect(screen.getByRole("dialog").contains(screen.getByRole("listbox"))).toBe(true);
  });
});

function Field({ start, suggestions }: { start: string; suggestions: SelectOption[] }) {
  const [value, setValue] = useState(start);
  return (
    <Autocomplete
      aria-label="Model"
      value={value}
      suggestions={suggestions}
      onValueChange={setValue}
    />
  );
}

const field = (): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>("combobox", { name: "Model" });

describe("Autocomplete", () => {
  test("clicking a filled field lists every suggestion, not just the match", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field start="model-2" suggestions={MANY} />);
    await user.click(field());
    expect(screen.getAllByRole("option")).toHaveLength(MANY.length);
  });

  test("typing narrows the suggestions and a click fills the field", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field start="" suggestions={MANY} />);
    await user.type(field(), "opus");
    expect(screen.getAllByRole("option").map((row) => row.dataset.value)).toEqual(["model-7"]);
    await user.click(screen.getByRole("option"));
    expect(field().value).toBe("model-7");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("arrows and Enter pick a suggestion", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field start="" suggestions={MANY} />);
    await user.type(field(), "model-1");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(field().value).toBe("model-10");
  });

  test("free text is kept: Enter with nothing highlighted chooses nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field start="" suggestions={MANY} />);
    await user.type(field(), "llama3:8b{Enter}");
    expect(field().value).toBe("llama3:8b");
  });

  test("text matching nothing hides the list rather than showing an empty one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field start="" suggestions={MANY} />);
    await user.type(field(), "zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  test("a highlight past the end of a shrunk list is dropped, not left dangling", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Shrinking kind="autocomplete" />);
    await user.click(field());
    await user.keyboard("{PageDown}{PageDown}");
    expect(field().getAttribute("aria-activedescendant")).not.toBeNull();
    act(() => shrink?.());
    const pointed = field().getAttribute("aria-activedescendant");
    expect(pointed === null || document.getElementById(pointed) !== null).toBe(true);
  });

  test("Escape closes the list and keeps what was typed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Field start="" suggestions={MANY} />);
    await user.type(field(), "model");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().value).toBe("model");
  });
});
