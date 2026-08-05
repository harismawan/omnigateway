import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { credentialsQuery } from "@/api/queries.ts";
import type { CredentialHealth, ProviderId, QuotaWindow } from "@/api/types.ts";
import { PROVIDER_IDS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { ProviderGroup } from "@/features/credentials/ProviderGroup.tsx";

export function CredentialsScreen({
  now,
  health = [],
  quota = [],
  onAddProvider,
}: {
  now: number;
  health?: CredentialHealth[];
  quota?: QuotaWindow[];
  onAddProvider?: (provider: ProviderId) => void;
}) {
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);
  const credentials = useQuery(credentialsQuery());
  if (credentials.isError)
    return <ErrorState error={credentials.error} onRetry={() => credentials.refetch()} />;
  if (credentials.isPending)
    return <p className="text-sm text-muted-foreground">Loading credentials…</p>;

  function addProvider(provider: ProviderId) {
    setPendingProvider(provider);
    onAddProvider?.(provider);
  }

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Credentials</h1>
        <p className="text-sm text-muted-foreground">
          Manage provider accounts used by the gateway.
        </p>
      </div>
      {PROVIDER_IDS.map((provider) => (
        <ProviderGroup
          key={provider}
          provider={provider}
          credentials={credentials.data.filter((credential) => credential.provider === provider)}
          health={health}
          quota={quota}
          now={now}
          onAdd={addProvider}
        />
      ))}
      {pendingProvider !== null && (
        <span className="sr-only">Adding {pendingProvider} account</span>
      )}
    </main>
  );
}

export const Route = createFileRoute("/_app/credentials")({
  component: CredentialsRoute,
});

function CredentialsRoute() {
  return <CredentialsScreen now={Date.now()} />;
}
