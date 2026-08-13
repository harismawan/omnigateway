import type { ReactNode } from "react";
import styled from "styled-components";
import { Legend } from "./primitives.ts";

const Frame = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: ${({ theme }) => `${theme.space(2)} ${theme.space(3)}`};
  background: ${({ theme }) => theme.color.panel};
  border: 1px solid ${({ theme }) => theme.color.rule};
  border-radius: ${({ theme }) => theme.radius.panel};
  min-width: 0;
`;

const Value = styled.div<{ $tone?: "ink" | "ok" | "warn" | "down" }>`
  display: flex;
  align-items: baseline;
  /* A unit is usually a word beside the number, but it is allowed to be a
     whole breakdown. Wrapping keeps a long one inside the card instead of
     running past its edge, since neither the number nor the unit can shrink. */
  flex-wrap: wrap;
  gap: 4px;
  font-family: ${({ theme }) => theme.font.mono};
  font-variant-numeric: tabular-nums;
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: ${({ theme, $tone }) =>
    $tone === "ok"
      ? theme.color.ok
      : $tone === "warn"
        ? theme.color.warn
        : $tone === "down"
          ? theme.color.down
          : theme.color.ink};
`;

const Unit = styled.span`
  font-size: 11px;
  font-weight: 400;
  color: ${({ theme }) => theme.color.inkFaint};
`;

const Trace = styled.div`
  margin-top: 2px;
`;

export type ReadoutProps = {
  legend: string;
  value: string;
  unit?: ReactNode;
  tone?: "ink" | "ok" | "warn" | "down";
  /** A sparkline or meter beneath the number. */
  trace?: ReactNode;
  className?: string;
};

/** One number, its legend, and optionally the shape of how it got there. */
export function Readout({ legend, value, unit, tone, trace, className }: ReadoutProps) {
  return (
    <Frame className={className}>
      <Legend>{legend}</Legend>
      <Value {...(tone === undefined ? {} : { $tone: tone })}>
        <span>{value}</span>
        {unit === undefined ? null : <Unit>{unit}</Unit>}
      </Value>
      {trace === undefined ? null : <Trace>{trace}</Trace>}
    </Frame>
  );
}
