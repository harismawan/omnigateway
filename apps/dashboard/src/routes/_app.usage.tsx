import { createFileRoute } from "@tanstack/react-router";
import { UsageBoard } from "../features/usage/UsageBoard.tsx";

export const Route = createFileRoute("/_app/usage")({ component: UsageBoard });
