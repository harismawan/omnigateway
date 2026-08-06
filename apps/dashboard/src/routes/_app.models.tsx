import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { modelsQuery } from "@/api/queries.ts";
import type { VirtualModel } from "@/api/types.ts";
import { EmptyState } from "@/components/EmptyState.tsx";
import { ErrorState } from "@/components/ErrorState.tsx";
import { LoadingSkeleton } from "@/components/LoadingSkeleton.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { DryRunPanel } from "@/features/models/DryRunPanel.tsx";
import { emptyTarget, ModelEditor } from "@/features/models/ModelEditor.tsx";

export const Route = createFileRoute("/_app/models")({ component: ModelsScreen });

function blankModel(): VirtualModel {
  return { id: "", targets: [emptyTarget("anthropic")], strategy: "score", isAlias: false };
}

export function filterModels(models: readonly VirtualModel[], query: string): VirtualModel[] {
  const normalizedQuery = query.trim().toLowerCase();
  return normalizedQuery === ""
    ? [...models]
    : models.filter((model) => model.id.toLowerCase().includes(normalizedQuery));
}

export function ModelsScreen() {
  const models = useQuery(modelsQuery());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  if (models.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader
          actions={null}
          description="Configure virtual models and routing targets."
          title="Models"
        />
        <div className="grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)]">
          <LoadingSkeleton className="h-72" />
          <LoadingSkeleton className="h-96" />
        </div>
      </div>
    );
  }
  if (models.isError) return <ErrorState error={models.error} onRetry={() => models.refetch()} />;

  const selected = models.data.find((model) => model.id === selectedId) ?? null;
  const filteredModels = filterModels(models.data, query);
  const startCreating = () => {
    setCreating(true);
    setSelectedId(null);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={<Button onClick={startCreating}>New model</Button>}
        description="Configure virtual models and routing targets."
        title="Models"
      />
      {models.data.length === 0 && !creating ? (
        <EmptyState
          action={<Button onClick={startCreating}>New model</Button>}
          description="Create one to route requests across provider targets."
          title="No virtual models configured"
        />
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[17rem_minmax(0,1fr)]">
          <nav aria-label="Virtual models" className="space-y-3 rounded-lg border p-3">
            <label className="sr-only" htmlFor="model-search">
              Search models
            </label>
            <Input
              id="model-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              role="searchbox"
              type="search"
              value={query}
            />
            {filteredModels.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No models match</p>
            ) : (
              <div className="space-y-1">
                {filteredModels.map((model) => (
                  <Button
                    aria-current={model.id === selectedId ? "page" : undefined}
                    className="h-auto w-full justify-start gap-2 px-2 py-2 text-left"
                    key={model.id}
                    onClick={() => {
                      setCreating(false);
                      setSelectedId(model.id);
                    }}
                    variant={model.id === selectedId ? "secondary" : "ghost"}
                  >
                    <span className="min-w-0 truncate">{model.id}</span>
                    {model.isAlias && (
                      <span
                        aria-hidden="true"
                        className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        alias
                      </span>
                    )}
                  </Button>
                ))}
              </div>
            )}
          </nav>
          {creating && (
            <main aria-label="New model" className="min-w-0">
              <ModelEditor
                isNew
                key="new"
                model={blankModel()}
                onDeleted={() => setCreating(false)}
                onSaved={(id) => {
                  setCreating(false);
                  setSelectedId(id);
                }}
              />
            </main>
          )}
          {selected !== null && (
            <main aria-label={`Model ${selected.id}`} className="min-w-0 space-y-6">
              <ModelEditor
                key={selected.id}
                model={selected}
                onDeleted={() => setSelectedId(null)}
                onSaved={(id) => setSelectedId(id)}
              />
              <DryRunPanel modelId={selected.id} />
            </main>
          )}
          {!creating && selected === null && (
            <main
              aria-label="Model details"
              className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground"
            >
              Select a virtual model to edit its routing targets.
            </main>
          )}
        </div>
      )}
    </div>
  );
}
