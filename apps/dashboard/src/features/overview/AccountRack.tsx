import { Link } from "@tanstack/react-router";
import styled from "styled-components";
import type {
  BurnEstimate,
  Credential,
  CredentialHealth,
  QuotaWindow,
  UsageBucket,
} from "../../api/types.ts";
import { formatCount, formatMs, formatRelative } from "../../lib/format.ts";
import {
  burnOf,
  credentialStatus,
  groupBy,
  type LampState,
  quotaLegend,
  quotaUsage,
  WINDOW_LABEL,
} from "../../lib/vitals.ts";
import { Button } from "../../ui/Button.tsx";
import { ProviderTag } from "../../ui/Chip.tsx";
import { Lamp } from "../../ui/Lamp.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, ScrollX, Truncate } from "../../ui/primitives.ts";
import { Empty } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";

const Label = styled(Truncate)`
  font-weight: 500;
  display: block;
  max-width: 24ch;
`;

const Note = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const QuotaCell = styled.div`
  display: grid;
  grid-template-columns: 72px 1fr;
  align-items: center;
  gap: 6px;
  min-width: 172px;
`;

/** One row per reported window, shortest first. */
const QuotaStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

export type AccountRackProps = {
  credentials: readonly Credential[];
  health: readonly CredentialHealth[];
  quota: readonly QuotaWindow[];
  /** What each window's reading implies, rendered inside the shared legend. */
  burn: readonly BurnEstimate[];
  /** Usage grouped by credential; the key is the credential id. */
  usage: readonly UsageBucket[];
  /** Poll interval, so a reading can be called stale on the same rule everywhere. */
  quotaPollIntervalMs: number;
  now: number;
};

/**
 * Every credential as one line of an equipment list: lamp, identity, the quota
 * window closest to blocking, observed latency, and how much traffic it took.
 * Sorted worst-first, because a healthy pool is not what needs reading.
 */
export function AccountRack({
  credentials,
  health,
  quota,
  burn,
  usage,
  quotaPollIntervalMs,
  now,
}: AccountRackProps) {
  const healthByCredential = groupBy(health, (row) => row.credentialId);
  const quotaByCredential = groupBy(quota, (row) => row.credentialId);
  const burnByCredential = groupBy(burn, (row) => row.credentialId);
  const usageByCredential = new Map(usage.map((row) => [row.key, row]));

  // `live` belongs to a request in flight, never to an account; it is listed
  // only so the record covers every LampState.
  const rank: Readonly<Record<LampState, number>> = { down: 0, warn: 1, ok: 2, idle: 3, live: 3 };
  const rows = credentials
    .map((credential) => ({
      credential,
      status: credentialStatus(
        healthByCredential.get(credential.id) ?? [],
        now,
        credential.enabled,
        credential.disabledReason,
      ),
      quota: quotaUsage(quotaByCredential.get(credential.id) ?? []),
      burn: burnByCredential.get(credential.id) ?? [],
      usage: usageByCredential.get(credential.id),
    }))
    // Lamp state, then tier. Burn rate is deliberately not a third key: an
    // account at 40% draining fast may well be worse than one at 80% sitting
    // idle, but deciding that changes what this list is for.
    .sort(
      (a, b) =>
        rank[a.status.state] - rank[b.status.state] || a.credential.tier - b.credential.tier,
    );

  return (
    <Module
      legend="Accounts"
      meta={`${credentials.length} connected`}
      flush
      actions={
        <Button as={Link} to="/accounts" $size="sm">
          Manage accounts
        </Button>
      }
    >
      {credentials.length === 0 ? (
        <Empty
          legend="No accounts"
          message="The gateway has no provider credentials, so every request will fail. Connect one to start routing."
          action={
            <Button as={Link} to="/accounts" $variant="primary" $size="sm">
              Connect an account
            </Button>
          }
        />
      ) : (
        <ScrollX>
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Provider</Th>
                <Th $align="right">Tier</Th>
                <Th>Quota</Th>
                <Th $align="right">TTFT</Th>
                <Th $align="right">Requests</Th>
                <Th $align="right">Last used</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ credential, status, quota: windows, burn: estimates, usage: used }) => (
                <Tr key={credential.id}>
                  <Td>
                    <Row $gap={2}>
                      <Lamp
                        state={status.state}
                        label={status.note === "" ? "healthy" : status.note}
                      />
                      <div>
                        <Label>{credential.label}</Label>
                        {status.note === "" ? null : <Note>{status.note}</Note>}
                      </div>
                    </Row>
                  </Td>
                  <Td>
                    <ProviderTag provider={credential.provider} />
                  </Td>
                  <Td $align="right" $mono>
                    {credential.tier}
                  </Td>
                  <Td>
                    {windows.length === 0 ? (
                      <Note>unknown</Note>
                    ) : (
                      <QuotaStack>
                        {windows.map(({ window, fraction }) => (
                          <QuotaCell key={window.windowType}>
                            <Meter
                              fraction={fraction}
                              label={`${WINDOW_LABEL[window.windowType]} window, ${Math.round(fraction * 100)}% used`}
                            />
                            <Legend>
                              {quotaLegend(
                                window,
                                now,
                                quotaPollIntervalMs,
                                formatRelative,
                                burnOf(estimates, window.windowType),
                              )}
                            </Legend>
                          </QuotaCell>
                        ))}
                      </QuotaStack>
                    )}
                  </Td>
                  <Td $align="right" $mono>
                    {formatMs(status.ttftMs)}
                  </Td>
                  <Td $align="right" $mono>
                    {used === undefined ? "—" : formatCount(used.requests)}
                  </Td>
                  <Td $align="right" $mono>
                    {formatRelative(status.lastUsedAt, now)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </ScrollX>
      )}
    </Module>
  );
}
