import styled from "styled-components";
import type { RequestLog } from "../../api/types.ts";
import { formatCount, formatMs, formatPercent, formatUsd } from "../../lib/format.ts";
import { bucketLogs, summarize } from "../../lib/vitals.ts";
import { Readout } from "../../ui/Readout.tsx";
import { Sparkline } from "../../ui/Sparkline.tsx";
import { TokenBreakdown } from "../../ui/TokenBreakdown.tsx";

const Deck = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: ${({ theme }) => theme.space(3)};
`;

export type VitalsRowProps = {
  logs: readonly RequestLog[];
  windowMs: number;
  now: number;
};

/** The four numbers that answer "is the gateway fine right now". */
export function VitalsRow({ logs, windowMs, now }: VitalsRowProps) {
  const inWindow = logs.filter((log) => now - log.at <= windowMs);
  const vitals = summarize(inWindow, windowMs);
  const buckets = bucketLogs(inWindow, { now, spanMs: windowMs, count: 32 });

  const errorTone = vitals.errorRate >= 0.25 ? "down" : vitals.errorRate >= 0.05 ? "warn" : "ok";
  const totalTokens =
    vitals.inputTokens + vitals.outputTokens + vitals.cacheReadTokens + vitals.cacheWriteTokens;

  return (
    <Deck>
      <Readout
        legend="Requests"
        value={formatCount(vitals.requests)}
        unit={`${vitals.ratePerMin.toFixed(1)}/min`}
        trace={
          <Sparkline
            values={buckets.map((b) => b.total)}
            overlay={buckets.map((b) => b.errors)}
            label={`${vitals.requests} requests, ${vitals.errors} of them failed`}
          />
        }
      />
      <Readout
        legend="Error rate"
        value={formatPercent(vitals.errorRate)}
        unit={`${formatCount(vitals.errors)} failed`}
        tone={vitals.requests === 0 ? "ink" : errorTone}
        trace={
          <Sparkline
            values={buckets.map((b) => b.errors)}
            // Drawn against total traffic, so two failures in a quiet minute do
            // not look like the same event as two hundred in a busy one.
            scaleTo={Math.max(...buckets.map((b) => b.total))}
            color="var(--down)"
            label={`${vitals.errors} failed requests against ${vitals.requests} total`}
          />
        }
      />
      <Readout
        legend="Total tokens"
        value={formatCount(totalTokens)}
        unit={<TokenBreakdown tokens={vitals} />}
        trace={
          <Sparkline
            values={buckets.map((b) => b.tokens)}
            label={`token volume over the window, ${totalTokens.toLocaleString("en-US")} total`}
          />
        }
      />
      <Readout
        legend="Time to first token"
        value={formatMs(vitals.ttftP50)}
        unit={`p95 ${formatMs(vitals.ttftP95)}`}
        trace={
          <Sparkline
            values={buckets.map((b) => b.ttftMs ?? 0)}
            color="var(--ok)"
            label={`median first-token latency, currently ${formatMs(vitals.ttftP50)}`}
          />
        }
      />
      <Readout
        legend="Spend"
        value={formatUsd(vitals.costUsd)}
        unit={`${formatCount(vitals.inputTokens + vitals.outputTokens)} tokens`}
        trace={
          <Sparkline
            values={buckets.map((b) => b.costUsd)}
            color="var(--warn)"
            label={`spend over the window, ${formatUsd(vitals.costUsd)} total`}
          />
        }
      />
    </Deck>
  );
}
