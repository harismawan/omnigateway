import { createFileRoute } from "@tanstack/react-router";
import { OverviewBoard } from "../features/overview/OverviewBoard.tsx";

export const Route = createFileRoute("/_app/")({ component: OverviewBoard });
