import type { CredentialHealth, ProviderId, QuotaWindow, WireCredential } from "@/api/types.ts";
import { PROVIDER_LABELS } from "@/api/types.ts";
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
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{label}</h2>
        <Button type="button" variant="outline" size="sm" onClick={() => onAdd(provider)}>
          Add {label} account
        </Button>
      </div>
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
    </section>
  );
}
