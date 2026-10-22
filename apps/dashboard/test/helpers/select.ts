import { waitFor } from "@testing-library/react";

/** The part of `userEvent` these helpers drive: the bound instance or the static API. */
type Clicker = {
  click: (element: Element) => Promise<unknown>;
  keyboard: (text: string) => Promise<unknown>;
};

/** The open listbox a picker's trigger controls. */
async function listOf(trigger: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const id = trigger.getAttribute("aria-controls");
    const list = id === null ? null : document.getElementById(id);
    if (list === null) throw new Error("the picker's list did not open");
    return list;
  });
}

function optionsIn(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>('[role="option"]')];
}

/**
 * Opens a `Select` and clicks the row whose value — or, failing that, whose
 * visible label — is `wanted`. The same matching `user.selectOptions` did for
 * the native control this replaced, so a test reads the same either way.
 */
export async function choose(user: Clicker, trigger: HTMLElement, wanted: string): Promise<void> {
  await user.click(trigger);
  const list = await listOf(trigger);
  // Waited for, not looked up once: the list stays mounted while open, so a
  // row whose query lands after the click appears in it — which is what the
  // tests that used to wait on a native `<option>` were waiting for.
  const row = await waitFor(() => {
    const rows = optionsIn(list);
    const found =
      rows.find((option) => option.dataset.value === wanted) ??
      rows.find((option) => option.firstElementChild?.textContent === wanted);
    if (found === undefined) {
      const offered = rows.map((option) => option.dataset.value).join(", ");
      throw new Error(`no option "${wanted}" in the picker; it offers: ${offered}`);
    }
    return found;
  });
  await user.click(row);
}

/**
 * Waits until a `Select` offers a row labelled `label`, then closes it again —
 * for a test that has to know a query has landed before it goes on.
 */
export async function waitForOption(
  user: Clicker,
  trigger: HTMLElement,
  label: string,
): Promise<void> {
  await user.click(trigger);
  const list = await listOf(trigger);
  await waitFor(() => {
    const labels = optionsIn(list).map((option) => option.firstElementChild?.textContent);
    if (!labels.includes(label))
      throw new Error(`no "${label}" yet; offered: ${labels.join(", ")}`);
  });
  await user.keyboard("{Escape}");
}

/** The labels a `Select` offers, read by opening it and closed again after. */
export async function optionLabels(user: Clicker, trigger: HTMLElement): Promise<string[]> {
  await user.click(trigger);
  const labels = optionsIn(await listOf(trigger)).map(
    (option) => option.firstElementChild?.textContent ?? "",
  );
  await user.keyboard("{Escape}");
  return labels;
}

/**
 * The values an `Autocomplete` offers when opened on its current text, in
 * order. Escapes afterwards, so the field is left as found.
 */
export async function suggestionsOf(user: Clicker, field: HTMLElement): Promise<string[]> {
  await user.click(field);
  const id = field.getAttribute("aria-controls");
  const list = id === null ? null : document.getElementById(id);
  const values = list === null ? [] : optionsIn(list).map((option) => option.dataset.value ?? "");
  await user.keyboard("{Escape}");
  return values;
}

/** What the closed trigger shows as chosen. */
export function shownLabel(trigger: HTMLElement): string {
  return trigger.firstElementChild?.textContent ?? "";
}
