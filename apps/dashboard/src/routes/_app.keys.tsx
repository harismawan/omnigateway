import { createFileRoute } from "@tanstack/react-router";
import { KeysBoard } from "../features/keys/KeysBoard.tsx";

export const Route = createFileRoute("/_app/keys")({
  validateSearch: (search: Record<string, unknown>): { editPrompts?: string } =>
    typeof search.editPrompts === "string" ? { editPrompts: search.editPrompts } : {},
  component: KeysPage,
});

function KeysPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <KeysBoard {...search} onClosePrompts={() => navigate({ search: {} })} />;
}
