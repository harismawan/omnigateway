import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { useInvalidate } from "@/api/queries.ts";
import {
  PROVIDER_IDS,
  type ProviderId,
  STRATEGIES,
  type Target,
  type VirtualModel,
} from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";

export function emptyTarget(provider: ProviderId): Target {
  return {
    provider,
    model: "",
    tier: 1,
    weight: 1,
    costPerMTok: { input: 0, output: 0 },
    capabilities: { tools: false, images: false, reasoning: false },
  };
}

type Props = {
  model: VirtualModel;
  isNew?: boolean;
  onSaved: (id: string) => void;
  onDeleted: () => void;
};

export function ModelEditor({ model, isNew = false, onSaved, onDeleted }: Props) {
  const [draft, setDraft] = useState(model);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: () => api.put(`/api/models/${draft.id}`, draft),
    onSuccess: async () => {
      await invalidate([["models"]]);
      onSaved(draft.id);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/models/${draft.id}`),
    onSuccess: async () => {
      await invalidate([["models"]]);
      onDeleted();
    },
  });
  const updateTarget = (index: number, patch: Partial<Target>) => {
    setDraft((current) => ({
      ...current,
      targets: current.targets.map((target, targetIndex) =>
        targetIndex === index ? { ...target, ...patch } : target,
      ),
    }));
  };

  return (
    <section className="space-y-4 rounded-md border p-4" aria-label="Model editor">
      <label className="block text-sm font-medium">
        Model id
        <input
          aria-label="Model id"
          value={draft.id}
          disabled={!isNew}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
        />
      </label>
      <label className="block text-sm font-medium">
        Strategy
        <select
          aria-label="Strategy"
          value={draft.strategy}
          onChange={(event) =>
            setDraft({ ...draft, strategy: event.target.value as VirtualModel["strategy"] })
          }
        >
          {STRATEGIES.map((strategy) => (
            <option key={strategy} value={strategy}>
              {strategy}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-3">
        {draft.targets.map((target, index) => (
          <div className="grid gap-2 rounded border p-3" key={`${target.provider}-${target.model}`}>
            <strong>Target {index + 1}</strong>
            <label>
              Provider
              <select
                aria-label={`Target ${index + 1} provider`}
                value={target.provider}
                onChange={(event) =>
                  updateTarget(index, { provider: event.target.value as ProviderId })
                }
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
                onChange={(event) => updateTarget(index, { model: event.target.value })}
              />
            </label>
            <label>
              Tier
              <input
                aria-label={`Target ${index + 1} tier`}
                type="number"
                value={target.tier}
                onChange={(event) => updateTarget(index, { tier: Number(event.target.value) })}
              />
            </label>
            <label>
              Weight
              <input
                aria-label={`Target ${index + 1} weight`}
                type="number"
                value={target.weight}
                onChange={(event) => updateTarget(index, { weight: Number(event.target.value) })}
              />
            </label>
            <label>
              Input cost per M tokens
              <input
                aria-label={`Target ${index + 1} input cost`}
                type="number"
                value={target.costPerMTok.input}
                onChange={(event) =>
                  updateTarget(index, {
                    costPerMTok: { ...target.costPerMTok, input: Number(event.target.value) },
                  })
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
                  updateTarget(index, {
                    costPerMTok: { ...target.costPerMTok, output: Number(event.target.value) },
                  })
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
                    updateTarget(index, {
                      capabilities: { ...target.capabilities, [capability]: event.target.checked },
                    })
                  }
                />
                Supports {capability}
              </label>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (draft.targets.length === 1) {
                  setError("A virtual model needs at least one target.");
                  return;
                }
                setDraft({
                  ...draft,
                  targets: draft.targets.filter((_, targetIndex) => targetIndex !== index),
                });
              }}
            >
              Remove target {index + 1}
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft({ ...draft, targets: [...draft.targets, emptyTarget("anthropic")] })
          }
        >
          Add target
        </Button>
      </div>
      {error !== null && <p role="alert">{error}</p>}
      {save.isError && <ErrorState error={save.error} />}
      {remove.isError && <ErrorState error={remove.error} />}
      <div className="flex gap-2">
        <Button
          onClick={() => {
            setError(null);
            save.mutate();
          }}
          disabled={save.isPending || draft.id.length === 0}
        >
          Save model
        </Button>
        {!isNew && (
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
            Delete model
          </Button>
        )}
      </div>
    </section>
  );
}
