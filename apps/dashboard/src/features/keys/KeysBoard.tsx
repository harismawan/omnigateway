import { ChevronDown, ChevronRight, ListChecks, Plus, SlidersHorizontal } from "lucide-react";
import { Fragment, useState } from "react";
import styled from "styled-components";
import { useKeys, useRevokeKey } from "../../api/queries.ts";
import type { ApiKeySummary, LimitReading } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, ScrollX, Truncate } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { EditLimitsDialog } from "./EditLimitsDialog.tsx";
import { EditModelsDialog } from "./EditModelsDialog.tsx";
import { LimitMatrix } from "./LimitMatrix.tsx";
import { describeSlot, formatLimitValue, fractionOf, nearestExhaustion } from "./limits.ts";
import { MintKeyDialog } from "./MintKeyDialog.tsx";

const Allow = styled(Row)`
  gap: 4px;
  flex-wrap: wrap;
  max-width: 34ch;
`;

const Revoked = styled.span`
  color: ${({ theme }) => theme.color.inkFaint};
`;

/** The nearest-exhaustion line under the count, quiet enough to stay secondary. */
const Nearest = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const Summary = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
`;

/**
 * The one limit that will deny first, which is the only one a summary can carry.
 *
 * A key with three ceilings has one cell, and the shortest window is the wrong
 * answer: a key idle this minute and one request from its weekly ceiling would
 * read as comfortable. `concurrency` cannot be ranked here — it is an in-flight
 * gauge held in the serving process — so a key limited only by it says so.
 */
function describeNearest(nearest: LimitReading | null): string {
  if (nearest === null) return "usage not counted here";
  const share = fractionOf(nearest);
  const name = describeSlot({ dimension: nearest.dimension, window: nearest.window });
  const ceiling = formatLimitValue(nearest.dimension, nearest.limit);
  return `${name} ${ceiling}, ${share === null ? "—" : Math.round(share * 100)}% used`;
}

export function KeysBoard() {
  const keys = useKeys();
  const revoke = useRevokeKey();
  const [minting, setMinting] = useState(false);
  const [editing, setEditing] = useState<ApiKeySummary | null>(null);
  const [editingModels, setEditingModels] = useState<ApiKeySummary | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
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
                  <Th $align="right">Limits</Th>
                  <Th $align="right">Created</Th>
                  <Th>Body capture</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => {
                  const open = opened === key.id;
                  const nearest = nearestExhaustion(key.limitUsage);
                  return (
                    <Fragment key={key.id}>
                      <Tr>
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
                        <Td $align="right">
                          {/* A summary, not the matrix: a table per row is not
                              what an at-a-glance board is for, so the count
                              leads and the limit that will deny first sits
                              under it. The rest is behind the disclosure.

                              Null limits are not a dash: the gateway refuses
                              this key until the stored column is fixed, so
                              showing it as unlimited would name the
                              healthiest-looking row on the board as the broken
                              one. */}
                          {key.limits === null ? (
                            <Chip $tone="down">unreadable</Chip>
                          ) : key.limitUsage.length === 0 ? (
                            <Legend>no limits</Legend>
                          ) : (
                            <Summary>
                              <span>
                                {key.limitUsage.length} limit
                                {key.limitUsage.length === 1 ? "" : "s"}
                              </span>
                              <Nearest>{describeNearest(nearest)}</Nearest>
                            </Summary>
                          )}
                        </Td>
                        <Td $align="right" $mono>
                          {formatDateTime(key.createdAt)}
                        </Td>
                        <Td>
                          {/* An opted-out key is never captured whatever the
                              settings say, and that is a promise made to whoever
                              holds it — so it is listed rather than left in the
                              database for an auditor to find. */}
                          {key.bodyLoggingOptOut ? <Chip>no bodies</Chip> : <Legend>—</Legend>}
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
                          <Row $gap={1} $justify="flex-end">
                            {/* Nothing configured is nothing to unfold, so the
                                control is absent rather than opening onto an
                                empty panel. */}
                            {key.limitUsage.length === 0 ? null : (
                              <IconButton
                                type="button"
                                $variant="ghost"
                                $size="sm"
                                aria-expanded={open}
                                aria-label={`${open ? "Hide" : "Show"} limits for ${key.label}`}
                                title={`${open ? "Hide" : "Show"} limits for ${key.label}`}
                                onClick={() => setOpened(open ? null : key.id)}
                              >
                                {open ? <ChevronDown /> : <ChevronRight />}
                              </IconButton>
                            )}
                            {key.revokedAt === null ? (
                              <>
                                <IconButton
                                  type="button"
                                  $variant="ghost"
                                  $size="sm"
                                  aria-label={`Edit models for ${key.label}`}
                                  title={`Edit models for ${key.label}`}
                                  onClick={() => setEditingModels(key)}
                                >
                                  <ListChecks />
                                </IconButton>
                                <IconButton
                                  type="button"
                                  $variant="ghost"
                                  $size="sm"
                                  aria-label={`Edit limits for ${key.label}`}
                                  title={`Edit limits for ${key.label}`}
                                  onClick={() => setEditing(key)}
                                >
                                  <SlidersHorizontal />
                                </IconButton>
                                <Button
                                  type="button"
                                  $variant="danger"
                                  $size="sm"
                                  onClick={() => setDoomed(key)}
                                >
                                  Revoke
                                </Button>
                              </>
                            ) : null}
                          </Row>
                        </Td>
                      </Tr>
                      {open ? (
                        <Tr>
                          <Td colSpan={8}>
                            <LimitMatrix label={key.label} readings={key.limitUsage} />
                          </Td>
                        </Tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </ScrollX>
        )}
      </Module>

      <MintKeyDialog open={minting} onOpenChange={setMinting} />

      {/* Keyed by the row, so opening a second key starts from that key's
          matrix rather than from whatever was typed into the last one. */}
      <EditLimitsDialog
        key={editing?.id ?? "none"}
        apiKey={editing}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
      />

      {/* Keyed by the row, same reason as the limits dialog: opening a second
          key starts from that key's allowlist rather than whatever was checked
          into the last one. */}
      <EditModelsDialog
        key={editingModels?.id ?? "none"}
        apiKey={editingModels}
        onOpenChange={(next) => {
          if (!next) setEditingModels(null);
        }}
      />

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
