import type { ReactNode } from "react";
import { Module } from "../../ui/Panel.tsx";
import { Empty, Failure, SkeletonRows } from "../../ui/States.tsx";

export type SectionQuery = {
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
};

export type SectionProps = {
  legend: string;
  meta?: ReactNode;
  actions?: ReactNode;
  query: SectionQuery;
  /** Shown instead of the children when the window holds nothing. */
  empty: { legend: string; message: string };
  isEmpty: boolean;
  children: ReactNode;
};

/**
 * One panel of the usage deck. Every panel reads a slice of the same window,
 * so they all resolve loading, failure, and emptiness the same way rather than
 * each inventing its own placeholder.
 */
export function Section({ legend, meta, actions, query, empty, isEmpty, children }: SectionProps) {
  return (
    <Module legend={legend} meta={meta} actions={actions}>
      {query.isError ? (
        <Failure error={query.error} onRetry={query.refetch} />
      ) : query.isLoading ? (
        <SkeletonRows rows={4} />
      ) : isEmpty ? (
        <Empty legend={empty.legend} message={empty.message} />
      ) : (
        children
      )}
    </Module>
  );
}
