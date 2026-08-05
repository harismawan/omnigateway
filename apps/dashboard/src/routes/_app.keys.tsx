import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { keysQuery } from "@/api/queries.ts";
import { ErrorState } from "@/components/ErrorState.tsx";
import { Button } from "@/components/ui/button.tsx";
import { KeyRow } from "@/features/keys/KeyRow.tsx";
import { MintKeyDialog, parseAllowlist } from "@/features/keys/MintKeyDialog.tsx";

export { parseAllowlist };

export function KeysScreen({ now }: { now: number }) {
  const keys = useQuery(keysQuery());
  const [minting, setMinting] = useState(false);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">API keys</h1>
          <p className="text-sm text-muted-foreground">Create scoped keys for gateway clients.</p>
        </div>
        <Button onClick={() => setMinting(true)}>New key</Button>
      </div>
      <MintKeyDialog open={minting} onClose={() => setMinting(false)} />
      {keys.isPending && <p className="text-sm text-muted-foreground">Loading keys…</p>}
      {keys.isError && <ErrorState error={keys.error} onRetry={() => keys.refetch()} />}
      {keys.data !== undefined &&
        (keys.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No API keys yet. Mint one to start sending requests.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Label</th>
                <th>Key</th>
                <th>Models</th>
                <th>Rate limit</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((apiKey) => (
                <KeyRow key={apiKey.id} apiKey={apiKey} now={now} />
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}

export const Route = createFileRoute("/_app/keys")({
  component: () => <KeysScreen now={Date.now()} />,
});
