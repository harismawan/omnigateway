import { useSortable } from "@dnd-kit/sortable";
import type { ProviderId, Target } from "@/api/types.ts";
import { PROVIDER_IDS } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";

type Props = {
  id: string;
  target: Target;
  index: number;
  count: number;
  onChange: (patch: Partial<Target>) => void;
  onRemove: () => void;
  onMove: (from: number, to: number) => void;
};

export function TargetRow({ id, target, index, count, onChange, onRemove, onMove }: Props) {
  const sortable = useSortable({ id });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform:
          sortable.transform === null
            ? undefined
            : `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)`,
        transition: sortable.transition,
      }}
      className="grid gap-2 rounded border p-3"
    >
      <div className="flex gap-2">
        <button
          type="button"
          aria-label={`Drag target ${index + 1}`}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          Drag
        </button>
        <strong>Target {index + 1}</strong>
      </div>
      <label>
        Provider
        <select
          aria-label={`Target ${index + 1} provider`}
          value={target.provider}
          onChange={(event) => onChange({ provider: event.target.value as ProviderId })}
        >
          {PROVIDER_IDS.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <input
          aria-label={`Target ${index + 1} model`}
          value={target.model}
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </label>
      <label>
        Tier
        <input
          aria-label={`Target ${index + 1} tier`}
          type="number"
          value={target.tier}
          onChange={(event) => onChange({ tier: Number(event.target.value) })}
        />
      </label>
      <label>
        Weight
        <input
          aria-label={`Target ${index + 1} weight`}
          type="number"
          value={target.weight}
          onChange={(event) => onChange({ weight: Number(event.target.value) })}
        />
      </label>
      <label>
        Input cost per M tokens
        <input
          aria-label={`Target ${index + 1} input cost`}
          type="number"
          value={target.costPerMTok.input}
          onChange={(event) =>
            onChange({ costPerMTok: { ...target.costPerMTok, input: Number(event.target.value) } })
          }
        />
      </label>
      <label>
        Output cost per M tokens
        <input
          aria-label={`Target ${index + 1} output cost`}
          type="number"
          value={target.costPerMTok.output}
          onChange={(event) =>
            onChange({ costPerMTok: { ...target.costPerMTok, output: Number(event.target.value) } })
          }
        />
      </label>
      {(["tools", "images", "reasoning"] as const).map((capability) => (
        <label key={capability}>
          <input
            aria-label={`Target ${index + 1} supports ${capability}`}
            type="checkbox"
            checked={target.capabilities[capability]}
            onChange={(event) =>
              onChange({
                capabilities: { ...target.capabilities, [capability]: event.target.checked },
              })
            }
          />
          Supports {capability}
        </label>
      ))}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move target ${index + 1} up`}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          Move up
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Move target ${index + 1} down`}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
        >
          Move down
        </Button>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          Remove target {index + 1}
        </Button>
      </div>
    </div>
  );
}
