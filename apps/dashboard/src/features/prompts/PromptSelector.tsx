import type { PromptLibraryEntry } from "../../api/types.ts";
import { Button } from "../../ui/Button.tsx";
import { Row, Stack } from "../../ui/primitives.ts";
import { Select } from "../../ui/Select.tsx";

export type PromptSelectorProps = {
  value: string[];
  onChange: (ids: string[]) => void;
  library: PromptLibraryEntry[];
  disabled?: boolean;
};

/** Ordered IDs only; inactive drafts remain assignable and visibly labelled. */
export function PromptSelector({
  value,
  onChange,
  library,
  disabled = false,
}: PromptSelectorProps) {
  const builtinSelected = value.some((id) => library.some((p) => p.id === id && p.builtin));
  const move = (index: number, offset: number) => {
    const next = [...value];
    const id = next.splice(index, 1)[0];
    if (id !== undefined) next.splice(index + offset, 0, id);
    onChange(next);
  };
  return (
    <Stack $gap={1}>
      <ol aria-label="Assigned prompts">
        {value.map((id, i) => {
          const entry = library.find((p) => p.id === id);
          const name = entry?.name ?? id;
          return (
            <li key={id}>
              <Row $gap={1} $wrap>
                <span>
                  {name}
                  {entry?.activeVersion === null
                    ? " (inactive draft)"
                    : entry === undefined
                      ? " (unavailable)"
                      : ""}
                </span>
                <Button
                  disabled={disabled || i === 0}
                  aria-label={`Move ${name} up`}
                  onClick={() => move(i, -1)}
                >
                  Up
                </Button>
                <Button
                  disabled={disabled || i === value.length - 1}
                  aria-label={`Move ${name} down`}
                  onClick={() => move(i, 1)}
                >
                  Down
                </Button>
                <Button
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(value.filter((v) => v !== id))}
                >
                  Remove
                </Button>
              </Row>
            </li>
          );
        })}
      </ol>
      <Select
        aria-label="Add prompt"
        placeholder="Choose a prompt"
        value=""
        disabled={disabled || value.length >= 5}
        onValueChange={(id) => {
          if (id) onChange([...value, id]);
        }}
        options={library
          .filter((p) => !value.includes(p.id) && !(p.builtin && builtinSelected))
          .map((p) => ({
            value: p.id,
            label: `${p.name}${p.activeVersion === null ? " (inactive draft)" : ""}`,
          }))}
      />
      <small>{value.length}/5 prompts · at most one built-in</small>
    </Stack>
  );
}
