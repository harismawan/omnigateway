import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { keysQuery } from "@/api/queries.ts";
import { DataTableFrame } from "@/components/DataTableFrame.tsx";
import { EmptyState } from "@/components/EmptyState.tsx";
import { ErrorState } from "@/components/ErrorState.tsx";
import { LoadingSkeleton } from "@/components/LoadingSkeleton.tsx";
import { PageHeader } from "@/components/PageHeader.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogTrigger } from "@/components/ui/dialog.tsx";
import { KeyRow } from "@/features/keys/KeyRow.tsx";
import { MintKeyDialog, parseAllowlist } from "@/features/keys/MintKeyDialog.tsx";

export { parseAllowlist };

export function KeysScreen({ now }: { now: number }) {
  const keys = useQuery(keysQuery());
  const [minting, setMinting] = useState(false);
  const activeTrigger = useRef<HTMLButtonElement | null>(null);
  const closeMinting = () => setMinting(false);
  const createKey = () => (
    <DialogTrigger asChild>
      <Button
        onClick={(event) => {
          activeTrigger.current = event.currentTarget;
        }}
      >
        Create key
      </Button>
    </DialogTrigger>
  );

  return (
    <Dialog
      open={minting}
      onOpenChange={(open) => {
        if (open) setMinting(true);
        else closeMinting();
      }}
    >
      <div className="space-y-6">
        <PageHeader
          title="API keys"
          description="Create scoped keys for gateway clients. New keys are shown only once."
          actions={createKey()}
        />
        <MintKeyDialog
          onClose={closeMinting}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            activeTrigger.current?.focus();
          }}
        />
        {keys.isPending && (
          <section
            aria-label="Loading API keys"
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <LoadingSkeleton className="h-4 w-full" />
            <LoadingSkeleton className="h-10 w-full" />
            <LoadingSkeleton className="h-10 w-full" />
          </section>
        )}
        {keys.isError && <ErrorState error={keys.error} onRetry={() => keys.refetch()} />}
        {keys.data !== undefined &&
          (keys.data.length === 0 ? (
            <EmptyState
              title="No API keys yet"
              description="Create a scoped key for a gateway client."
              action={createKey()}
            />
          ) : (
            <DataTableFrame ariaLabel="API key table">
              <table aria-label="API keys" className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Label</th>
                    <th className="px-4 py-3 font-medium">Prefix</th>
                    <th className="px-4 py-3 font-medium">Model scope</th>
                    <th className="px-4 py-3 font-medium">Rate limit</th>
                    <th className="px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.data.map((apiKey) => (
                    <KeyRow key={apiKey.id} apiKey={apiKey} now={now} />
                  ))}
                </tbody>
              </table>
            </DataTableFrame>
          ))}
      </div>
    </Dialog>
  );
}

export const Route = createFileRoute("/_app/keys")({
  component: () => <KeysScreen now={Date.now()} />,
});
