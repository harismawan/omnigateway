import { Minimize2 } from "lucide-react";
import { useState } from "react";
import styled from "styled-components";
import { useDatabaseOverview, useVacuum } from "../../api/queries.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatBytes, formatMs, formatPercent } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Grid } from "../../ui/primitives.ts";
import { Readout } from "../../ui/Readout.tsx";
import { describeError, Failure, SkeletonRows } from "../../ui/States.tsx";
import { LifecycleModule } from "./LifecycleModule.tsx";
import { RetentionModule } from "./RetentionModule.tsx";
import { SnapshotsModule } from "./SnapshotsModule.tsx";

const Outcome = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.ok};
`;

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

/**
 * How big this installation has got, and what to do about it.
 *
 * One screen rather than a corner of Settings, because everything on it either
 * reads the file the whole gateway runs from or replaces it, and those belong
 * next to each other.
 */
export function DatabaseBoard() {
  const overview = useDatabaseOverview();
  const vacuum = useVacuum();
  const [compacting, setCompacting] = useState(false);
  const data = overview.data;

  // Guarded rather than trusted: a database with no pages is not a state the
  // gateway can reach, but a division that produced NaN would render as one.
  const freeShare =
    data === undefined || data.logicalBytes === 0 ? 0 : data.freePageBytes / data.logicalBytes;

  return (
    <>
      <PageHead
        legend="Database"
        title="Storage, snapshots, and lifecycle"
        summary={
          overview.isLoading
            ? "Measuring the database…"
            : "The one SQLite file this gateway runs from, the copies taken of it, and the controls that stop and start the process."
        }
      />

      <Module
        legend="Size"
        meta={data === undefined ? undefined : `schema v${data.stats.schemaVersion}`}
        actions={
          <Button
            type="button"
            $size="sm"
            disabled={vacuum.isPending || data === undefined}
            onClick={() => setCompacting(true)}
          >
            <Minimize2 />
            {vacuum.isPending ? "Compacting…" : "Compact"}
          </Button>
        }
        footer={
          vacuum.isError ? (
            <Problem role="alert">{describeError(vacuum.error)}</Problem>
          ) : vacuum.data === undefined ? undefined : (
            <Outcome role="status">
              {`Compacted, reclaiming ${formatBytes(vacuum.data.reclaimedBytes)} in ${formatMs(vacuum.data.durationMs)}.`}
            </Outcome>
          )
        }
      >
        {overview.isError ? (
          <Failure error={overview.error} onRetry={() => void overview.refetch()} />
        ) : data === undefined ? (
          <SkeletonRows rows={3} />
        ) : (
          <Grid $min="180px">
            <Readout
              legend="Database file"
              value={formatBytes(data.fileBytes)}
              unit={`${data.stats.pageCount} pages of ${formatBytes(data.stats.pageSize)}`}
              trace={
                <Meter
                  fraction={freeShare}
                  label={`${formatPercent(freeShare, 0)} of the file is reclaimable`}
                />
              }
            />
            <Readout
              legend="Reclaimable"
              value={formatBytes(data.freePageBytes)}
              unit={`${data.stats.freelistCount} free pages`}
            />
            <Readout
              legend="Write-ahead log"
              value={formatBytes(data.walBytes)}
              unit="folded into every snapshot"
            />
            <Readout
              legend="Captured bodies"
              value={formatBytes(data.bodiesBytes)}
              unit="never in a snapshot"
            />
            <Readout
              legend="Snapshots"
              value={formatBytes(data.snapshots.totalBytes)}
              unit={`${data.snapshots.count} kept`}
            />
            <Readout
              legend="Free disk"
              value={formatBytes(data.freeDiskBytes)}
              unit={data.freeDiskBytes === null ? "not readable here" : "on this filesystem"}
            />
          </Grid>
        )}
      </Module>

      <SnapshotsModule />

      <RetentionModule retention={data?.retention} />

      <LifecycleModule />

      <Confirm
        open={compacting}
        onOpenChange={setCompacting}
        title="Compact database"
        body="Running VACUUM rewrites the database to give back its free pages. It holds the write lock for as long as it takes, so requests in flight will wait, and it needs room on disk for a second copy while it runs."
        confirmLabel="Compact database"
        busy={vacuum.isPending}
        onConfirm={() => vacuum.mutate(undefined, { onSettled: () => setCompacting(false) })}
      />
    </>
  );
}
