import { createFileRoute } from "@tanstack/react-router";
import { AccountsBoard } from "../features/accounts/AccountsBoard.tsx";

export const Route = createFileRoute("/_app/accounts")({ component: AccountsBoard });
