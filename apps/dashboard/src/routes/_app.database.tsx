import { createFileRoute } from "@tanstack/react-router";
import { DatabaseBoard } from "../features/database/DatabaseBoard.tsx";

export const Route = createFileRoute("/_app/database")({ component: DatabaseBoard });
