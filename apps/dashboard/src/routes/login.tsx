import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client.ts";
import { qk, statusQuery } from "@/api/queries.ts";
import type { OkResponse, StatusResponse } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { LoadingSkeleton } from "@/components/LoadingSkeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

const MIN_PASSWORD_LENGTH = 12;

type LoginScreenProps = { onAuthenticated: () => void };

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const queryClient = useQueryClient();
  const status = useQuery(statusQuery());
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (path: "/api/login" | "/api/setup") => api.post<OkResponse>(path, { password }),
    onSuccess: () => {
      queryClient.setQueryData<StatusResponse>(qk.status(), {
        configured: true,
        authenticated: true,
      });
      onAuthenticated();
    },
  });

  if (status.isPending) {
    return (
      <main className="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-2">
        <section className="hidden bg-[linear-gradient(145deg,var(--primary),oklch(0.35_0.12_270))] lg:block" />
        <section className="flex items-center justify-center p-6 sm:p-10">
          <div className="w-full max-w-md space-y-6">
            <LoadingSkeleton className="h-8 w-32" />
            <LoadingSkeleton className="h-5 w-3/4" />
            <LoadingSkeleton className="h-40 w-full" />
          </div>
        </section>
      </main>
    );
  }
  if (status.isError)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;

  const isSetup = !status.data.configured;
  const title = isSetup ? "Set an admin password" : "Sign in";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError(null);
    if (isSetup) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        setLocalError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (password !== confirmPassword) {
        setLocalError("Passwords do not match.");
        return;
      }
    }
    submit.mutate(isSetup ? "/api/setup" : "/api/login");
  }

  return (
    <main className="grid min-h-screen grid-cols-1 bg-background lg:grid-cols-2">
      <section className="relative hidden overflow-hidden bg-[linear-gradient(145deg,var(--primary),oklch(0.35_0.12_270))] p-10 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3 text-lg font-semibold tracking-tight">
          <span className="grid size-9 place-items-center rounded-lg bg-primary-foreground/15 font-mono text-sm">
            OG
          </span>
          OmniGateway
        </div>
        <div className="max-w-md border-l border-primary-foreground/30 pl-6">
          <p className="text-3xl leading-tight font-semibold tracking-tight">
            Route requests across provider accounts with one reliable control plane.
          </p>
        </div>
        <p className="font-mono text-xs tracking-[0.2em] text-primary-foreground/65 uppercase">
          Operator workspace
        </p>
      </section>

      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="grid size-9 place-items-center rounded-lg bg-primary font-mono text-sm text-primary-foreground">
              OG
            </span>
            <span className="text-lg font-semibold tracking-tight">OmniGateway</span>
          </div>
          <Card className="border-border/80 shadow-lg shadow-primary/5">
            <CardHeader>
              <h1 className="leading-none font-semibold">{title}</h1>
              <CardDescription>
                {isSetup
                  ? "Create the password used to administer this OmniGateway instance."
                  : "Enter your administrator password to continue."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="grid gap-4" onSubmit={handleSubmit}>
                <div className="grid gap-2">
                  <Label htmlFor="password">Password</Label>
                  {isSetup && (
                    <p className="text-sm text-muted-foreground">At least 12 characters</p>
                  )}
                  <Input
                    autoComplete={isSetup ? "new-password" : "current-password"}
                    id="password"
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    value={password}
                  />
                </div>
                {isSetup && (
                  <div className="grid gap-2">
                    <Label htmlFor="confirm-password">Confirm password</Label>
                    <Input
                      autoComplete="new-password"
                      id="confirm-password"
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      type="password"
                      value={confirmPassword}
                    />
                  </div>
                )}
                {localError !== null && (
                  <p className="text-sm text-destructive" role="alert">
                    {localError}
                  </p>
                )}
                {submit.isError && <ErrorState error={submit.error} />}
                <Button disabled={submit.isPending} type="submit">
                  {isSetup ? "Create password" : "Sign in"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}

export const Route = createFileRoute("/login")({
  component: LoginRoute,
});

export function LoginRoute() {
  const navigate = Route.useNavigate();
  return <LoginScreen onAuthenticated={() => void navigate({ to: "/credentials" as string })} />;
}
