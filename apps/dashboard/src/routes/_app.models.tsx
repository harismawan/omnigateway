import { createFileRoute } from "@tanstack/react-router";
import { ModelsBoard } from "../features/models/ModelsBoard.tsx";

export const Route = createFileRoute("/_app/models")({ component: ModelsBoard });
