import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Fragment, useState } from "react";
import styled from "styled-components";
import {
  findProvider,
  useCredentialHealth,
  useCredentials,
  useDeleteCredential,
  useIsAdmin,
  useModels,
  useProviderCatalog,
  useRefreshQuota,
  useSettings,
  useUpdateCredential,
} from "../../api/queries.ts";
import type {
  Credential,
  ProviderId,
  QuotaRefreshOutcome,
  QuotaRefreshRequest,
  VirtualModel,
} from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatPercent, formatRelative } from "../../lib/format.ts";
import {
  burnOf,
  credentialStatus,
  groupBy,
  quotaLegend,
  quotaUsage,
  WINDOW_LABEL,
} from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { providerColor } from "../../theme/tokens.ts";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Input, NumberInput } from "../../ui/Field.tsx";
import { Lamp } from "../../ui/Lamp.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Row, ScrollX, Stack } from "../../ui/primitives.ts";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { Toggle } from "../../ui/Toggle.tsx";
import { ConnectDialog } from "./ConnectDialog.tsx";
import { QuotaHistory } from "./QuotaHistory.tsx";

/** Carries the provider's identity on the module edge, so the tables need not. */
const ProviderModule = styled(Module)<{ $provider: ProviderId }>`
  border-left: 3px solid ${({ $provider }) => providerColor($provider)};
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

/**
 * Where a refresh reports what it did.
 *
 * Always mounted, empty when there is nothing to say: a region that appears
 * with its first message is one a screen reader may not be watching yet. Height
 * is not reserved, so an empty one costs a line and nothing moves under it.
 */
const StatusNote = styled.p`
  margin: 0 0 10px;
  min-height: 16px;
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
`;

const QuotaCell = styled.div`
  display: grid;
  /* Bar, figure, legend. The figure has a column of its own so the legends stay
     aligned down the stack whether a window reads 4% or 100%. */
  grid-template-columns: 96px 34px 1fr;
  align-items: center;
  min-width: 208px;
  gap: 6px;
`;

/** The reading the bar draws, in words, for anyone reading the number instead. */
const Percent = styled(Mono)`
  font-size: 11px;
  text-align: right;
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

/**
 * What removing an account does to the targets pinned to it, or "" for none.
 *
 * The sentence above this one says a target "loses this account", which is true
 * of an unpinned target and wrong about a pinned one: a pin has no fallback, so
 * every request for that target starts failing the moment the account is gone.
 * Naming the models is the difference between a warning an operator can act on
 * and one they can only agree to.
 */
function pinnedWarning(doomed: Credential, models: readonly VirtualModel[] | undefined): string {
  // Undefined is "the model list has not arrived", which is not the same as
  // "nothing is pinned" and must not render as it. The removal is irreversible
  // and the pinned targets it breaks have no fallback, so an unanswered
  // question is said out loud rather than silently resolved to the reassuring
  // answer.
  if (models === undefined) {
    return " The list of models could not be read, so whether any target is pinned to this account is unknown.";
  }
  const pinned = models
    .filter((model) => model.targets.some((target) => target.credentialId === doomed.id))
    .map((model) => model.id);
  if (pinned.length === 0) return "";
  return (
    ` ${pinned.length === 1 ? "The model" : "The models"} ${pinned.join(", ")} ` +
    `${pinned.length === 1 ? "pins a target" : "pin targets"} to this account. ` +
    "Those targets will fail rather than fall back to another account."
  );
}

export function AccountsBoard() {
  const { cadence } = useLive();
  const credentials = useCredentials();
  const health = useCredentialHealth(cadence(10_000, "res:credentials"));
  // Only for reading how old a snapshot may be before it stops being current.
  const settings = useSettings();
  // Only to name the models that pin a target to the account being removed.
  // Those targets do not fall back to a sibling — they hard-fail — so removal
  // is destructive to them in a way it is not to an unpinned target.
  const models = useModels();
  const catalogQuery = useProviderCatalog();
  const remove = useDeleteCredential();
  const refresh = useRefreshQuota();
  const isAdmin = useIsAdmin();
  const { commit } = useCommit();

  const [connecting, setConnecting] = useState(false);
  /**
   * What the last refresh did, in the operator's words.
   *
   * Held rather than derived from the mutation, because the mutation forgets
   * the account as soon as the next row is pressed and this is the only place
   * an outcome that changed nothing — cooling down, no data, unsupported — is
   * ever reported. Cleared when a new request starts.
   */
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  /** Which single account is refreshing, so the other rows stay usable. */
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [doomed, setDoomed] = useState<Credential | null>(null);
  // Which rows have their history open. Local to the board: an expansion is a
  // glance at one account, not a preference worth outliving the visit.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const rows = credentials.data ?? [];
  const labelFor = (id: string): string => rows.find((row) => row.id === id)?.label ?? id;

  /** One operation's outcomes as one sentence. Host phrasing, never upstream text. */
  const describeRefresh = (outcomes: QuotaRefreshOutcome[]): string => {
    const only = outcomes[0];
    if (outcomes.length === 1 && only !== undefined) {
      const account = labelFor(only.credentialId);
      return only.kind === "refreshed" || only.kind === "coalesced"
        ? `Quota refreshed for ${account}.`
        : only.kind === "noData"
          ? `No quota data reported for ${account}.`
          : only.kind === "cooldown"
            ? `Quota refresh is cooling down for ${account}.`
            : only.kind === "unsupported"
              ? `${account} does not report quota.`
              : only.kind === "disabled"
                ? `${account} is disabled, so it was not probed.`
                : `Quota refresh failed for ${account}.`;
    }
    const refreshed = outcomes.filter(
      (o) => o.kind === "refreshed" || o.kind === "coalesced",
    ).length;
    const failed = outcomes.filter((o) => o.kind === "failed").length;
    const cooling = outcomes.filter((o) => o.kind === "cooldown").length;
    const skipped = outcomes.length - refreshed - failed - cooling;
    return [
      `Refreshed ${refreshed} ${refreshed === 1 ? "account" : "accounts"}`,
      failed === 0 ? null : `${failed} failed`,
      cooling === 0 ? null : `${cooling} cooling down`,
      skipped === 0 ? null : `${skipped} skipped`,
    ]
      .filter((part) => part !== null)
      .join("; ")
      .concat(".");
  };

  const runRefresh = async (request: QuotaRefreshRequest): Promise<void> => {
    setRefreshNote(null);
    if (request.kind === "all") setRefreshingAll(true);
    else setRefreshingId(request.credentialId);
    try {
      const result = await refresh.mutateAsync(request);
      setRefreshNote(describeRefresh(result.outcomes));
    } catch (error) {
      // The request itself did not land. The meters keep whatever they were
      // showing — a failed refresh never blanks a reading.
      setRefreshNote(
        request.kind === "all"
          ? "Quota refresh could not be started."
          : `Quota refresh could not be started for ${labelFor(request.credentialId)}.`,
      );
      void error;
    } finally {
      setRefreshingAll(false);
      setRefreshingId(null);
    }
  };

  const now = Date.now();
  // Loaded before this screen mounts, by the gate in `routes/_app.tsx`.
  const catalog = catalogQuery.data ?? [];
  // The catalog decides the order, the connected accounts decide the set. Built
  // from the rows rather than by filtering the catalog so a provider the
  // catalog no longer names — one whose plugin was removed — still shows the
  // accounts held for it instead of dropping them off the board silently.
  const rank = (provider: ProviderId): number =>
    findProvider(catalog, provider)?.order ?? Number.POSITIVE_INFINITY;
  const providers = [...new Set(rows.map((row) => row.provider))].sort((a, b) => rank(a) - rank(b));
  const labelOf = (provider: ProviderId): string =>
    findProvider(catalog, provider)?.label ?? provider;
  const healthByCredential = groupBy(health.data?.health ?? [], (row) => row.credentialId);
  const quotaByCredential = groupBy(health.data?.quota ?? [], (row) => row.credentialId);
  const burnByCredential = groupBy(health.data?.burn ?? [], (row) => row.credentialId);
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
          <Row $gap={1}>
            {isAdmin ? (
              <Button
                type="button"
                $variant="ghost"
                disabled={refreshingAll || refreshingId !== null}
                onClick={() => void runRefresh({ kind: "all" })}
              >
                <RefreshCw />
                {refreshingAll ? "Refreshing quota…" : "Refresh all quota"}
              </Button>
            ) : null}
            <Button type="button" $variant="primary" onClick={() => setConnecting(true)}>
              <Plus />
              Connect an account
            </Button>
          </Row>
        }
      />

      {/*
        One region for the whole operation, near the controls that caused it.
        `role="status"` rather than an alert: a refresh that reported nothing
        useful is information, not an interruption, and a bulk result is one
        announcement rather than one per account.
      */}
      <StatusNote role="status" aria-live="polite">
        {refreshNote ?? ""}
      </StatusNote>

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
          {providers.map((provider) => {
            const group = rows.filter((row) => row.provider === provider);
            return (
              <ProviderModule
                key={provider}
                $provider={provider}
                legend={labelOf(provider)}
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
                        <Th $align="right" $width="130px">
                          Token expires
                        </Th>
                        <Th $width="112px" />
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
                        const reported = quotaByCredential.get(credential.id) ?? [];
                        const estimates = burnByCredential.get(credential.id) ?? [];
                        const windows = quotaUsage(reported);
                        const open = expanded.has(credential.id);
                        return (
                          <Fragment key={credential.id}>
                            <Tr>
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
                                        {/* Whole percent: the bar is the
                                              comparison and this is the
                                              reading, and a decimal here would
                                              be precision the probe interval
                                              does not have. */}
                                        <Percent>{formatPercent(fraction, 0)}</Percent>
                                        <Legend>
                                          {quotaLegend(
                                            window,
                                            now,
                                            pollIntervalMs,
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
                                {credential.expiresAt === null
                                  ? "never"
                                  : formatRelative(credential.expiresAt, now)}
                              </Td>
                              <Td $align="right">
                                <Row $gap={1} $justify="flex-end">
                                  {/* Nothing reported is nothing to chart, so the
                                        control is absent rather than opening onto
                                        an empty panel. */}
                                  {reported.length === 0 ? null : (
                                    <IconButton
                                      type="button"
                                      $variant="ghost"
                                      $size="sm"
                                      aria-expanded={open}
                                      aria-label={`${open ? "Hide" : "Show"} quota history for ${credential.label}`}
                                      title={`${open ? "Hide" : "Show"} quota history for ${credential.label}`}
                                      onClick={() => toggle(credential.id)}
                                    >
                                      {open ? <ChevronDown /> : <ChevronRight />}
                                    </IconButton>
                                  )}
                                  {isAdmin ? (
                                    <IconButton
                                      type="button"
                                      $variant="ghost"
                                      $size="sm"
                                      disabled={refreshingAll || refreshingId !== null}
                                      aria-label={`Refresh quota for ${credential.label}`}
                                      title={`Refresh quota for ${credential.label}`}
                                      onClick={() =>
                                        void runRefresh({
                                          kind: "one",
                                          credentialId: credential.id,
                                        })
                                      }
                                    >
                                      <RefreshCw />
                                    </IconButton>
                                  ) : null}
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
                                </Row>
                              </Td>
                            </Tr>
                            {open ? (
                              <Tr>
                                <Td colSpan={9}>
                                  <QuotaHistory
                                    credentialId={credential.id}
                                    windows={reported}
                                    burn={estimates}
                                    pollIntervalMs={pollIntervalMs}
                                    now={now}
                                  />
                                </Td>
                              </Tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </Table>
                </ScrollX>
              </ProviderModule>
            );
          })}
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
            : `Removing "${doomed.label}" deletes its stored token. Any model target pointing at ${labelOf(doomed.provider)} loses this account, and reconnecting means authorizing again.` +
              pinnedWarning(doomed, models.data)
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
