import { createFileRoute } from "@tanstack/react-router";
import { ConsoleBoard } from "../features/console/ConsoleBoard.tsx";

export const Route = createFileRoute("/_app/console")({ component: ConsoleBoard });
