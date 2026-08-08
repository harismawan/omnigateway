import { createFileRoute } from "@tanstack/react-router";
import { LogsBoard } from "../features/logs/LogsBoard.tsx";

export const Route = createFileRoute("/_app/logs")({ component: LogsBoard });
