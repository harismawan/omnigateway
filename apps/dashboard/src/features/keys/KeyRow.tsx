import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client.ts";
import { qk, useInvalidate } from "@/api/queries.ts";
import type { OkResponse, WireApiKey } from "@/api/types.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { formatRelative } from "@/lib/format.ts";

export function KeyRow({ apiKey, now }: { apiKey: WireApiKey; now: number }) {
  const invalidate = useInvalidate();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api.del<OkResponse>(`/api/keys/${encodeURIComponent(apiKey.id)}`),
    onSuccess: async () => {
      await invalidate([qk.keys()]);
    },
  });
  return (
    <tr className="border-t align-top">
      <td className="px-4 py-3 font-medium">{apiKey.label}</td>
      <td className="px-4 py-3 font-mono text-xs">{apiKey.prefix}…</td>
      <td className="max-w-72 px-4 py-3">
        {apiKey.modelAllowlist === null
          ? "All models"
          : apiKey.modelAllowlist.length === 0
            ? "No models"
            : apiKey.modelAllowlist.join(", ")}
      </td>
      <td className="px-4 py-3 tabular-nums">
        {apiKey.rateLimitPerMin === null ? "No limit" : `${apiKey.rateLimitPerMin}/min`}
      </td>
      <td className="px-4 py-3 tabular-nums">{formatRelative(apiKey.createdAt, now)}</td>
      <td className="px-4 py-3">
        {apiKey.revokedAt !== null ? (
          "Revoked"
        ) : confirming ? (
          <span className="flex items-center gap-2">
            <span>permanently revoke?</span>
            <Button
              size="sm"
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              Revoke key
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
        {revoke.isError && <ErrorState error={revoke.error} />}
      </td>
    </tr>
  );
}
