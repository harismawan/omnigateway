import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { AppShell, requireSession } from "@/components/AppShell.tsx";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context }) => requireSession(context.queryClient),
  component: AppLayout,
});

function AppLayout() {
  const navigate = useNavigate();
  return (
    <AppShell
      onSignOut={() => {
        void navigate({ to: "/login" });
      }}
    >
      <Outlet />
    </AppShell>
  );
}
