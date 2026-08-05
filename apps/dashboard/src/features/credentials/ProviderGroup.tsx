import type { CredentialHealth, ProviderId, QuotaWindow, WireCredential } from "@/api/types.ts";
import { PROVIDER_LABELS } from "@/api/types.ts";
import { CredentialCard } from "./CredentialCard.tsx";

export function ProviderGroup({
  provider,
  credentials,
  health,
  quota,
  now,
}: {
  provider: ProviderId;
  credentials: WireCredential[];
  health: CredentialHealth[];
  quota: QuotaWindow[];
  now: number;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{PROVIDER_LABELS[provider]}</h2>
      <div className="grid gap-3">
        {credentials.map((credential) => (
          <CredentialCard
            key={credential.id}
            credential={credential}
            health={health.filter((row) => row.credentialId === credential.id)}
            quota={quota.filter((window) => window.credentialId === credential.id)}
            now={now}
          />
        ))}
      </div>
    </section>
  );
}
