import { createFileRoute } from "@tanstack/react-router";
import { SettingsBoard } from "../features/settings/SettingsBoard.tsx";

export const Route = createFileRoute("/_app/settings")({ component: SettingsBoard });
