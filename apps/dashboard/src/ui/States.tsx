import type { ReactNode } from "react";
import styled, { keyframes } from "styled-components";
import { ApiError } from "../api/client.ts";
import { Button } from "./Button.tsx";
import { Legend } from "./primitives.ts";

const Center = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(8)} ${({ theme }) => theme.space(4)};
  text-align: center;
`;

const Line = styled.p`
  /* Wide enough for the console's uncaptured-fleet advice to read as a paragraph
     rather than a column; the horizontal padding keeps it off the card edge. */
  max-width: min(96ch, 100%);
  font-size: 13px;
  color: ${({ theme }) => theme.color.inkDim};
`;

export type EmptyProps = {
  legend: string;
  /** An empty screen is an invitation to act, so this says what to do next. */
  message: string;
  action?: ReactNode;
};

export function Empty({ legend, message, action }: EmptyProps) {
  return (
    <Center>
      <Legend>{legend}</Legend>
      <Line>{message}</Line>
      {action}
    </Center>
  );
}

const Fault = styled(Line)`
  color: ${({ theme }) => theme.color.down};
`;

export type FailureProps = {
  legend?: string;
  error: unknown;
  onRetry?: () => void;
};

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The gateway did not answer.";
}

/** States what went wrong and offers the one action that might fix it. */
export function Failure({ legend = "Request failed", error, onRetry }: FailureProps) {
  return (
    <Center>
      <Legend>{legend}</Legend>
      <Fault>{describeError(error)}</Fault>
      {onRetry === undefined ? null : (
        <Button type="button" $size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Center>
  );
}

const shimmer = keyframes`
  0% { opacity: 0.35; }
  50% { opacity: 0.7; }
  100% { opacity: 0.35; }
`;

export const Skeleton = styled.div<{ $height?: number; $width?: string }>`
  height: ${({ $height }) => $height ?? 12}px;
  width: ${({ $width }) => $width ?? "100%"};
  border-radius: 2px;
  background: ${({ theme }) => theme.color.ruleStrong};
  animation: ${shimmer} 1.4s ease-in-out infinite;
`;

const Rows = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(2)};
  padding: ${({ theme }) => theme.space(1)} 0;
`;

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  // A fixed-length placeholder list: the entries never reorder, so keying them
  // by position is stable rather than a source of state confusion.
  const widths = Array.from({ length: rows }, (_, i) => `row-${i}:${i % 3 === 0 ? "72%" : "100%"}`);
  return (
    <Rows aria-hidden="true">
      {widths.map((entry) => (
        <Skeleton key={entry} $width={entry.split(":")[1] ?? "100%"} />
      ))}
    </Rows>
  );
}
