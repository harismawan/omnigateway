import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import styled from "styled-components";
import {
  useCredentialHealth,
  useCredentials,
  useDeleteCredential,
  useSettings,
  useUpdateCredential,
} from "../../api/queries.ts";
import type { Credential, ProviderId } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatMs, formatRelative } from "../../lib/format.ts";
import {
  credentialStatus,
  groupBy,
  quotaLegend,
  quotaUsage,
  WINDOW_LABEL,
} from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Input, NumberInput } from "../../ui/Field.tsx";
import { Lamp } from "../../ui/Lamp.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Row, ScrollX, Stack } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { ConnectDialog } from "./ConnectDialog.tsx";

const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai", "kimi", "custom"];

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  kimi: "Kimi",
  custom: "OpenAI Compatible",
};

/** Carries the provider's identity on the module edge, so the tables need not. */
const ProviderModule = styled(Module)<{ $provider: ProviderId }>`
  border-left: 3px solid ${({ theme, $provider }) => theme.provider[$provider]};
`;

const LabelInput = styled(Input)`
  width: 100%;
  min-width: 140px;
  height: 26px;
  font-family: ${({ theme }) => theme.font.sans};
  font-size: 12.5px;
  background: transparent;
  border-color: transparent;

  &:hover:not(:disabled),
  &:focus {
    background: ${({ theme }) => theme.color.panelSunk};
    border-color: ${({ theme }) => theme.color.ruleStrong};
  }
`;

const Small = styled(NumberInput)`
  width: 62px;
  height: 26px;
`;

/** The fault in words, under the label, so the lamp is never the only signal. */
const Note = styled.span`
  display: block;
  padding-left: 9px;
  font-size: 11px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const QuotaCell = styled.div`
  display: grid;
  grid-template-columns: 96px 1fr;
  align-items: center;
  min-width: 208px;
  gap: 6px;
`;

/** One row per reported window, shortest first. */
const QuotaStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

/**
 * A row commits on blur rather than on every keystroke, so a mistyped tier does
 * not reshuffle the pool mid-edit.
 */
function useCommit() {
  const update = useUpdateCredential();
  return {
    pending: update.isPending,
    commit: (id: string, patch: Parameters<typeof update.mutate>[0]["patch"]) => {
      update.mutate({ id, patch });
    },
  };
}

export function AccountsBoard() {
  const { cadence } = useLive();
  const credentials = useCredentials();
  const health = useCredentialHealth(cadence(10_000));
  // Only for reading how old a snapshot may be before it stops being current.
  const settings = useSettings();
  const remove = useDeleteCredential();
  const { commit } = useCommit();

  const [connecting, setConnecting] = useState(false);
  const [doomed, setDoomed] = useState<Credential | null>(null);

  const now = Date.now();
  const rows = credentials.data ?? [];
  const healthByCredential = groupBy(health.data?.health ?? [], (row) => row.credentialId);
  const quotaByCredential = groupBy(health.data?.quota ?? [], (row) => row.credentialId);
  const pollIntervalMs = settings.data?.quotaPollIntervalMs ?? 300_000;

  const enabledCount = rows.filter((row) => row.enabled).length;
  const summary = credentials.isLoading
    ? "Reading connected accounts…"
    : rows.length === 0
      ? "No provider credentials are connected, so every request fails at the router."
      : `${enabledCount} of ${rows.length} accounts are enabled and eligible for routing.`;

  return (
    <>
      <PageHead
        legend="Accounts"
        title="Provider accounts"
        summary={summary}
        actions={
          <Button type="button" $variant="primary" onClick={() => setConnecting(true)}>
            <Plus />
            Connect an account
          </Button>
        }
      />

      {credentials.isError ? (
        <Module legend="Accounts">
          <Failure error={credentials.error} onRetry={() => void credentials.refetch()} />
        </Module>
      ) : credentials.isLoading ? (
        <Module legend="Accounts">
          <SkeletonRows rows={5} />
        </Module>
      ) : rows.length === 0 ? (
        <Module legend="Accounts">
          <Empty
            legend="Nothing connected"
            message="Connect a provider account to give the router something to dispatch to. Tokens are encrypted at rest and never shown again."
            action={
              <Button
                type="button"
                $variant="primary"
                $size="sm"
                onClick={() => setConnecting(true)}
              >
                Connect an account
              </Button>
            }
          />
        </Module>
      ) : (
        <Stack $gap={4}>
          {PROVIDER_ORDER.filter((provider) => rows.some((row) => row.provider === provider)).map(
            (provider) => {
              const group = rows.filter((row) => row.provider === provider);
              return (
                <ProviderModule
                  key={provider}
                  $provider={provider}
                  legend={PROVIDER_LABEL[provider]}
                  meta={`${group.length} account${group.length === 1 ? "" : "s"}`}
                  flush
                >
                  <ScrollX>
                    {/* Fixed widths so the three provider tables line up as one list. */}
                    <Table>
                      <thead>
                        <tr>
                          <Th $width="24%">Account</Th>
                          <Th $width="20%">Sign-in</Th>
                          <Th $align="right" $width="86px">
                            Tier
                          </Th>
                          <Th $align="right" $width="94px">
                            Weight
                          </Th>
                          <Th $align="center" $width="86px">
                            Enabled
                          </Th>
                          <Th $width="240px">Quota</Th>
                          <Th $align="right" $width="88px">
                            TTFT
                          </Th>
                          <Th $align="right" $width="130px">
                            Token expires
                          </Th>
                          <Th $width="48px" />
                        </tr>
                      </thead>
                      <tbody>
                        {group.map((credential) => {
                          const status = credentialStatus(
                            healthByCredential.get(credential.id) ?? [],
                            now,
                            credential.enabled,
                            credential.disabledReason,
                          );
                          const windows = quotaUsage(quotaByCredential.get(credential.id) ?? []);
                          return (
                            <Tr key={credential.id}>
                              <Td>
                                <Row $gap={2}>
                                  <Lamp
                                    state={status.state}
                                    label={status.note === "" ? "healthy" : status.note}
                                  />
                                  <LabelInput
                                    defaultValue={credential.label}
                                    aria-label={`Label for ${credential.label}`}
                                    onBlur={(event) => {
                                      const next = event.target.value.trim();
                                      if (next.length === 0 || next === credential.label) {
                                        event.target.value = credential.label;
                                        return;
                                      }
                                      commit(credential.id, { label: next });
                                    }}
                                  />
                                </Row>
                                {status.note === "" ? null : <Note>{status.note}</Note>}
                              </Td>
                              <Td>
                                <Row $gap={1}>
                                  <Chip>
                                    {credential.authType === "oauth" ? "oauth" : "api key"}
                                  </Chip>
                                  {credential.accountEmail === null ? null : (
                                    <Legend>{credential.accountEmail}</Legend>
                                  )}
                                </Row>
                              </Td>
                              <Td $align="right">
                                <Small
                                  min={1}
                                  step={1}
                                  defaultValue={credential.tier}
                                  aria-label={`Tier for ${credential.label}`}
                                  onBlur={(event) => {
                                    const next = Number(event.target.value);
                                    if (
                                      !Number.isInteger(next) ||
                                      next < 1 ||
                                      next === credential.tier
                                    ) {
                                      event.target.value = String(credential.tier);
                                      return;
                                    }
                                    commit(credential.id, { tier: next });
                                  }}
                                />
                              </Td>
                              <Td $align="right">
                                <Small
                                  min={0.1}
                                  step={0.1}
                                  defaultValue={credential.weight}
                                  aria-label={`Weight for ${credential.label}`}
                                  onBlur={(event) => {
                                    const next = Number(event.target.value);
                                    if (
                                      !Number.isFinite(next) ||
                                      next <= 0 ||
                                      next === credential.weight
                                    ) {
                                      event.target.value = String(credential.weight);
                                      return;
                                    }
                                    commit(credential.id, { weight: next });
                                  }}
                                />
                              </Td>
                              <Td $align="center">
                                <Toggle
                                  checked={credential.enabled}
                                  label={`Route to ${credential.label}`}
                                  onCheckedChange={(enabled) => commit(credential.id, { enabled })}
                                />
                              </Td>
                              <Td>
                                {windows.length === 0 ? (
                                  // Quota is what the provider reported. Nothing
                                  // reported is not the same claim as no limit.
                                  <Legend>unknown</Legend>
                                ) : (
                                  <QuotaStack>
                                    {windows.map(({ window, fraction }) => (
                                      <QuotaCell key={window.windowType}>
                                        <Meter
                                          fraction={fraction}
                                          label={`${WINDOW_LABEL[window.windowType]} window, ${Math.round(fraction * 100)}% used`}
                                        />
                                        <Legend>
                                          {quotaLegend(window, now, pollIntervalMs, formatRelative)}
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
                                {credential.expiresAt === null
                                  ? "never"
                                  : formatRelative(credential.expiresAt, now)}
                              </Td>
                              <Td $align="right">
                                <IconButton
                                  type="button"
                                  $variant="ghost"
                                  $size="sm"
                                  aria-label={`Remove ${credential.label}`}
                                  title={`Remove ${credential.label}`}
                                  onClick={() => setDoomed(credential)}
                                >
                                  <Trash2 />
                                </IconButton>
                              </Td>
                            </Tr>
                          );
                        })}
                      </tbody>
                    </Table>
                  </ScrollX>
                </ProviderModule>
              );
            },
          )}
        </Stack>
      )}

      <ConnectDialog
        open={connecting}
        credentials={credentials.data ?? []}
        onOpenChange={setConnecting}
        onConnected={() => void credentials.refetch()}
      />

      <Confirm
        open={doomed !== null}
        onOpenChange={(next) => {
          if (!next) setDoomed(null);
        }}
        title="Remove account"
        body={
          doomed === null
            ? ""
            : `Removing "${doomed.label}" deletes its stored token. Any model target pointing at ${PROVIDER_LABEL[doomed.provider]} loses this account, and reconnecting means authorizing again.`
        }
        confirmLabel="Remove account"
        busy={remove.isPending}
        onConfirm={() => {
          if (doomed === null) return;
          remove.mutate(doomed.id, { onSettled: () => setDoomed(null) });
        }}
      />
    </>
  );
}
