import { createFileRoute } from "@tanstack/react-router";
import { PromptsBoard } from "../features/prompts/PromptsBoard.tsx";

export const Route = createFileRoute("/_app/prompts")({
  validateSearch: (search: Record<string, unknown>): { id?: string; version?: string } => ({
    ...(typeof search.id === "string" ? { id: search.id } : {}),
    ...(typeof search.version === "string" || typeof search.version === "number"
      ? { version: String(search.version) }
      : {}),
  }),
  component: PromptsPage,
});

function PromptsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PromptsBoard
      {...search}
      onSelect={(id, version) =>
        navigate({ search: { ...(id ? { id } : {}), ...(version ? { version } : {}) } })
      }
    />
  );
}
