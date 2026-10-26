import { createFileRoute } from "@tanstack/react-router";
import { ExportBoard } from "../features/export/ExportBoard.tsx";

export const Route = createFileRoute("/_app/export")({ component: ExportBoard });
