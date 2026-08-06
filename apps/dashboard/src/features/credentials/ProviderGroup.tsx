import type { CredentialHealth, ProviderId, QuotaWindow, WireCredential } from "@/api/types.ts";
import { PROVIDER_LABELS } from "@/api/types.ts";
import { EmptyState } from "@/components/EmptyState.tsx";
import { summarizeHealth } from "@/components/Health.tsx";
import { StatusBadge } from "@/components/StatusBadge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { CredentialCard } from "./CredentialCard.tsx";

export function ProviderGroup({
  provider,
  credentials,
  health,
  quota,
  healthUnavailable,
  now,
  onAdd,
}: {
  provider: ProviderId;
  credentials: WireCredential[];
  health: CredentialHealth[];
  quota: QuotaWindow[];
  healthUnavailable: boolean;
  now: number;
  onAdd: (provider: ProviderId) => void;
}) {
  const label = PROVIDER_LABELS[provider];
  const providerHealth = health.filter((row) =>
    credentials.some((credential) => credential.id === row.credentialId),
  );
  const status = healthUnavailable ? null : summarizeHealth(providerHealth, now);

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="text-lg font-semibold">{label}</h2>
          <span className="text-sm text-muted-foreground">{credentials.length} accounts</span>
          {status !== null && <StatusBadge label={status.label} tone={status.tone} />}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => onAdd(provider)}>
          Add {label} account
        </Button>
      </div>
      {credentials.length === 0 ? (
        <EmptyState
          title={`No ${label} accounts connected`}
          description={`Use Add ${label} account to make ${label} available to gateway routes.`}
        />
      ) : (
        <div className="grid gap-3">
          {credentials.map((credential) => (
            <CredentialCard
              key={credential.id}
              credential={credential}
              health={health.filter((row) => row.credentialId === credential.id)}
              quota={quota.filter((window) => window.credentialId === credential.id)}
              healthUnavailable={healthUnavailable}
              now={now}
            />
          ))}
        </div>
      )}
    </section>
  );
}
