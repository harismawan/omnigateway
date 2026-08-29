import styled from "styled-components";
import type { UsageBucket } from "../../api/types.ts";
import { formatCount, formatMs, formatPercent, formatUsd } from "../../lib/format.ts";
import { Readout } from "../../ui/Readout.tsx";
import { Sparkline } from "../../ui/Sparkline.tsx";
import { keyToTime, type TimeBy, timeTicks, totalsOf } from "./shared.ts";

const Deck = styled.div`
  display: grid;
  grid-template-columns: repeat(
    auto-fit,
    minmax(max(180px, calc((100% - 4 * ${({ theme }) => theme.space(3)}) / 5)), 1fr)
  );
  gap: ${({ theme }) => theme.space(3)};
`;

export type SummaryDeckProps = {
  /** The window's buckets, grouped by time at the grain `by` names. */
  buckets: readonly UsageBucket[];
  since: number;
  until: number;
  by: TimeBy;
  /** How the window is named in the units line, e.g. "24 hours". */
  rangeLabel: string;
};

/**
 * What a window came to, as ten readings with the shape of each beneath it.
 *
 * Shared by the operator's usage deck and the client's own screen, which reads
 * the same buckets scoped to one key: the arithmetic is identical, and a second
 * copy would be a second set of definitions for "prompt input" and "tokens"
 * that nobody would notice diverging.
 */
export function SummaryDeck({ buckets, since, until, by, rangeLabel }: SummaryDeckProps) {
  const totals = totalsOf(buckets);
  const promptInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const meanOutput = totals.requests === 0 ? 0 : totals.outputTokens / totals.requests;
  const cacheReadRate = promptInput === 0 ? 0 : totals.cacheReadTokens / promptInput;
  const cacheWriteRate = promptInput === 0 ? 0 : totals.cacheWriteTokens / promptInput;
  const meanCost = totals.requests === 0 ? 0 : totals.costUsd / totals.requests;

  // The traces share the window's ticks with whatever charts sit below them.
  const ticks = timeTicks(since, until, by);
  const byTick = new Map(buckets.map((bucket) => [keyToTime(bucket.key, by), bucket]));
  const trace = (of: (at: number) => number): number[] => ticks.map(of);
  const errorTone = (rate: number): "ok" | "warn" | "down" =>
    rate >= 0.25 ? "down" : rate >= 0.05 ? "warn" : "ok";
  const errorRate = totals.requests === 0 ? 0 : totals.errors / totals.requests;

  return (
    <Deck data-testid="usage-summary-deck">
      <Readout
        legend="Requests"
        value={formatCount(totals.requests)}
        unit={rangeLabel}
        trace={
          <Sparkline
            values={trace((at) => byTick.get(at)?.requests ?? 0)}
            overlay={trace((at) => byTick.get(at)?.errors ?? 0)}
            label={`${totals.requests} requests, ${totals.errors} of them failed`}
          />
        }
      />
      <Readout
        legend="Error rate"
        value={formatPercent(errorRate)}
        unit={`${formatCount(totals.errors)} failed`}
        tone={totals.requests === 0 ? "ink" : errorTone(errorRate)}
        trace={
          <Sparkline
            values={trace((at) => {
              const bucket = byTick.get(at);
              return bucket === undefined || bucket.requests === 0
                ? 0
                : bucket.errors / bucket.requests;
            })}
            color="var(--down)"
            label={`${totals.errors} failed requests against ${totals.requests} total`}
          />
        }
      />
      <Readout
        legend="Prompt input"
        value={formatCount(promptInput)}
        unit={`${formatCount(totals.inputTokens)} uncached`}
        trace={
          <Sparkline
            values={trace((at) => {
              const bucket = byTick.get(at);
              return (
                (bucket?.inputTokens ?? 0) +
                (bucket?.cacheReadTokens ?? 0) +
                (bucket?.cacheWriteTokens ?? 0)
              );
            })}
            label={`${promptInput} prompt input tokens over the window`}
          />
        }
      />
      <Readout
        legend="Output"
        value={formatCount(totals.outputTokens)}
        unit={`mean ${formatCount(meanOutput)}/request`}
        trace={
          <Sparkline
            values={trace((at) => byTick.get(at)?.outputTokens ?? 0)}
            label={`${totals.outputTokens} output tokens over the window`}
          />
        }
      />
      <Readout
        legend="Cache reads"
        value={formatCount(totals.cacheReadTokens)}
        unit={`${formatPercent(cacheReadRate, 0)} of prompt`}
        trace={
          <Sparkline
            values={trace((at) => byTick.get(at)?.cacheReadTokens ?? 0)}
            label={`${totals.cacheReadTokens} cache-read tokens over the window`}
          />
        }
      />
      <Readout
        legend="Cache writes"
        value={formatCount(totals.cacheWriteTokens)}
        unit={`${formatPercent(cacheWriteRate, 0)} of prompt`}
        trace={
          <Sparkline
            values={trace((at) => byTick.get(at)?.cacheWriteTokens ?? 0)}
            label={`${totals.cacheWriteTokens} cache-write tokens over the window`}
          />
        }
      />
      <Readout
        legend="RTK saved"
        value={formatCount(totals.rtkSavedTokens)}
        unit={`${formatCount(totals.rtkAppliedRequests)} requests`}
        trace={
          <Sparkline
            values={trace((at) => byTick.get(at)?.rtkSavedTokens ?? 0)}
            label={`${totals.rtkSavedTokens} estimated tokens saved by RTK over the window`}
          />
        }
      />
      <Readout
        legend="Mean duration"
        value={formatMs(totals.requests === 0 ? null : totals.durationMsSum / totals.requests)}
        unit="per request"
        trace={
          <Sparkline
            values={trace((at) => {
              const bucket = byTick.get(at);
              return bucket === undefined || bucket.requests === 0
                ? 0
                : bucket.durationMsSum / bucket.requests;
            })}
            color="var(--ok)"
            label="mean request duration over the window"
          />
        }
      />
      <Readout
        legend="Spend"
        value={formatUsd(totals.costUsd)}
        unit={rangeLabel}
        trace={
          <Sparkline
            values={trace((at) => byTick.get(at)?.costUsd ?? 0)}
            color="var(--warn)"
            label={`spend over the window, ${formatUsd(totals.costUsd)} total`}
          />
        }
      />
      <Readout
        legend="Cost / request"
        value={formatUsd(meanCost)}
        unit="mean"
        trace={
          <Sparkline
            values={trace((at) => {
              const bucket = byTick.get(at);
              return bucket === undefined || bucket.requests === 0
                ? 0
                : bucket.costUsd / bucket.requests;
            })}
            color="var(--warn)"
            label={`${formatUsd(meanCost)} mean cost per request over the window`}
          />
        }
      />
    </Deck>
  );
}
