import type { ReactNode } from "react";
import { Module } from "./Panel.tsx";
import { Empty, Failure, SkeletonRows } from "./States.tsx";

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
  footer?: ReactNode;
  query: SectionQuery;
  /**
   * What the failure is called. The default names the request; a panel says
   * which read failed when the page holds several, so "Could not read provider
   * headroom" is not the same sentence as the one two panels down.
   */
  failure?: string;
  /** Shown instead of the children when the window holds nothing. */
  empty: { legend: string; message: string };
  isEmpty: boolean;
  children: ReactNode;
};

/**
 * One panel of a board. Every panel reads a slice of the same window, so they
 * all resolve loading, failure, and emptiness the same way rather than each
 * inventing its own placeholder.
 *
 * In `ui` rather than beside the usage deck because the client surface renders
 * the same four states over its own scoped reads, and two copies of this ladder
 * are two places a state gets forgotten.
 */
export function Section({
  legend,
  meta,
  actions,
  footer,
  query,
  failure,
  empty,
  isEmpty,
  children,
}: SectionProps) {
  return (
    <Module
      legend={legend}
      {...(meta === undefined ? {} : { meta })}
      {...(actions === undefined ? {} : { actions })}
      {...(footer === undefined ? {} : { footer })}
    >
      {query.isError ? (
        <Failure
          {...(failure === undefined ? {} : { legend: failure })}
          error={query.error}
          onRetry={query.refetch}
        />
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
