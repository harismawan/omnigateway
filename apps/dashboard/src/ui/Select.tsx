import { Check, ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import styled from "styled-components";
import { Input } from "./Field.tsx";
import { usePopoverLayer } from "./layer.ts";

/**
 * One entry in a picker. `label` is what the operator reads and what the filter
 * matches; `detail` is a dim second column for when the value and its name are
 * both worth seeing, such as a model id beside its display name.
 */
export type SelectOption = {
  value: string;
  label: string;
  detail?: string | undefined;
};

/**
 * Case-insensitive substring match over everything the row shows, so typing a
 * fragment of an id finds a row labelled by its display name and vice versa.
 */
export function matchOptions(
  options: readonly SelectOption[],
  query: string,
): readonly SelectOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return options;
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().includes(needle) ||
      (option.detail?.toLowerCase().includes(needle) ?? false),
  );
}

/**
 * From this many options up the list opens with a filter box. Below it a box is
 * noise — two protocols or four log levels are read at a glance — and the open
 * list takes type-ahead instead, as the native control did.
 */
const SEARCH_FROM = 8;

const Trigger = styled(Popover.Trigger)`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border-radius: ${({ theme }) => theme.radius.control};
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  color: ${({ theme }) => theme.color.ink};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease;

  &:hover:not(:disabled),
  &[data-state="open"] {
    border-color: ${({ theme }) => theme.color.accent};
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }

  svg {
    width: 13px;
    height: 13px;
    margin-left: auto;
    color: ${({ theme }) => theme.color.inkDim};
    transition: transform 120ms ease;
  }

  &[data-state="open"] svg {
    transform: rotate(180deg);
  }
`;

const Shown = styled.span<{ $placeholder: boolean }>`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: ${({ theme, $placeholder }) => ($placeholder ? theme.color.inkFaint : "inherit")};
`;

const Sheet = styled(Popover.Content)`
  z-index: ${({ theme }) => theme.z.dialog};
  display: flex;
  flex-direction: column;
  min-width: var(--radix-popover-trigger-width);
  max-width: min(480px, calc(100vw - 16px));
  max-height: min(320px, var(--radix-popover-content-available-height));
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.ruleStrong};
  border-radius: ${({ theme }) => theme.radius.panel};
  box-shadow: 0 12px 40px oklch(0 0 0 / 0.35);
  overflow: hidden;
`;

const Filter = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: 0 8px;
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};
  background: ${({ theme }) => theme.color.panelSunk};

  svg {
    width: 12px;
    height: 12px;
    flex: none;
    color: ${({ theme }) => theme.color.inkFaint};
  }

  input {
    flex: 1;
    min-width: 0;
    height: 30px;
    border: 0;
    outline: none;
    background: transparent;
    color: ${({ theme }) => theme.color.ink};
    font-family: ${({ theme }) => theme.font.mono};
    font-size: 12px;

    &::placeholder {
      color: ${({ theme }) => theme.color.inkFaint};
      font-family: ${({ theme }) => theme.font.sans};
    }
  }
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: ${({ theme }) => theme.space(1)};
  overflow-y: auto;
  outline: none;
`;

const Item = styled.div`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  min-height: 26px;
  padding: 4px 8px;
  border-radius: ${({ theme }) => theme.radius.chip};
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  color: ${({ theme }) => theme.color.ink};
  cursor: pointer;
  user-select: none;

  &[data-active="true"] {
    background: ${({ theme }) => theme.color.panelRaised};
  }

  &[aria-selected="true"] {
    color: ${({ theme }) => theme.color.accent};
  }

  > span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  svg {
    width: 12px;
    height: 12px;
    flex: none;
    margin-left: auto;
  }
`;

const Detail = styled.span`
  margin-left: auto;
  padding-left: ${({ theme }) => theme.space(3)};
  font-family: ${({ theme }) => theme.font.sans};
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkFaint};
  white-space: nowrap;
`;

const Nothing = styled.p`
  padding: 6px 8px;
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkFaint};
`;

/** Where the highlight lands after a navigation key, or `null` for any other key. */
function moved(key: string, at: number, count: number): number | null {
  const last = count - 1;
  switch (key) {
    case "ArrowDown":
      return Math.min(at + 1, last);
    case "ArrowUp":
      return Math.max(at - 1, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    case "PageDown":
      return Math.min(at + 8, last);
    case "PageUp":
      return Math.max(at - 8, 0);
    default:
      return null;
  }
}

const TABBABLE = "a[href], button, input, select, textarea, [tabindex]";

/**
 * The field Tab would reach from `from`, within `scope`, skipping `skip`.
 *
 * Needed because the open list is portalled: focus sits in the filter box or
 * the listbox at the end of the document, so the browser's own Tab would leave
 * for whatever follows the portal rather than for the field after the picker.
 * `wrap` is for a modal, whose focus trap cycles from its last field to its
 * first; the page does not, and past its last field there is nothing to reach.
 * Positive `tabindex` is not honoured; nothing in the console uses it.
 */
function tabbableBeside(
  from: HTMLElement,
  scope: ParentNode,
  skip: Element | null,
  backwards: boolean,
  wrap: boolean,
): HTMLElement | null {
  const order = [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element === from ||
      (element.tabIndex >= 0 &&
        !element.matches(":disabled, [type='hidden']") &&
        element.closest("[hidden], [inert]") === null &&
        !(skip?.contains(element) ?? false) &&
        (element.checkVisibility?.() ?? true)),
  );
  const at = order.indexOf(from);
  if (at < 0) return null;
  const next = backwards ? at - 1 : at + 1;
  if (!wrap) return order[next] ?? null;
  const cycled = order[(next + order.length) % order.length];
  return cycled === from ? null : (cycled ?? null);
}

/** Keeps the highlighted row on screen while the keyboard walks the list. */
function useRevealActive(list: HTMLElement | null, active: number, open: boolean): void {
  useEffect(() => {
    if (!open || list === null) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [list, active, open]);
}

function Rows({
  id,
  options,
  active,
  selected,
  onHover,
  onPick,
  empty,
}: {
  id: string;
  options: readonly SelectOption[];
  active: number;
  selected: string | undefined;
  onHover: (index: number) => void;
  onPick: (option: SelectOption) => void;
  empty: ReactNode;
}) {
  if (options.length === 0) return <Nothing>{empty}</Nothing>;
  return options.map((option, index) => (
    <Item
      key={option.value}
      id={`${id}-${index}`}
      role="option"
      data-value={option.value}
      data-index={index}
      data-active={index === active}
      aria-selected={option.value === selected}
      onPointerMove={() => onHover(index)}
      // Keeps focus where it is, so an autocomplete field does not blur and
      // close before the click that chose a row lands.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onPick(option)}
    >
      <span>{option.label}</span>
      {option.detail === undefined ? null : <Detail>{option.detail}</Detail>}
      {option.value === selected ? <Check aria-hidden /> : null}
    </Item>
  ));
}

export type SelectProps = {
  value: string | number;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  id?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  /** Shown when the value names no option and is empty. */
  placeholder?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
};

/**
 * A pick-one control drawn in the console's own materials.
 *
 * It replaced a native `<select>`, whose open list is painted by the platform
 * and ignores the theme — a white sheet over a graphite rack. What the native
 * control gave for free is kept: arrow keys, Home/End, Enter, Escape, and
 * type-ahead. Long lists, the ones where type-ahead stops being enough, open on
 * a filter box instead.
 *
 * The trigger is a `<button>` carrying `value`, so a `<label htmlFor>` still
 * names it and `.value` still reads what is chosen. A value that names no
 * option is shown raw rather than as the first row: call sites that can hold a
 * stale value add an explicit row for it, and this is the backstop.
 */
export function Select({
  value,
  options,
  onValueChange,
  id,
  className,
  disabled,
  placeholder,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: SelectProps) {
  const listId = useId();
  const ownId = useId();
  const triggerId = id ?? ownId;
  const layer = usePopoverLayer();
  const current = String(value);
  const chosen = options.find((option) => option.value === current);
  const searchable = options.length >= SEARCH_FROM;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  // Set when Tab has already put focus where it belongs, so closing the list
  // does not drag it back to the trigger.
  const tabbedAway = useRef(false);

  const shown = searchable ? matchOptions(options, query) : options;
  // Clamped on read rather than reset on change: the options are query data
  // and can shrink while the list is open, and a highlight past the end would
  // name a row that does not exist and leave Enter choosing nothing.
  const at = Math.min(active, shown.length - 1);
  useRevealActive(list, at, open);

  // The filter box comes and goes with the option count, which is query data,
  // and only one of it and the listbox answers the keyboard at a time. Focus
  // left on the other — <body> after the box unmounts, or the listbox after it
  // mounts — reaches nothing, so it is handed to whichever element now listens.
  useEffect(() => {
    if (!open) return;
    const owner = searchable ? search.current : list;
    if (owner !== null && document.activeElement !== owner) owner.focus();
  }, [open, searchable, list]);

  const indexOf = (target: string): number =>
    Math.max(
      options.findIndex((option) => option.value === target),
      0,
    );

  const openWith = (seed: string): void => {
    setQuery(seed);
    setActive(seed === "" ? indexOf(current) : 0);
    setOpen(true);
  };

  const pick = (option: SelectOption): void => {
    setOpen(false);
    if (option.value !== current) onValueChange(option.value);
  };

  /**
   * Native type-ahead, from the row at `base`. Letters typed in quick
   * succession spell a prefix and stay on the row it matches; one letter
   * repeated cycles through every row starting with it, as a native select
   * does, rather than searching for a row that starts "aa".
   */
  const typeAhead = (key: string, base: number): number | null => {
    const now = Date.now();
    const fresh = now - typed.current.at >= 600;
    const text = fresh ? key : typed.current.text + key;
    typed.current = { text, at: now };
    const lower = text.toLowerCase();
    const repeated = [...lower].every((letter) => letter === lower[0]);
    const needle = repeated ? lower[0] : lower;
    if (needle === undefined) return null;
    const from = repeated ? base + 1 : base;
    const starts = (option: SelectOption) => option.label.toLowerCase().startsWith(needle);
    const after = options.findIndex((option, index) => index >= from && starts(option));
    const found = after >= 0 ? after : options.findIndex(starts);
    return found >= 0 ? found : null;
  };

  /** Closes the list and moves on to the field Tab would have reached. */
  const tabAway = (backwards: boolean): void => {
    const from = trigger.current;
    const next =
      from === null
        ? null
        : tabbableBeside(from, layer ?? document, sheet.current, backwards, layer !== null);
    setOpen(false);
    if (next === null) return;
    tabbedAway.current = true;
    next.focus();
  };

  const onListKey = (event: KeyboardEvent): void => {
    const next = moved(event.key, at, shown.length);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !searchable)) {
      event.preventDefault();
      const option = shown[at];
      if (option !== undefined) pick(option);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      tabAway(event.shiftKey);
      return;
    }
    if (!searchable && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      const found = typeAhead(event.key, at);
      if (found !== null) setActive(found);
    }
  };

  const onTriggerKey = (event: KeyboardEvent): void => {
    if (open) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openWith("");
      return;
    }
    if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (searchable) {
        openWith(event.key);
        return;
      }
      openWith("");
      const found = typeAhead(event.key, indexOf(current));
      if (found !== null) setActive(found);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) openWith("");
        else setOpen(false);
      }}
    >
      <Trigger
        ref={trigger}
        type="button"
        role="combobox"
        id={triggerId}
        value={current}
        className={className}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onKeyDown={onTriggerKey}
      >
        <Shown $placeholder={chosen === undefined && current === ""}>
          {chosen?.label ?? (current === "" ? (placeholder ?? "") : current)}
        </Shown>
        <ChevronDown aria-hidden />
      </Trigger>
      <Popover.Portal container={layer ?? undefined}>
        <Sheet
          // Radix calls the sheet a dialog; it is only the frame around a
          // listbox, which carries the semantics itself.
          ref={sheet}
          role="presentation"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (searchable ? search.current : list)?.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (!tabbedAway.current) return;
            tabbedAway.current = false;
            event.preventDefault();
          }}
        >
          {searchable ? (
            <Filter>
              <Search aria-hidden />
              <input
                ref={search}
                type="text"
                value={query}
                placeholder="Filter…"
                role="combobox"
                aria-label="Filter options"
                aria-expanded
                aria-autocomplete="list"
                aria-controls={listId}
                aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
              />
            </Filter>
          ) : null}
          <List
            ref={setList}
            id={listId}
            role="listbox"
            tabIndex={searchable ? undefined : -1}
            aria-labelledby={triggerId}
            aria-activedescendant={!searchable && at >= 0 ? `${listId}-${at}` : undefined}
            onKeyDown={searchable ? undefined : onListKey}
          >
            <Rows
              id={listId}
              options={shown}
              active={at}
              selected={current}
              onHover={setActive}
              onPick={pick}
              empty={options.length === 0 ? "Nothing to choose from." : "No match."}
            />
          </List>
        </Sheet>
      </Popover.Portal>
    </Popover.Root>
  );
}

export type AutocompleteProps = {
  value: string;
  onValueChange: (value: string) => void;
  suggestions: readonly SelectOption[];
  id?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  "aria-label"?: string | undefined;
  "aria-describedby"?: string | undefined;
};

/**
 * A free-text field that offers known values as you type.
 *
 * It replaced `<input list>` + `<datalist>`, whose suggestion sheet is as
 * unthemeable as a native select's. Free text stays the point: a model can be
 * named before it is configured, so a suggestion is an offer and never a
 * constraint.
 *
 * Clicking or arrowing into the field lists everything; typing narrows it. The
 * full list on first open is deliberate — a field that already holds a model
 * would otherwise offer only that model, which is no help to someone who came
 * to change it.
 */
export function Autocomplete({
  value,
  onValueChange,
  suggestions,
  id,
  placeholder,
  disabled,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: AutocompleteProps) {
  const listId = useId();
  const ownId = useId();
  const fieldId = id ?? ownId;
  const layer = usePopoverLayer();
  const field = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [narrowed, setNarrowed] = useState(false);
  const [active, setActive] = useState(-1);
  const [list, setList] = useState<HTMLDivElement | null>(null);

  const shown = narrowed ? matchOptions(suggestions, value) : suggestions;
  const visible = open && !disabled && shown.length > 0;
  // Dropped rather than clamped when the suggestions shrink under it: here no
  // highlight means "keep what I typed", so losing one is the safe direction.
  const at = active < shown.length ? active : -1;
  useRevealActive(list, at, visible);

  const reveal = (): void => {
    setNarrowed(false);
    setActive(-1);
    setOpen(true);
  };

  const pick = (option: SelectOption): void => {
    setOpen(false);
    setNarrowed(false);
    if (option.value !== value) onValueChange(option.value);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (!visible) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        reveal();
      }
      return;
    }
    const next = moved(event.key, at, shown.length);
    if (next !== null && event.key !== "Home" && event.key !== "End") {
      event.preventDefault();
      setActive(next);
      return;
    }
    if (event.key === "Enter" && at >= 0) {
      event.preventDefault();
      const option = shown[at];
      if (option !== undefined) pick(option);
      return;
    }
    if (event.key === "Tab") setOpen(false);
  };

  return (
    <Popover.Root
      open={visible}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <Popover.Anchor asChild>
        <Input
          ref={field}
          id={fieldId}
          type="text"
          role="combobox"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-autocomplete="list"
          aria-expanded={visible}
          aria-controls={visible ? listId : undefined}
          aria-activedescendant={visible && at >= 0 ? `${listId}-${at}` : undefined}
          onClick={() => {
            if (!open) reveal();
          }}
          onChange={(event) => {
            onValueChange(event.target.value);
            setNarrowed(true);
            setActive(-1);
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
      </Popover.Anchor>
      <Popover.Portal container={layer ?? undefined}>
        <Sheet
          // Radix calls the sheet a dialog; it is only the frame around a
          // listbox, which carries the semantics itself.
          role="presentation"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // The field is outside the sheet, but a click in it is not a
            // dismissal: it is the operator placing the caret.
            if (event.target === field.current) event.preventDefault();
          }}
        >
          <List ref={setList} id={listId} role="listbox" aria-labelledby={fieldId}>
            <Rows
              id={listId}
              options={shown}
              active={at}
              selected={value}
              onHover={setActive}
              onPick={pick}
              empty={null}
            />
          </List>
        </Sheet>
      </Popover.Portal>
    </Popover.Root>
  );
}
