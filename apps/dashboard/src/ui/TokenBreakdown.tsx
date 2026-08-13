import { ArrowDown, ArrowUp, Database } from "lucide-react";
import styled, { keyframes } from "styled-components";
import type { RequestLog } from "../api/types.ts";
import { formatCount } from "../lib/format.ts";

const TOKEN_COUNT = new Intl.NumberFormat("en-US");

export type TokenCounts = Pick<
  RequestLog,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

export function tokenBreakdownLabel(tokens: TokenCounts): string {
  return `${TOKEN_COUNT.format(tokens.inputTokens)} input, ${TOKEN_COUNT.format(tokens.outputTokens)} output, ${TOKEN_COUNT.format(tokens.cacheReadTokens)} cache read, ${TOKEN_COUNT.format(tokens.cacheWriteTokens)} cache write tokens`;
}

const Breakdown = styled.span`
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  /* Wrapping happens between the four classes, never inside one: a count
     broken across lines from its own arrow reads as a different number. */
  white-space: nowrap;
`;

const Part = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 2px;

  svg {
    width: 12px;
    height: 12px;
    stroke-width: 1.75;
  }
`;

const revealDots = keyframes`
  from { clip-path: inset(0 2ch 0 0); }
  to { clip-path: inset(0 0 0 0); }
`;

const ProcessingDots = styled.span`
  display: inline-block;
  width: 3ch;
  vertical-align: bottom;
  animation: ${revealDots} 1.5s steps(2, end) infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
`;

export function ProcessingTokens() {
  return (
    <span aria-hidden="true">
      processing<ProcessingDots>...</ProcessingDots>
    </span>
  );
}

export function TokenBreakdown({ tokens }: { tokens: TokenCounts }) {
  const label = tokenBreakdownLabel(tokens);
  return (
    <Breakdown role="img" aria-label={label} title={label}>
      <Part aria-hidden="true">
        <ArrowDown />
        {formatCount(tokens.inputTokens)}
      </Part>
      <Part aria-hidden="true">
        <ArrowUp />
        {formatCount(tokens.outputTokens)}
      </Part>
      <Part aria-hidden="true">
        <Database />
        <ArrowDown />
        {formatCount(tokens.cacheReadTokens)}
      </Part>
      <Part aria-hidden="true">
        <Database />
        <ArrowUp />
        {formatCount(tokens.cacheWriteTokens)}
      </Part>
    </Breakdown>
  );
}
