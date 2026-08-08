import { PROVIDER_MODEL_CATALOG, type ProviderId, type ProviderModelChoice } from "@omni/ir";
import { type KeyboardEvent, useId, useState } from "react";
import { Input } from "@/components/ui/input.tsx";

function matches(choice: ProviderModelChoice, normalizedQuery: string): boolean {
  return (
    choice.id.toLowerCase().includes(normalizedQuery) ||
    choice.label.toLowerCase().includes(normalizedQuery)
  );
}

type Props = {
  provider: ProviderId;
  value: string;
  targetNumber: number;
  onChange: (model: string) => void;
};

export function ProviderModelInput({ provider, value, targetNumber, onChange }: Props) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const catalogChoices = PROVIDER_MODEL_CATALOG[provider].models;
  const normalizedQuery = query.trim().toLowerCase();
  const choices = open
    ? catalogChoices.filter((choice) => matches(choice, normalizedQuery))
    : catalogChoices;
  const hasPopup = open && choices.length > 0;
  const activeChoice = hasPopup && activeIndex >= 0 ? choices[activeIndex] : undefined;
  const optionName = (choice: ProviderModelChoice) =>
    choice.label === choice.id ? choice.label : `${choice.label} (${choice.id})`;
  const closeChoices = () => {
    setOpen(false);
    setActiveIndex(-1);
  };
  const openChoices = () => {
    setQuery("");
    setOpen(true);
    setActiveIndex(-1);
  };
  const select = (choice: ProviderModelChoice) => {
    onChange(choice.id);
    setQuery("");
    closeChoices();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      closeChoices();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const keyboardChoices = open ? choices : catalogChoices;
      if (!open) setQuery("");
      setOpen(true);
      if (keyboardChoices.length === 0) return;
      setActiveIndex((current) => {
        if (event.key === "ArrowDown") {
          return current >= keyboardChoices.length - 1 ? 0 : current + 1;
        }
        return current <= 0 ? keyboardChoices.length - 1 : current - 1;
      });
      return;
    }
    if (event.key === "Enter" && open && activeChoice !== undefined) {
      event.preventDefault();
      select(activeChoice);
    }
  };

  return (
    <div className="relative">
      <Input
        aria-activedescendant={
          activeChoice === undefined ? undefined : `${listboxId}-option-${activeIndex}`
        }
        aria-autocomplete="list"
        aria-controls={hasPopup ? listboxId : undefined}
        aria-expanded={hasPopup}
        aria-label={`Target ${targetNumber} model`}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) closeChoices();
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue);
          setQuery(nextValue);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onClick={openChoices}
        onFocus={openChoices}
        onKeyDown={onKeyDown}
        role="combobox"
        value={value}
      />
      {hasPopup && (
        <div
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md"
          id={listboxId}
          role="listbox"
        >
          {choices.map((choice, index) => (
            <button
              aria-label={optionName(choice)}
              aria-selected={index === activeIndex}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent aria-selected:bg-accent"
              id={`${listboxId}-option-${index}`}
              key={choice.id}
              onClick={() => select(choice)}
              onMouseDown={(event) => event.preventDefault()}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <span>{choice.label}</span>
              {choice.label !== choice.id && (
                <span className="ml-2 text-muted-foreground">{choice.id}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
