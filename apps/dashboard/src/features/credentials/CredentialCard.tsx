import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { qk, useInvalidate } from "@/api/queries.ts";
import type {
  CredentialHealth,
  CredentialPatch,
  QuotaWindow,
  WireCredential,
} from "@/api/types.ts";
import { HealthPill } from "@/components/Health.tsx";
import { QuotaBar } from "@/components/QuotaBar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { formatExpiry } from "@/lib/format.ts";

export function CredentialCard({
  credential,
  health,
  quota,
  now,
}: {
  credential: WireCredential;
  health: CredentialHealth[];
  quota: QuotaWindow[];
  now: number;
}) {
  const [tier, setTier] = useState(String(credential.tier));
  const [weight, setWeight] = useState(String(credential.weight));
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: async (patch: CredentialPatch) =>
      api.patch(`/api/credentials/${credential.id}`, patch),
    onSuccess: async () => invalidate([qk.credentials()]),
  });

  function submit() {
    const patch: CredentialPatch = {};
    const nextTier = Number(tier);
    const nextWeight = Number(weight);
    if (Number.isFinite(nextTier) && nextTier !== credential.tier) patch.tier = nextTier;
    if (Number.isFinite(nextWeight) && nextWeight !== credential.weight) patch.weight = nextWeight;
    if (Object.keys(patch).length > 0) save.mutate(patch);
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">{credential.label}</h3>
          <p className="text-sm text-muted-foreground">
            {credential.accountEmail ?? credential.authType}
          </p>
          <p className="text-xs text-muted-foreground">{formatExpiry(credential.expiresAt, now)}</p>
        </div>
        <HealthPill health={health} now={now} />
      </div>
      {quota.map((window) => (
        <QuotaBar key={window.windowType} window={window} />
      ))}
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${credential.id}-tier`}>Tier</Label>
          <Input
            id={`${credential.id}-tier`}
            type="number"
            value={tier}
            onChange={(event) => setTier(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${credential.id}-weight`}>Weight</Label>
          <Input
            id={`${credential.id}-weight`}
            type="number"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
        <Button type="button" onClick={submit} disabled={save.isPending}>
          Save
        </Button>
      </div>
    </section>
  );
}
