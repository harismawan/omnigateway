import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Fragment, useState } from "react";
import styled from "styled-components";
import { useKeys, useRevokeKey, useSetKeySmartRouting, useSettings } from "../../api/queries.ts";
import type { ApiKeySummary, LimitReading, Settings } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatDateTime } from "../../lib/format.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { FillModule, FillScroller } from "../../ui/Panel.tsx";
import { Legend, Row, Truncate } from "../../ui/primitives.ts";
import { describeError, Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { EditExpiryDialog } from "./EditExpiryDialog.tsx";
import { EditGuardrailDialog } from "./EditGuardrailDialog.tsx";
import { EditLimitsDialog } from "./EditLimitsDialog.tsx";
import { EditModelsDialog } from "./EditModelsDialog.tsx";
import { keyState } from "./expiry.ts";
import { LimitMatrix } from "./LimitMatrix.tsx";
import { describeReading, formatLimitValue, fractionOf, nearestExhaustion } from "./limits.ts";
import { MintKeyDialog } from "./MintKeyDialog.tsx";

const Allow = styled(Row)`
  gap: 4px;
  flex-wrap: wrap;
  max-width: 34ch;
`;

const Revoked = styled.span`
  color: ${({ theme }) => theme.color.inkFaint};
`;

/** The expiry date under the state chip, quiet enough to stay secondary. */
const Expires = styled.span`
  display: block;
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
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
  const name = describeReading(nearest);
  const ceiling = formatLimitValue(nearest.dimension, nearest.limit);
  return `${name} ${ceiling}, ${share === null ? "—" : Math.round(share * 100)}% used`;
}

/**
 * Why a key's confidential-routing flag cannot act yet, or `null` when it can.
 *
 * The flag is per key but two settings gate it: a key carrying it while the
 * feature is off, or either model unset, is refused or served unscreened
 * depending on the gate, and neither is what the operator who flipped the
 * switch expects. `undefined` settings (still loading, or failed) warn nothing:
 * absence of a reading is not evidence of a problem.
 */
function inertReason(settings: Settings | undefined): string | null {
  if (settings === undefined) return null;
  if (!settings.smartRouterEnabled) return "confidential routing is switched off in Settings";
  if (settings.smartRouterClassifierModel === null || settings.smartRouterLocalModel === null) {
    return "the classifier model or the local model is not set in Settings";
  }
  return null;
}

/** What the "local-routed" chip says on hover, led by the warning when inert. */
function describeLocalRouted(settings: Settings | undefined): string {
  const meaning =
    "Requests from this key are screened for confidential content and answered by the local model when any is found.";
  const reason = inertReason(settings);
  return reason === null ? meaning : `Not active: ${reason}. ${meaning}`;
}

const Failed = styled.p`
  padding: 0 ${({ theme }) => theme.space(2)};
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

/** Visible, not a tooltip: warn, not down, since nothing has failed yet. */
const Inert = styled.p`
  padding: 0 ${({ theme }) => theme.space(2)};
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

export function KeysBoard() {
  const keys = useKeys();
  const settings = useSettings();
  const revoke = useRevokeKey();
  const smartRouting = useSetKeySmartRouting();
  const [smartFailure, setSmartFailure] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [editing, setEditing] = useState<ApiKeySummary | null>(null);
  const [editingModels, setEditingModels] = useState<ApiKeySummary | null>(null);
  const [editingExpiry, setEditingExpiry] = useState<ApiKeySummary | null>(null);
  const [editingPolicy, setEditingPolicy] = useState<ApiKeySummary | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [doomed, setDoomed] = useState<ApiKeySummary | null>(null);

  const now = Date.now();
  const rows = keys.data ?? [];
  // Only live keys count: a revoked key's flag changes nothing it sends.
  const inert = rows.some((key) => key.revokedAt === null && key.smartRouting)
    ? inertReason(settings.data)
    : null;
  // Only the *count* narrows. Every key stays in `rows` and keeps its row,
  // expired ones included: a key that stopped working and then disappeared from
  // the board is the bug this feature would otherwise ship, and the row is
  // where the operator goes to move the date or clear it.
  const active = rows.filter((key) => keyState(key, now) === "active");

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

      {inert === null ? null : (
        <Inert role="status">
          Some keys have confidential routing on, but it is not active: {inert}. Their requests are
          not being screened.
        </Inert>
      )}

      {smartFailure === null ? null : <Failed role="alert">{smartFailure}</Failed>}

      <FillModule legend="Issued keys" meta={`${rows.length}`} flush>
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
          <FillScroller>
            <Table>
              <thead>
                <tr>
                  <Th>Label</Th>
                  <Th>Prefix</Th>
                  <Th>Allowed models</Th>
                  <Th $align="right">Limits</Th>
                  <Th $align="right">Created</Th>
                  <Th>Body capture</Th>
                  <Th>Checks</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((key) => {
                  const open = opened === key.id;
                  const nearest = nearestExhaustion(key.limitUsage);
                  const status = keyState(key, now);
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
                          {/* Whether requests are judged, not the text: a
                              policy can run to thousands of characters and is
                              read in its own dialog. */}
                          {key.guardrailPolicy === null && !key.smartRouting ? (
                            <Legend>—</Legend>
                          ) : (
                            <Allow>
                              {key.guardrailPolicy === null ? null : (
                                <Chip title={key.guardrailPolicy}>judged</Chip>
                              )}
                              {/* Warns in its tooltip when the flag cannot act
                                  yet, so the operator hears it here and not
                                  from a client. */}
                              {key.smartRouting ? (
                                <Chip title={describeLocalRouted(settings.data)}>local-routed</Chip>
                              ) : null}
                            </Allow>
                          )}
                        </Td>
                        <Td>
                          {/* Three chips, not two. An expired key is refused at
                              `/v1` while looking untouched in every other
                              column, so it says so here — and the date sits
                              under whichever chip it applies to, because
                              "expires tomorrow" and "expired in 2001" are
                              different things to know. */}
                          {status === "revoked" ? (
                            <Revoked title={formatDateTime(key.revokedAt ?? 0)}>
                              <Chip>revoked</Chip>
                            </Revoked>
                          ) : status === "expired" ? (
                            <Chip $tone="down">expired</Chip>
                          ) : (
                            <Chip $tone="ok">active</Chip>
                          )}
                          {key.expiresAt === null ? null : (
                            <Expires>
                              {status === "expired" ? "expired" : "expires"}{" "}
                              {formatDateTime(key.expiresAt)}
                            </Expires>
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
                                {/* Offered on an expired key too — the gate
                                    above is on revocation, which is the one-way
                                    door. Moving the date forward or clearing it
                                    is the way back, so it must stay reachable. */}
                                <IconButton
                                  type="button"
                                  $variant="ghost"
                                  $size="sm"
                                  aria-label={`Edit expiry for ${key.label}`}
                                  title={`Edit expiry for ${key.label}`}
                                  onClick={() => setEditingExpiry(key)}
                                >
                                  <CalendarClock />
                                </IconButton>
                                {/* Saved the moment it moves, like no other
                                    control on this row: it is one boolean with
                                    nothing to compose, so a dialog would only
                                    be a confirmation of a click. */}
                                <Toggle
                                  checked={key.smartRouting}
                                  disabled={smartRouting.isPending}
                                  label={`Confidential routing for ${key.label}`}
                                  onCheckedChange={(enabled) => {
                                    setSmartFailure(null);
                                    smartRouting.mutate(
                                      { id: key.id, enabled },
                                      {
                                        onError: (error) =>
                                          setSmartFailure(
                                            `Could not change confidential routing for "${key.label}": ${describeError(error)}`,
                                          ),
                                      },
                                    );
                                  }}
                                />
                                <IconButton
                                  type="button"
                                  $variant="ghost"
                                  $size="sm"
                                  aria-label={`Edit usage policy for ${key.label}`}
                                  title={`Edit usage policy for ${key.label}`}
                                  onClick={() => setEditingPolicy(key)}
                                >
                                  <ShieldCheck />
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
                          <Td colSpan={9}>
                            <LimitMatrix label={key.label} readings={key.limitUsage} />
                          </Td>
                        </Tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </FillScroller>
        )}
      </FillModule>

      <MintKeyDialog open={minting} onOpenChange={setMinting} />

      {/* Keyed by the row, so opening a second key starts from that key's
          matrix rather than from whatever was typed into the last one. */}
      <EditLimitsDialog
        key={editing?.id ?? "limits-none"}
        apiKey={editing}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
      />

      {/* Keyed by the row, same reason as the limits dialog: opening a second
          key starts from that key's allowlist rather than whatever was checked
          into the last one. */}
      <EditModelsDialog
        key={editingModels?.id ?? "models-none"}
        apiKey={editingModels}
        onOpenChange={(next) => {
          if (!next) setEditingModels(null);
        }}
      />

      {/* Keyed by the row, same reason as the two dialogs above. */}
      <EditExpiryDialog
        key={editingExpiry?.id ?? "expiry-none"}
        apiKey={editingExpiry}
        onOpenChange={(next) => {
          if (!next) setEditingExpiry(null);
        }}
      />

      {/* Keyed by the row, same reason as the dialogs above. */}
      <EditGuardrailDialog
        key={editingPolicy?.id ?? "policy-none"}
        apiKey={editingPolicy}
        onOpenChange={(next) => {
          if (!next) setEditingPolicy(null);
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
