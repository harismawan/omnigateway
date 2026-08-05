import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/")({
  // Credentials is the screen an operator opens on: nothing else works until
  // at least one account is connected.
  beforeLoad: () => {
    throw redirect({ to: "/credentials" as never });
  },
});
