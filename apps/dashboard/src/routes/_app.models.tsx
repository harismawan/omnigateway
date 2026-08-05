import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { modelsQuery } from "@/api/queries.ts";
import type { VirtualModel } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { emptyTarget, ModelEditor } from "@/features/models/ModelEditor.tsx";

export const Route = createFileRoute("/_app/models")({ component: ModelsScreen });

function blankModel(): VirtualModel {
  return { id: "", targets: [emptyTarget("anthropic")], strategy: "score", isAlias: false };
}

export function ModelsScreen() {
  const models = useQuery(modelsQuery());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  if (models.isPending) return <p>Loading models…</p>;
  if (models.isError) return <ErrorState error={models.error} onRetry={() => models.refetch()} />;
  const selected = models.data.find((model) => model.id === selectedId) ?? null;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1>Models</h1>
        <Button
          size="sm"
          onClick={() => {
            setCreating(true);
            setSelectedId(null);
          }}
        >
          New model
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {models.data.map((model) => (
          <div key={model.id} className="flex items-center gap-1">
            <Button
              size="sm"
              variant={model.id === selectedId ? "default" : "outline"}
              onClick={() => {
                setCreating(false);
                setSelectedId(model.id);
              }}
            >
              {model.id}
            </Button>
            {model.isAlias && <span className="text-xs">alias</span>}
          </div>
        ))}
        {models.data.length === 0 && !creating && <p>No virtual models configured.</p>}
      </div>
      {creating && (
        <ModelEditor
          key="new"
          model={blankModel()}
          isNew
          onSaved={(id) => {
            setCreating(false);
            setSelectedId(id);
          }}
          onDeleted={() => setCreating(false)}
        />
      )}
      {selected !== null && (
        <ModelEditor
          key={selected.id}
          model={selected}
          onSaved={(id) => setSelectedId(id)}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
