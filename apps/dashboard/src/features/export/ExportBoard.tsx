import { Pencil, Plus, Send, SkipForward, Trash2, TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";
import styled from "styled-components";
import {
  useAcknowledgeExportGap,
  useExportDestinations,
  useExportPreview,
  useIsAdmin,
  useRemoveExportDestination,
  useSkipExportDestination,
  useTestExportDestination,
  useUpdateExportDestination,
} from "../../api/queries.ts";
import type {
  ExportDestinationView,
  ExportTestResult,
  ExportWorkerState,
} from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatDateTime, formatDuration, formatRelative } from "../../lib/format.ts";
import { useLive } from "../../session/live.tsx";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Field, Input } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, ScrollX, Stack, Truncate } from "../../ui/primitives.ts";
import { describeError, Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { ExportEditor } from "./ExportEditor.tsx";

const Banner = styled.p`
  padding: 0 ${({ theme }) => theme.space(2)};
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};
`;

const Notice = styled.p<{ $ok: boolean }>`
  padding: 0 ${({ theme }) => theme.space(2)};
  font-size: 12px;
  color: ${({ theme, $ok }) => ($ok ? theme.color.ok : theme.color.down)};
`;

const Gap = styled(Row)`
  font-size: 12px;
  color: ${({ theme }) => theme.color.warn};

  svg {
    width: 14px;
    height: 14px;
    flex: none;
  }
`;

const Faint = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const RecordText = styled.pre`
  margin: 0;
  padding: ${({ theme }) => theme.space(2)};
  max-height: 360px;
  overflow: auto;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: 3px;
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 11.5px;
  white-space: pre-wrap;
  word-break: break-word;
`;

/**
 * Why the worker cannot act, in the operator's words, or null when it can.
 *
 * Every state but `running` answers test, preview, skip and acknowledge with
 * 503, so each is named; `idle` with destinations is the short wait before the
 * gateway's idle re-check starts one for a destination added elsewhere.
 */
function workerNotice(state: ExportWorkerState, destinations: number): string | null {
  switch (state) {
    case "running":
      return null;
    case "idle":
      return destinations === 0
        ? null
        : "The export worker is not running yet; the gateway starts it within half a minute.";
    case "restarting":
      return "The export worker stopped unexpectedly and is restarting. Nothing is exported until it is back.";
    case "down":
      return "The export worker stopped after failing repeatedly and is not restarting on its own. Change a destination or restart the gateway to try again.";
    case "paused":
      return "Export is paused while the database is being restored or imported.";
    case "halted":
      return "Export is halted because a database restore failed part-way. A successful restore or a gateway restart brings it back.";
    case "stopping":
      return "The previous export worker has not exited yet; export resumes on its own once it does.";
    case "stopped":
      return "The gateway is shutting down, so export has stopped.";
  }
}

/** Where a destination sends. */
function targetOf(d: ExportDestinationView): string {
  const value = d.type === "otlp" ? d.config.endpoint : d.config.url;
  return typeof value === "string" ? value : "—";
}

function describeTest(result: ExportTestResult): { ok: boolean; text: string } {
  if (result.ok) {
    return {
      ok: true,
      text: `Test record accepted: HTTP ${result.status} in ${Math.round(result.latencyMs)}ms`,
    };
  }
  return { ok: false, text: `Test failed: ${result.error}` };
}

/**
 * Log export: where completed requests are sent, and how each destination is
 * doing. Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Surfaces → Console*).
 *
 * Configuration reads and writes go through `/api/export/destinations`; test,
 * skip, preview and the gap acknowledgement are performed by the gateway's
 * export worker, so they are disabled whenever it is not `running` — the
 * banner says why. A secret is never shown: only whether one is set.
 */
export function ExportBoard() {
  const { cadence } = useLive();
  const read = useExportDestinations(cadence(10_000, "res:export"));
  const isAdmin = useIsAdmin();
  const update = useUpdateExportDestination();
  const test = useTestExportDestination();
  const skip = useSkipExportDestination();
  const ack = useAcknowledgeExportGap();
  const remove = useRemoveExportDestination();
  const preview = useExportPreview();

  const [editing, setEditing] = useState<ExportDestinationView | "new" | null>(null);
  const [skipping, setSkipping] = useState<ExportDestinationView | null>(null);
  const [doomed, setDoomed] = useState<ExportDestinationView | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [requestId, setRequestId] = useState("");

  const destinations = read.data?.destinations ?? [];
  const state = read.data?.worker.state;
  const running = state === "running";
  const banner = state === undefined ? null : workerNotice(state, destinations.length);
  const failed = (error: unknown) => setNotice({ ok: false, text: describeError(error) });

  const summary = read.isLoading
    ? "Reading export destinations…"
    : destinations.length === 0
      ? "Nothing is exported. Add a destination to send each completed request's log record to Elasticsearch, a webhook, or an OTLP collector."
      : `${destinations.filter((d) => d.enabled).length} of ${destinations.length} destination${destinations.length === 1 ? "" : "s"} enabled. Bodies are never exported.`;

  return (
    <>
      <PageHead
        legend="Export"
        title="Log export"
        summary={summary}
        actions={
          isAdmin ? (
            <Button type="button" $variant="primary" onClick={() => setEditing("new")}>
              <Plus />
              Add a destination
            </Button>
          ) : undefined
        }
      />

      {banner === null ? null : (
        <Banner role="status" aria-label="Export worker">
          {banner}
        </Banner>
      )}
      {notice === null ? null : (
        <Notice role={notice.ok ? "status" : "alert"} $ok={notice.ok}>
          {notice.text}
        </Notice>
      )}

      <Module legend="Destinations" meta={`${destinations.length}`} flush>
        {read.isError ? (
          <Failure error={read.error} onRetry={() => void read.refetch()} />
        ) : read.isLoading ? (
          <div style={{ padding: 12 }}>
            <SkeletonRows rows={3} />
          </div>
        ) : destinations.length === 0 ? (
          <Empty
            legend="No destinations"
            message="Each destination receives every completed request's metadata — model, tokens, cost, timing, errors — never prompts or responses."
            action={
              isAdmin ? (
                <Button
                  type="button"
                  $variant="primary"
                  $size="sm"
                  onClick={() => setEditing("new")}
                >
                  Add the first destination
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ScrollX>
            <Table>
              <thead>
                <tr>
                  <Th>Destination</Th>
                  <Th>Type</Th>
                  <Th>Sends to</Th>
                  <Th>Enabled</Th>
                  <Th $align="right">Lag</Th>
                  <Th>Last success</Th>
                  <Th>Last error</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {destinations.map((d) => {
                  const s = d.status;
                  const gapAt = s?.gapPossibleAt ?? null;
                  return (
                    <Fragment key={d.id}>
                      <Tr>
                        <Td $mono>{d.id}</Td>
                        <Td>
                          <Chip>{d.type}</Chip>
                        </Td>
                        <Td>
                          <Stack $gap={0.5}>
                            <Truncate style={{ maxWidth: "36ch", display: "block" }}>
                              {targetOf(d)}
                            </Truncate>
                            {d.filterMalformed ? (
                              <Chip $tone="down">filter unreadable: exports nothing</Chip>
                            ) : null}
                          </Stack>
                        </Td>
                        <Td>
                          <Toggle
                            checked={d.enabled}
                            label={`Export to ${d.id}`}
                            disabled={
                              !isAdmin || (update.isPending && update.variables?.id === d.id)
                            }
                            onCheckedChange={(enabled) =>
                              update.mutate({ id: d.id, patch: { enabled } }, { onError: failed })
                            }
                          />
                        </Td>
                        <Td $align="right" $mono>
                          {s?.lagMs == null ? "—" : formatDuration(s.lagMs)}
                        </Td>
                        <Td>
                          <span title={formatDateTime(s?.lastSuccessAt)}>
                            {formatRelative(s?.lastSuccessAt ?? null)}
                          </span>
                        </Td>
                        <Td>
                          {s?.lastError == null ? (
                            <Legend>—</Legend>
                          ) : (
                            <Stack $gap={0.5}>
                              <Row $gap={1}>
                                {s.failing ? <Chip $tone="down">failing</Chip> : null}
                                <span>{s.lastError}</span>
                              </Row>
                              <Faint>{formatRelative(s.lastErrorAt)}</Faint>
                            </Stack>
                          )}
                        </Td>
                        <Td $align="right">
                          {isAdmin ? (
                            <Row $gap={0.5} $justify="flex-end">
                              <IconButton
                                type="button"
                                $variant="ghost"
                                $size="sm"
                                aria-label={`Send test to ${d.id}`}
                                title={
                                  running
                                    ? `Send test to ${d.id}`
                                    : "The export worker is not running"
                                }
                                disabled={!running || (test.isPending && test.variables === d.id)}
                                onClick={() => {
                                  setNotice(null);
                                  test.mutate(d.id, {
                                    onSuccess: (result) => setNotice(describeTest(result)),
                                    onError: failed,
                                  });
                                }}
                              >
                                <Send />
                              </IconButton>
                              <IconButton
                                type="button"
                                $variant="ghost"
                                $size="sm"
                                aria-label={`Skip ${d.id} to now`}
                                title={
                                  running
                                    ? `Skip ${d.id} to now`
                                    : "The export worker is not running"
                                }
                                disabled={!running}
                                onClick={() => setSkipping(d)}
                              >
                                <SkipForward />
                              </IconButton>
                              <IconButton
                                type="button"
                                $variant="ghost"
                                $size="sm"
                                aria-label={`Edit ${d.id}`}
                                title={`Edit ${d.id}`}
                                onClick={() => setEditing(d)}
                              >
                                <Pencil />
                              </IconButton>
                              <IconButton
                                type="button"
                                $variant="ghost"
                                $size="sm"
                                aria-label={`Remove ${d.id}`}
                                title={`Remove ${d.id}`}
                                onClick={() => setDoomed(d)}
                              >
                                <Trash2 />
                              </IconButton>
                            </Row>
                          ) : null}
                        </Td>
                      </Tr>
                      {gapAt === null ? null : (
                        <Tr>
                          <Td colSpan={8}>
                            <Gap $gap={2}>
                              <TriangleAlert aria-hidden />
                              <span>
                                Since {formatDateTime(gapAt)}, export is within a day of log
                                retention or past it; rows may have been pruned before export.
                              </span>
                              {isAdmin ? (
                                <Button
                                  type="button"
                                  $size="sm"
                                  aria-label={`Acknowledge gap warning for ${d.id}`}
                                  disabled={!running || ack.isPending}
                                  onClick={() =>
                                    ack.mutate({ id: d.id, seenAt: gapAt }, { onError: failed })
                                  }
                                >
                                  Acknowledge
                                </Button>
                              ) : null}
                            </Gap>
                          </Td>
                        </Tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </ScrollX>
        )}
      </Module>

      <Module legend="Preview a record">
        <Stack $gap={2}>
          <Row $gap={2} $align="flex-end">
            <div style={{ flex: 1 }}>
              <Field
                label="Request ID"
                hint="One completed request, as a destination would receive it. Bodies are never part of it."
              >
                {(props) => (
                  <Input
                    {...props}
                    value={requestId}
                    onChange={(event) => setRequestId(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <Button
              type="button"
              disabled={!running || requestId.trim().length === 0 || preview.isPending}
              onClick={() => preview.mutate(requestId.trim())}
            >
              Preview
            </Button>
          </Row>
          {preview.isError ? (
            <Notice role="alert" $ok={false}>
              {describeError(preview.error)}
            </Notice>
          ) : null}
          {preview.data === undefined ? null : (
            <RecordText>{JSON.stringify(preview.data.record, null, 2)}</RecordText>
          )}
        </Stack>
      </Module>

      {editing === null ? null : (
        <ExportEditor
          key={editing === "new" ? "new" : editing.id}
          editing={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}

      <Confirm
        open={skipping !== null}
        onOpenChange={(open) => {
          if (!open) setSkipping(null);
        }}
        title="Skip to now"
        body={
          skipping === null
            ? ""
            : `Everything ${skipping.id} has not sent yet is skipped: it is counted as dropped and never exported. Export continues from now.`
        }
        confirmLabel="Skip to now"
        busy={skip.isPending}
        onConfirm={() => {
          if (skipping === null) return;
          skip.mutate(skipping.id, { onError: failed, onSettled: () => setSkipping(null) });
        }}
      />

      <Confirm
        open={doomed !== null}
        onOpenChange={(open) => {
          if (!open) setDoomed(null);
        }}
        title="Remove destination"
        body={
          doomed === null
            ? ""
            : `Removing ${doomed.id}. What it already sent stays sent; adding it again starts from scratch.`
        }
        confirmLabel="Remove destination"
        busy={remove.isPending}
        onConfirm={() => {
          if (doomed === null) return;
          remove.mutate(doomed.id, { onError: failed, onSettled: () => setDoomed(null) });
        }}
      />
    </>
  );
}
