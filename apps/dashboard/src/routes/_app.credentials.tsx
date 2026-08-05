import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { credentialHealthQuery, credentialsQuery } from "@/api/queries.ts";
import type { CredentialHealth, ProviderId, QuotaWindow, WireCredential } from "@/api/types.ts";
import { PROVIDER_IDS, PROVIDER_LABELS } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { LoadingSkeleton } from "@/components/LoadingSkeleton.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
import { StatTile } from "@/components/StatTile.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ConnectDialog } from "@/features/credentials/ConnectDialog.tsx";
import { ProviderGroup } from "@/features/credentials/ProviderGroup.tsx";

export type CredentialSummary = {
  connected: number;
  healthy: number;
  impaired: number;
  quotaWarnings: number;
};

export function credentialSummary(
  credentials: WireCredential[],
  health: CredentialHealth[],
  quota: QuotaWindow[],
  now: number,
): CredentialSummary {
  const healthByCredential = new Map<string, CredentialHealth[]>();
  for (const row of health) {
    const rows = healthByCredential.get(row.credentialId) ?? [];
    rows.push(row);
    healthByCredential.set(row.credentialId, rows);
  }
  const credentialIds = new Set(credentials.map((credential) => credential.id));
  const quotaWarnings = new Set(
    quota
      .filter(
        (window) =>
          credentialIds.has(window.credentialId) &&
          window.limit !== null &&
          Number.isFinite(window.limit) &&
          window.used / window.limit >= 0.9,
      )
      .map((window) => window.credentialId),
  );
  let healthy = 0;
  let impaired = 0;

  for (const credential of credentials) {
    const rows = healthByCredential.get(credential.id);
    if (rows === undefined || rows.length === 0) continue;
    const isImpaired = rows.some(
      (row) =>
        row.breakerState === "open" ||
        (row.rateLimitedUntil !== null && row.rateLimitedUntil > now),
    );
    if (isImpaired) impaired += 1;
    else healthy += 1;
  }

  return { connected: credentials.length, healthy, impaired, quotaWarnings: quotaWarnings.size };
}

function ProviderChooser({ onSelect }: { onSelect: (provider: ProviderId) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="dialog" aria-label="Connect provider">
      {PROVIDER_IDS.map((provider) => (
        <Button key={provider} variant="secondary" onClick={() => onSelect(provider)}>
          {PROVIDER_LABELS[provider]}
        </Button>
      ))}
    </div>
  );
}

function CredentialsLoading() {
  return (
    <main className="space-y-6">
      <PageHeader
        title="Credentials"
        description="Manage provider accounts used by the gateway."
        actions={<Button disabled>Connect provider</Button>}
      />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {["connected-accounts", "healthy-accounts", "impaired-accounts", "quota-warnings"].map(
          (label) => (
            <LoadingSkeleton key={label} className="h-28" />
          ),
        )}
      </div>
      {PROVIDER_IDS.map((provider) => (
        <section key={provider} className="space-y-3">
          <LoadingSkeleton className="h-6 w-32" />
          <LoadingSkeleton className="h-40" />
        </section>
      ))}
    </main>
  );
}

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
  const [providerChooserOpen, setProviderChooserOpen] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<ProviderId | null>(null);
  const credentials = useQuery(credentialsQuery());
  const credentialHealth = useQuery(credentialHealthQuery());
  if (credentials.isError)
    return <ErrorState error={credentials.error} onRetry={() => credentials.refetch()} />;
  if (credentials.isPending) return <CredentialsLoading />;

  function addProvider(provider: ProviderId) {
    setProviderChooserOpen(false);
    setPendingProvider(provider);
    onAddProvider?.(provider);
  }

  const currentHealth = credentialHealth.data?.health ?? health;
  const currentQuota = credentialHealth.data?.quota ?? quota;
  const summary = credentialSummary(credentials.data, currentHealth, currentQuota, now);

  return (
    <main className="space-y-6">
      <PageHeader
        title="Credentials"
        description="Manage provider accounts used by the gateway."
        actions={<Button onClick={() => setProviderChooserOpen(true)}>Connect provider</Button>}
      />
      {providerChooserOpen && <ProviderChooser onSelect={addProvider} />}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Connected accounts" value={String(summary.connected)} />
        <StatTile label="Healthy accounts" value={String(summary.healthy)} tone="ok" />
        <StatTile label="Impaired accounts" value={String(summary.impaired)} tone="bad" />
        <StatTile label="Quota warnings" value={String(summary.quotaWarnings)} tone="warn" />
      </div>
      {PROVIDER_IDS.map((provider) => (
        <ProviderGroup
          key={provider}
          provider={provider}
          credentials={credentials.data.filter((credential) => credential.provider === provider)}
          health={currentHealth}
          quota={currentQuota}
          healthUnavailable={credentialHealth.isError || credentialHealth.data === undefined}
          now={now}
          onAdd={addProvider}
        />
      ))}
      {pendingProvider !== null && (
        <ConnectDialog provider={pendingProvider} onClose={() => setPendingProvider(null)} />
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
