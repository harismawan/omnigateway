import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { useInvalidate } from "@/api/queries.ts";
import { type ProviderId, STRATEGIES, type Target, type VirtualModel } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { TargetRow } from "./TargetRow.tsx";

export function emptyTarget(provider: ProviderId): Target {
  return {
    provider,
    model: "",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 0, output: 0 },
    capabilities: { tools: true, images: false, reasoning: false },
  };
}

type DraftTarget = { key: string; target: Target };
type Props = {
  model: VirtualModel;
  isNew?: boolean;
  onSaved: (id: string) => void;
  onDeleted: () => void;
};

function targetDrafts(targets: Target[]): DraftTarget[] {
  return targets.map((target, index) => ({ key: `target-${index}`, target }));
}

export function ModelEditor({ model, isNew = false, onSaved, onDeleted }: Props) {
  const [id, setId] = useState(model.id);
  const [strategy, setStrategy] = useState(model.strategy);
  const [targets, setTargets] = useState(() => targetDrafts(model.targets));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const invalidate = useInvalidate();
  const current = (): VirtualModel => ({
    ...model,
    id,
    strategy,
    targets: targets.map((entry) => entry.target),
  });
  const save = useMutation({
    mutationFn: () => api.put(`/api/models/${encodeURIComponent(id)}`, current()),
    onSuccess: async () => {
      await invalidate([["models"]]);
      onSaved(id);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/models/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      await invalidate([["models"]]);
      onDeleted();
    },
  });
  const updateTarget = (index: number, patch: Partial<Target>) =>
    setTargets((currentTargets) =>
      currentTargets.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, target: { ...entry.target, ...patch } } : entry,
      ),
    );
  const move = (from: number, to: number) =>
    setTargets((currentTargets) => arrayMove(currentTargets, from, to));
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = targets.findIndex((entry) => entry.key === event.active.id);
    const to = targets.findIndex((entry) => entry.key === event.over?.id);
    if (from >= 0 && to >= 0) move(from, to);
  };
  return (
    <section className="space-y-4 rounded-md border p-4" aria-label="Model editor">
      <label className="block text-sm font-medium">
        Model id
        <input
          aria-label="Model id"
          value={id}
          disabled={!isNew}
          onChange={(event) => setId(event.target.value)}
        />
      </label>
      <label className="block text-sm font-medium">
        Strategy
        <select
          aria-label="Strategy"
          value={strategy}
          onChange={(event) => setStrategy(event.target.value as VirtualModel["strategy"])}
        >
          {STRATEGIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext
          items={targets.map((entry) => entry.key)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-3">
            {targets.map((entry, index) => (
              <TargetRow
                key={entry.key}
                id={entry.key}
                target={entry.target}
                index={index}
                count={targets.length}
                onChange={(patch) => updateTarget(index, patch)}
                onMove={move}
                onRemove={() => {
                  if (targets.length === 1) {
                    setError("A virtual model needs at least one target.");
                    return;
                  }
                  setTargets((currentTargets) =>
                    currentTargets.filter((_, entryIndex) => entryIndex !== index),
                  );
                }}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          setTargets((currentTargets) => [
            ...currentTargets,
            { key: crypto.randomUUID(), target: emptyTarget("anthropic") },
          ])
        }
      >
        Add target
      </Button>
      {error !== null && <p role="alert">{error}</p>}
      {save.isError && <ErrorState error={save.error} />}
      {remove.isError && <ErrorState error={remove.error} />}
      <div className="flex gap-2">
        <Button
          onClick={() => {
            setError(null);
            save.mutate();
          }}
          disabled={save.isPending || id.length === 0}
        >
          Save model
        </Button>
        {!isNew && (
          <Button
            variant="destructive"
            onClick={() => setConfirming(true)}
            disabled={remove.isPending}
          >
            Delete model
          </Button>
        )}
      </div>
      {confirming && (
        <div role="alertdialog">
          <p>Requests naming this model will fail until another one claims the name.</p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >{`Delete “${id}”`}</Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
