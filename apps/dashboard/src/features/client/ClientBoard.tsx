import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import styled from "styled-components";
import {
  LOG_CADENCE_MS,
  useClientLogs,
  useClientQuota,
  useClientQuotaHistory,
  useClientSummary,
  useClientUsage,
} from "../../api/queries.ts";
import type { AccountQuota, LimitReading, RequestLog } from "../../api/types.ts";
import { PageHead } from "../../components/Rack.tsx";
import { formatCount, formatPercent, formatRelative, formatUsd } from "../../lib/format.ts";
import {
  isError,
  isPending,
  type QuotaReading,
  type QuotaVerdicts,
  quotaLegendOf,
  WINDOW_ORDER,
} from "../../lib/vitals.ts";
import { useLive } from "../../session/live.tsx";
import { Button, IconButton } from "../../ui/Button.tsx";
import { Input, Select } from "../../ui/Field.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Modal } from "../../ui/Modal.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Muted, Row, ScrollX, Stack } from "../../ui/primitives.ts";
import { Section } from "../../ui/Section.tsx";
import { Controls, Segment } from "../../ui/Segment.tsx";
import { Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { filterLogs, RequestDetail, RequestTable, useCurrentTime } from "../logs/RequestTable.tsx";
import { chartSpanOf, WindowChart } from "../quota/WindowChart.tsx";
import { SummaryDeck } from "../usage/SummaryDeck.tsx";
import { RANGES, type RangeId, rangeOf, startOfDay } from "../usage/shared.ts";

/**
 * How many rows to fetch, shortest first.
 *
 * Twenty by default and never fewer: a client screen is read to answer "what
 * did my last few requests do", and the longer tails are here for the rare walk
 * back through a bad afternoon rather than for the arrival case.
 */
const LIMITS = [20, 50, 100, 250] as const;

type Filter = "all" | "failed";

/** The window a limit is counted over, spelled for a reader rather than a schema. */
const LIMIT_WINDOW_LABEL: Readonly<Record<string, string>> = {
  "1m": "per minute",
  "5h": "per 5 hours",
  "1w": "per week",
};

function LimitRow({ reading }: { reading: LimitReading }) {
  const label =
    reading.window === null
      ? "concurrent requests"
      : `${reading.dimension} ${LIMIT_WINDOW_LABEL[reading.window] ?? reading.window}`;
  const show = reading.dimension === "spend" ? formatUsd : formatCount;
  // A ceiling of zero admits nothing, so it is full rather than undefined.
  const fraction =
    reading.used === null ? null : reading.limit === 0 ? 1 : reading.used / reading.limit;

  return (
    <Tr>
      <Td>{label}</Td>
      <Td $align="right" $mono>
        {/*
          Null is not zero. `concurrency` is a gauge held in the gateway process
          with no row behind it, so rendering 0 would tell a client they have
          nothing in flight when nobody actually knows.
        */}
        {reading.used === null ? <Muted>unknown</Muted> : show(reading.used)}
      </Td>
      <Td $align="right" $mono>
        {show(reading.limit)}
      </Td>
      <Td>
        {fraction === null ? null : (
          // `ui/Meter` owns the amber-at-70 / red-at-90 thresholds, and owning
          // them in one place is the point: they are a reading of state, and a
          // second copy is one that gets tuned without this one.
          // The label is clamped exactly as the bar is. A window can overshoot
          // its ceiling — spend is debited after the request served — and an
          // unclamped label announced "150% used" over a bar drawn at 100,
          // so a screen reader and a pair of eyes disagreed about the same row.
          // The raw figures are in the Used and Ceiling columns either way.
          <Meter
            fraction={fraction}
            label={`${label}, ${Math.round(Math.min(1, fraction) * 100)}% used`}
          />
        )}
      </Td>
    </Tr>
  );
}

/** An account's window as the shared chart reads it: a fraction, never a count. */
function readingOfHeadroom(row: AccountQuota): QuotaReading {
  return {
    observedAt: row.observedAt,
    windowType: row.windowType,
    windowMs: row.windowMs,
    resetsAt: row.resetsAt,
    usedRatio: row.usedRatio,
  };
}

/** The verdicts the legend is phrased from, as this surface is told them. */
function verdictsOf(row: AccountQuota): QuotaVerdicts {
  return {
    stale: row.stale,
    rolledOver: row.rolledOver,
    estimateStale: row.stale || row.rolledOver,
    survives: row.survives,
    exhaustsAt: row.exhaustsAt,
  };
}

const QuotaStack = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const QuotaCell = styled.div`
  display: grid;
  /* Bar, figure, legend — the accounts page's own three columns, so the two
     screens read the same way and the legends stay aligned down the stack. */
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

/**
 * One account, with every window it reported stacked beside its name.
 *
 * The accounts page's own shape, one level down: a five-hour window at 90% and
 * a weekly one at 20% mean "pause for an hour", while the reverse means "this
 * account is done for the week", and reading those two facts off separate rows
 * is what makes the pair hard to see. The bars stay separate for the same
 * reason — collapsing them would answer two questions with one number.
 */
function AccountRow({
  windows,
  open,
  onToggle,
}: {
  /** Every window of one account, shortest first. */
  windows: readonly AccountQuota[];
  open: boolean;
  onToggle: () => void;
}) {
  const first = windows[0] as AccountQuota;
  const drawable = windows.filter((row) => row.usedRatio !== null);
  return (
    <Tr>
      <Td>{first.label}</Td>
      <Td>
        {drawable.length === 0 ? (
          // Quota is what the provider reported. Nothing reported is not the
          // same claim as no limit.
          <Muted>unknown</Muted>
        ) : (
          <QuotaStack>
            {drawable.map((row) => (
              <QuotaCell key={row.windowType}>
                <Meter
                  fraction={row.usedRatio as number}
                  label={`${row.label} ${row.windowType} window, ${Math.round((row.usedRatio as number) * 100)}% used`}
                />
                {/* Whole percent: the bar is the comparison and this is the
                    reading, and a decimal here would be precision the probe
                    interval does not have. */}
                <Percent>{formatPercent(row.usedRatio as number, 0)}</Percent>
                <Legend>{quotaLegendOf(row, verdictsOf(row), Date.now(), formatRelative)}</Legend>
              </QuotaCell>
            ))}
          </QuotaStack>
        )}
      </Td>
      <Td $align="right">
        {/* A chevron, as the accounts page uses: the control is a disclosure,
            and its accessible name carries the sentence a sighted reader gets
            from the arrow's direction. */}
        <IconButton
          type="button"
          $variant="ghost"
          $size="sm"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} quota history for ${first.label}`}
          title={`${open ? "Hide" : "Show"} quota history for ${first.label}`}
          onClick={onToggle}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </IconButton>
      </Td>
    </Tr>
  );
}

/**
 * What the holder of one API key sees about their own traffic.
 *
 * Deliberately one screen rather than the console's nine. A client has one key,
 * so a navigation rail over four panels would be furniture around a single
 * question: how much have I used, and am I about to be stopped.
 *
 * Every panel is the console's own — the usage deck, the request log, the quota
 * chart — reading this key's rows. What differs is vocabulary, not instruments:
 * a client is told fractions where an operator is told counts, because the size
 * of the accounts behind them is the operator's infrastructure.
 */
export function ClientBoard() {
  const { cadence, live: liveUpdates } = useLive();
  const [rangeId, setRangeId] = useState<RangeId>("24h");
  const [filter, setFilter] = useState<Filter>("all");
  const [term, setTerm] = useState("");
  const [limit, setLimit] = useState<number>(LIMITS[0]);
  const [open, setOpen] = useState<RequestLog | null>(null);
  const [openAccount, setOpenAccount] = useState<string | null>(null);

  const range = rangeOf(rangeId);
  // Pinned per range so the query key does not change on every tick: to the
  // minute for raw windows, to the day for rollup ones.
  const since = useMemo(
    () =>
      range.grain === "daily"
        ? startOfDay(Date.now() - range.ms)
        : Math.floor((Date.now() - range.ms) / 60_000) * 60_000,
    [range],
  );
  const until = useMemo(() => since + range.ms, [since, range]);

  const summary = useClientSummary();
  const common = { since, grain: range.grain } as const;
  const series = useClientUsage({ ...common, groupBy: range.by }, cadence(60_000, "res:usage"));
  const byModel = useClientUsage({ ...common, groupBy: "model" }, cadence(60_000, "res:usage"));
  const logs = useClientLogs(limit, cadence(LOG_CADENCE_MS, "res:logs"));
  // Polled, with no topic. A client holds `res:usage` and `res:logs` and nothing
  // else, so naming `res:quota` here would switch polling off in favour of a
  // push that never arrives, and the panel would sit frozen with no error.
  const quota = useClientQuota(60_000);

  const headroom = quota.data ?? [];
  /**
   * Providers, each holding its accounts, each holding its windows.
   *
   * The accounts page's own nesting: a provider is a heading, an account is a
   * row, and its windows are stacked inside that row shortest first — soonest
   * to latest, top to bottom.
   */
  const byProvider = useMemo(() => {
    const providers = new Map<string, Map<string, AccountQuota[]>>();
    for (const row of headroom) {
      const accounts = providers.get(row.provider) ?? new Map<string, AccountQuota[]>();
      const windows = accounts.get(row.credentialId);
      if (windows === undefined) accounts.set(row.credentialId, [row]);
      else windows.push(row);
      providers.set(row.provider, accounts);
    }
    return [...providers.entries()].map(
      ([provider, accounts]) =>
        [
          provider,
          [...accounts.entries()].map(([credentialId, windows]) => ({
            credentialId,
            windows: [...windows].sort(
              (a, b) => WINDOW_ORDER[a.windowType] - WINDOW_ORDER[b.windowType],
            ),
          })),
        ] as const,
    );
  }, [headroom]);

  // One span covering every window on the page, so opening a second account
  // reuses the request the first one made rather than keying a new one.
  const spans = headroom
    .map((row) => chartSpanOf(readingOfHeadroom(row)))
    .filter((start) => start !== null);
  const historySince = spans.length === 0 ? 0 : Math.min(...spans);
  const history = useClientQuotaHistory(
    { since: historySince },
    openAccount !== null && spans.length > 0,
  );

  const hasPending = (logs.data ?? []).some(isPending);
  const now = useCurrentTime(liveUpdates && hasPending);
  const rows = filterLogs(logs.data ?? [], filter, term);
  const failed = (logs.data ?? []).filter(isError).length;

  const buckets = series.data ?? [];
  const requests = buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
  const costUsd = buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);

  return (
    <Stack $gap={4}>
      <PageHead
        legend="Client"
        title="Your usage"
        summary={
          series.isLoading
            ? "Reading your usage…"
            : `${formatCount(requests)} requests and ${formatUsd(costUsd)} over the last ${range.label}.`
        }
        actions={
          <Controls>
            {RANGES.map((entry) => (
              <Segment
                key={entry.id}
                type="button"
                $size="sm"
                $on={entry.id === rangeId}
                aria-pressed={entry.id === rangeId}
                onClick={() => setRangeId(entry.id)}
              >
                {entry.id}
              </Segment>
            ))}
          </Controls>
        }
      />

      {/*
        A `Module` rather than a `Section`: this panel has no empty state. A
        session exists because a key does, so "nothing here" is not one of the
        things it can say, and handing `Section` an unreachable empty message
        would be a state the next reader goes looking for.
      */}
      <Module
        legend="Your key"
        meta={summary.data === undefined ? undefined : <Mono $dim>{summary.data.prefix}…</Mono>}
      >
        {summary.isPending ? (
          <SkeletonRows rows={2} />
        ) : summary.isError ? (
          <Failure legend="Could not read your key" error={summary.error} />
        ) : (
          <Stack $gap={2}>
            <Row $gap={2} $wrap>
              <Legend>{summary.data.label}</Legend>
              {summary.data.bodyLoggingOptOut ? (
                <Muted>Request bodies are never stored for this key.</Muted>
              ) : null}
            </Row>
            {summary.data.modelAllowlist === null ? (
              <Muted>Every model this gateway serves.</Muted>
            ) : summary.data.modelAllowlist.length === 0 ? (
              // `[]` and `null` are opposite facts and must not render alike.
              <Muted>No models. This key cannot serve a request.</Muted>
            ) : (
              <Row $gap={1} $wrap>
                {summary.data.modelAllowlist.map((model) => (
                  <Mono key={model}>{model}</Mono>
                ))}
              </Row>
            )}
          </Stack>
        )}
      </Module>

      <SummaryDeck
        buckets={buckets}
        since={since}
        until={until}
        by={range.by}
        rangeLabel={range.label}
      />

      <Section
        legend="By model"
        meta={range.label}
        query={{
          isLoading: byModel.isLoading,
          isError: byModel.isError,
          error: byModel.error,
          refetch: () => void byModel.refetch(),
        }}
        failure="Could not read usage"
        empty={{ legend: "No traffic", message: "Nothing served in this window." }}
        isEmpty={(byModel.data ?? []).length === 0}
      >
        <ScrollX>
          <Table>
            <thead>
              <tr>
                <Th>Model</Th>
                <Th $align="right">Requests</Th>
                <Th $align="right">Tokens</Th>
                <Th $align="right">Spend</Th>
              </tr>
            </thead>
            <tbody>
              {(byModel.data ?? []).map((bucket) => (
                <Tr key={bucket.key}>
                  <Td $mono>{bucket.key}</Td>
                  <Td $align="right" $mono>
                    {formatCount(bucket.requests)}
                  </Td>
                  <Td $align="right" $mono>
                    {formatCount(
                      bucket.inputTokens +
                        bucket.outputTokens +
                        bucket.cacheReadTokens +
                        bucket.cacheWriteTokens,
                    )}
                  </Td>
                  <Td $align="right" $mono>
                    {formatUsd(bucket.costUsd)}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </ScrollX>
      </Section>

      <Section
        legend="Your limits"
        query={{
          isLoading: summary.isLoading,
          isError: summary.isError,
          error: summary.error,
          refetch: () => void summary.refetch(),
        }}
        failure="Could not read your limits"
        // "Unreadable" is distinct from "no limits". An unparseable matrix is
        // refused at `/v1`, so reporting "unlimited" here would contradict
        // every request.
        empty={
          summary.data?.limits === null
            ? {
                legend: "Limits unreadable",
                message:
                  "This key's limits could not be read. Requests are refused until an operator repairs it.",
              }
            : { legend: "No limits", message: "This key is not rate limited." }
        }
        isEmpty={summary.data?.limits === null || (summary.data?.limitUsage.length ?? 0) === 0}
        footer={
          <Muted>
            Counted from completed requests, so a burst in flight right now may not be included yet.
          </Muted>
        }
      >
        <ScrollX>
          <Table>
            <thead>
              <tr>
                <Th>Limit</Th>
                <Th $align="right">Used</Th>
                <Th $align="right">Ceiling</Th>
                <Th $width="30%">Consumption</Th>
              </tr>
            </thead>
            <tbody>
              {(summary.data?.limitUsage ?? []).map((reading) => (
                <LimitRow
                  key={`${reading.dimension}:${reading.window ?? "gauge"}`}
                  reading={reading}
                />
              ))}
            </tbody>
          </Table>
        </ScrollX>
      </Section>

      <Section
        legend="Provider headroom"
        query={{
          isLoading: quota.isLoading,
          isError: quota.isError,
          error: quota.error,
          refetch: () => void quota.refetch(),
        }}
        failure="Could not read provider headroom"
        empty={{ legend: "No data", message: "No provider has reported a usage window." }}
        isEmpty={headroom.length === 0}
        footer={
          <Muted>
            What each account serving this gateway has left. A request is served by whichever
            account of a provider can take it.
          </Muted>
        }
      >
        <Stack $gap={4}>
          {byProvider.map(([provider, accounts]) => (
            <Stack key={provider} $gap={1}>
              <Legend>{provider}</Legend>
              <ScrollX>
                <Table>
                  <thead>
                    <tr>
                      <Th>Account</Th>
                      <Th $width="60%">Quota</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map(({ credentialId, windows }) => (
                      <Fragment key={credentialId}>
                        <AccountRow
                          windows={windows}
                          open={openAccount === credentialId}
                          onToggle={() =>
                            setOpenAccount(openAccount === credentialId ? null : credentialId)
                          }
                        />
                        {openAccount !== credentialId ? null : (
                          <Tr>
                            <Td colSpan={3}>
                              {/* Every window of this account, charted together
                                  — the accounts page draws them the same way,
                                  because the pair is the reading. */}
                              <Stack $gap={4}>
                                {windows.map((row) => {
                                  const live = readingOfHeadroom(row);
                                  const since = chartSpanOf(live);
                                  return (
                                    <WindowChart
                                      key={row.windowType}
                                      live={live}
                                      samples={(history.data ?? [])
                                        .filter(
                                          (sample) =>
                                            sample.credentialId === row.credentialId &&
                                            sample.windowType === row.windowType &&
                                            sample.observedAt >= (since ?? 0),
                                        )
                                        .map((sample) => ({
                                          observedAt: sample.observedAt,
                                          windowType: sample.windowType,
                                          windowMs: sample.windowMs,
                                          resetsAt: sample.resetsAt,
                                          usedRatio: sample.usedRatio,
                                        }))}
                                      since={since}
                                      now={Date.now()}
                                      ratePerHourRatio={row.ratePerHourRatio}
                                      exhaustsAt={row.exhaustsAt}
                                      survives={row.survives}
                                      stale={row.stale}
                                      rolledOver={row.rolledOver}
                                      spent={
                                        row.usedRatio === null
                                          ? "no ceiling reported"
                                          : `${formatPercent(row.usedRatio, 0)} used`
                                      }
                                      // A percentage of this window's own
                                      // ceiling: how full the account is, never
                                      // how large it is.
                                      rateText={
                                        row.ratePerHourRatio === null
                                          ? "unknown"
                                          : `${formatPercent(row.ratePerHourRatio, 1)}/h`
                                      }
                                    />
                                  );
                                })}
                              </Stack>
                            </Td>
                          </Tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </Table>
              </ScrollX>
            </Stack>
          ))}
        </Stack>
      </Section>

      <Section
        legend="Recent requests"
        meta={`${rows.length} shown`}
        actions={
          <Controls>
            <Input
              value={term}
              placeholder="Filter by model or error"
              aria-label="Filter requests"
              style={{ width: 200 }}
              onChange={(event) => setTerm(event.target.value)}
            />
            <Select
              value={filter}
              aria-label="Show which requests"
              style={{ width: "auto" }}
              onChange={(event) => setFilter(event.target.value as Filter)}
            >
              <option value="all">All requests</option>
              <option value="failed">Failed only</option>
            </Select>
            <Select
              value={limit}
              aria-label="How many requests to fetch"
              style={{ width: "auto" }}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMITS.map((value) => (
                <option key={value} value={value}>
                  last {value}
                </option>
              ))}
            </Select>
          </Controls>
        }
        query={{
          isLoading: logs.isLoading,
          isError: logs.isError,
          error: logs.error,
          refetch: () => void logs.refetch(),
        }}
        failure="Could not read your requests"
        empty={{
          legend: "No requests",
          message:
            (logs.data ?? []).length === 0
              ? "Nothing served through this key yet."
              : "No request in this window matches the filter. Clear it to see everything.",
        }}
        isEmpty={rows.length === 0}
        footer={
          <Muted>
            {formatCount(failed)} of the last {formatCount((logs.data ?? []).length)} failed.
          </Muted>
        }
      >
        <ScrollX>
          {/* No `names`: the account that served a request is the operator's
              infrastructure, and this session cannot read the labels anyway. */}
          <RequestTable rows={rows} now={now} onOpen={setOpen} />
        </ScrollX>
      </Section>

      <Modal
        open={open !== null}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        title="Request detail"
        width="640px"
        footer={
          <Button type="button" onClick={() => setOpen(null)}>
            Close
          </Button>
        }
      >
        {/* No body slot. `/api/client/*` has no body route — an absent one, not
            a filtered one — so there is nothing here for anyone to later make
            conditional. */}
        {open === null ? null : <RequestDetail log={open} />}
      </Modal>
    </Stack>
  );
}
