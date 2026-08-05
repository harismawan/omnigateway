import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client.ts";
import { qk, statusQuery } from "@/api/queries.ts";
import type { OkResponse, StatusResponse } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
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

  if (status.isPending) return <p>Loading…</p>;
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
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
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
