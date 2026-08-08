import { createFileRoute } from "@tanstack/react-router";
import { KeysBoard } from "../features/keys/KeysBoard.tsx";

export const Route = createFileRoute("/_app/keys")({ component: KeysBoard });
