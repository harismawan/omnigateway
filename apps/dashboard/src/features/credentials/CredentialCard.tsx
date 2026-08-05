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
import { ErrorState } from "@/components/ErrorState.tsx";
import { HealthPill } from "@/components/Health.tsx";
import { QuotaBar } from "@/components/QuotaBar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { formatExpiry } from "@/lib/format.ts";

export function CredentialCard({
  credential,
  health,
  quota,
  healthUnavailable,
  now,
}: {
  credential: WireCredential;
  health: CredentialHealth[];
  quota: QuotaWindow[];
  healthUnavailable: boolean;
  now: number;
}) {
  const [enabled, setEnabled] = useState(credential.enabled);
  const [tier, setTier] = useState(String(credential.tier));
  const [weight, setWeight] = useState(String(credential.weight));
  const invalidate = useInvalidate();
  const save = useMutation({
    mutationFn: async (patch: CredentialPatch) =>
      api.patch(`/api/credentials/${credential.id}`, patch),
    onSuccess: async () => invalidate([qk.credentials(), qk.credentialHealth()]),
  });
  const remove = useMutation({
    mutationFn: async () => api.del(`/api/credentials/${credential.id}`),
    onSuccess: async () => invalidate([qk.credentials(), qk.credentialHealth()]),
  });

  const nextTier = Number(tier);
  const nextWeight = Number(weight);
  const valid =
    Number.isInteger(nextTier) && nextTier >= 1 && Number.isFinite(nextWeight) && nextWeight > 0;
  const dirty =
    enabled !== credential.enabled ||
    nextTier !== credential.tier ||
    nextWeight !== credential.weight;

  function submit() {
    if (!valid || !dirty) return;
    const patch: CredentialPatch = {};
    if (enabled !== credential.enabled) patch.enabled = enabled;
    if (nextTier !== credential.tier) patch.tier = nextTier;
    if (nextWeight !== credential.weight) patch.weight = nextWeight;
    save.mutate(patch);
  }

  function confirmDelete() {
    if (globalThis.confirm("Delete this credential?")) remove.mutate();
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">{credential.label}</h3>
          <p className="text-sm text-muted-foreground">
            {credential.accountEmail ?? credential.authType}
          </p>
          <p className="text-xs text-muted-foreground">{formatExpiry(credential.expiresAt, now)}</p>
        </div>
        {healthUnavailable ? (
          <p className="text-xs text-muted-foreground">Health unavailable</p>
        ) : (
          <HealthPill health={health} now={now} />
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${credential.id}-enabled`}>Enabled</Label>
          <Switch
            id={`${credential.id}-enabled`}
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-label="Enabled"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${credential.id}-tier`}>Tier</Label>
          <Input
            id={`${credential.id}-tier`}
            type="number"
            min={1}
            step={1}
            value={tier}
            onChange={(event) => setTier(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${credential.id}-weight`}>Weight</Label>
          <Input
            id={`${credential.id}-weight`}
            type="number"
            min={Number.MIN_VALUE}
            step="any"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
        <Button type="button" onClick={submit} disabled={!valid || !dirty || save.isPending}>
          Save
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={confirmDelete}
          disabled={remove.isPending}
        >
          Delete
        </Button>
      </div>
      <div className="grid gap-2 border-t pt-4">
        {quota.map((window) => (
          <QuotaBar key={window.windowType} window={window} />
        ))}
      </div>
      {save.isError && <ErrorState error={save.error} />}
      {remove.isError && <ErrorState error={remove.error} />}
    </section>
  );
}
