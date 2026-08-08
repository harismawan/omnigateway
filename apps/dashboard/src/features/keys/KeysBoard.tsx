import { Plus } from "lucide-react";
import { useState } from "react";
import styled from "styled-components";
import { useKeys, useRevokeKey } from "../../api/queries.ts";
import type { ApiKeySummary } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, ScrollX, Truncate } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { MintKeyDialog } from "./MintKeyDialog.tsx";

const Allow = styled(Row)`
  gap: 4px;
  flex-wrap: wrap;
  max-width: 34ch;
`;

const Revoked = styled.span`
  color: ${({ theme }) => theme.color.inkFaint};
`;

export function KeysBoard() {
  const keys = useKeys();
  const revoke = useRevokeKey();
  const [minting, setMinting] = useState(false);
  const [doomed, setDoomed] = useState<ApiKeySummary | null>(null);

  const rows = keys.data ?? [];
  const active = rows.filter((key) => key.revokedAt === null);

  const summary = keys.isLoading
    ? "Reading issued keys…"
    : rows.length === 0
      ? "No keys exist, so nothing can call this gateway yet."
      : `${active.length} active key${active.length === 1 ? "" : "s"} of ${rows.length} ever issued.`;

  return (
    <>
      <PageHead
        legend="Keys"
        title="Gateway API keys"
        summary={summary}
        actions={
          <Button type="button" $variant="primary" onClick={() => setMinting(true)}>
            <Plus />
            Create a key
          </Button>
        }
      />

      <Module legend="Issued keys" meta={`${rows.length}`} flush>
        {keys.isError ? (
          <Failure error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.isLoading ? (
          <div style={{ padding: 12 }}>
            <SkeletonRows rows={4} />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            legend="No keys"
            message="Create a key and give it to a client. The key is shown once, at creation."
            action={
              <Button type="button" $variant="primary" $size="sm" onClick={() => setMinting(true)}>
                Create a key
              </Button>
            }
          />
        ) : (
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <Th>Label</Th>
                  <Th>Prefix</Th>
                  <Th>Allowed models</Th>
                  <Th $align="right">Rate limit</Th>
                  <Th $align="right">Created</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => (
                  <Tr key={key.id}>
                    <Td>
                      <Truncate style={{ maxWidth: "24ch", display: "block" }}>
                        {key.label}
                      </Truncate>
                    </Td>
                    <Td $mono>{key.prefix}…</Td>
                    <Td>
                      {key.modelAllowlist === null ? (
                        <Legend>every model</Legend>
                      ) : key.modelAllowlist.length === 0 ? (
                        <Chip $tone="down">no models</Chip>
                      ) : (
                        <Allow>
                          {key.modelAllowlist.map((model) => (
                            <Chip key={model}>{model}</Chip>
                          ))}
                        </Allow>
                      )}
                    </Td>
                    <Td $align="right" $mono>
                      {key.rateLimitPerMin === null ? "—" : `${key.rateLimitPerMin}/min`}
                    </Td>
                    <Td $align="right" $mono>
                      {formatDateTime(key.createdAt)}
                    </Td>
                    <Td>
                      {key.revokedAt === null ? (
                        <Chip $tone="ok">active</Chip>
                      ) : (
                        <Revoked title={formatDateTime(key.revokedAt)}>
                          <Chip>revoked</Chip>
                        </Revoked>
                      )}
                    </Td>
                    <Td $align="right">
                      {key.revokedAt === null ? (
                        <Button
                          type="button"
                          $variant="danger"
                          $size="sm"
                          onClick={() => setDoomed(key)}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </ScrollX>
        )}
      </Module>

      <MintKeyDialog open={minting} onOpenChange={setMinting} />

      <Confirm
        open={doomed !== null}
        onOpenChange={(next) => {
          if (!next) setDoomed(null);
        }}
        title="Revoke key"
        body={
          doomed === null
            ? ""
            : `Revoking "${doomed.label}" refuses its next request. The key stays listed so past usage keeps its attribution, and it cannot be un-revoked.`
        }
        confirmLabel="Revoke key"
        busy={revoke.isPending}
        onConfirm={() => {
          if (doomed === null) return;
          revoke.mutate(doomed.id, { onSettled: () => setDoomed(null) });
        }}
      />
    </>
  );
}
