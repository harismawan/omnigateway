import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { credentialsQuery } from "@/api/queries.ts";
import type { CredentialHealth, ProviderId, QuotaWindow, WireCredential } from "@/api/types.ts";
import { PROVIDER_IDS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { ProviderGroup } from "@/features/credentials/ProviderGroup.tsx";

export function CredentialsScreen({
  now,
  health = [],
  quota = [],
}: {
  now: number;
  health?: CredentialHealth[];
  quota?: QuotaWindow[];
}) {
  const credentials = useQuery(credentialsQuery());
  if (credentials.isError)
    return <ErrorState error={credentials.error} onRetry={() => credentials.refetch()} />;
  if (credentials.isPending)
    return <p className="text-sm text-muted-foreground">Loading credentials…</p>;

  const groups = PROVIDER_IDS.map(
    (provider) =>
      [
        provider,
        credentials.data.filter((credential) => credential.provider === provider),
      ] as const,
  ).filter((entry): entry is readonly [ProviderId, WireCredential[]] => entry[1].length > 0);

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Credentials</h1>
        <p className="text-sm text-muted-foreground">
          Manage provider accounts used by the gateway.
        </p>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No credentials connected yet.</p>
      ) : (
        groups.map(([provider, rows]) => (
          <ProviderGroup
            key={provider}
            provider={provider}
            credentials={rows}
            health={health}
            quota={quota}
            now={now}
          />
        ))
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
