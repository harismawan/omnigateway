import { Minimize2 } from "lucide-react";
import { useState } from "react";
import styled from "styled-components";
import { useDatabaseOverview, useVacuum } from "../../api/queries.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { PageHead } from "../../components/Rack.tsx";
import { formatBytes, formatCount, formatMs, formatPercent } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Meter } from "../../ui/Meter.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Grid } from "../../ui/primitives.ts";
import { Readout } from "../../ui/Readout.tsx";
import { describeError, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
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
 * next to each other. Stopping and starting the process is not one of those and
 * lives in the rail, reachable from wherever the operator happens to be.
 */
/**
 * `host:port` of a Postgres URL. The whole URL, credentials masked, is too
 * long for a readout and says nothing a host and port do not; the masked
 * password is the part not worth the width.
 */
function serverOf(url: string): string {
  try {
    const { hostname, port } = new URL(url);
    return port === "" ? hostname : `${hostname}:${port}`;
  } catch {
    return url;
  }
}

function databaseOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "") || "—";
  } catch {
    return "—";
  }
}

export function DatabaseBoard() {
  const overview = useDatabaseOverview();
  const vacuum = useVacuum();
  const [compacting, setCompacting] = useState(false);
  const data = overview.data;
  // A Postgres store is a server this process connects to, not a file it holds:
  // nothing here can compact it, copy it, or replace it, so those controls
  // would be a promise the gateway cannot keep. `pg_dump` is the backup.
  const postgres = data?.engine === "postgres";

  // Guarded rather than trusted: a database with no pages is not a state the
  // gateway can reach, but a division that produced NaN would render as one.
  const freeShare =
    data === undefined || data.logicalBytes === 0 ? 0 : data.freePageBytes / data.logicalBytes;

  return (
    <>
      <PageHead
        legend="Database"
        title="Storage, snapshots, and retention"
        summary={
          overview.isLoading
            ? "Measuring the database…"
            : postgres
              ? "The Postgres database every replica of this cluster runs from. Back it up with pg_dump; nothing here copies or replaces it."
              : "The one SQLite file this gateway runs from, the copies taken of it, and how long they are kept."
        }
      />

      <Module
        legend="Size"
        meta={data === undefined ? undefined : `schema v${data.stats.schemaVersion}`}
        actions={
          postgres ? undefined : (
            <Button
              type="button"
              $size="sm"
              disabled={vacuum.isPending || data === undefined}
              onClick={() => setCompacting(true)}
            >
              <Minimize2 />
              {vacuum.isPending ? "Compacting…" : "Compact"}
            </Button>
          )
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
        ) : postgres ? (
          <Grid $min="180px" $stretch>
            <Readout
              legend="Database"
              value={formatBytes(data.logicalBytes)}
              unit={`${data.stats.pageCount} blocks of ${formatBytes(data.stats.pageSize)}`}
            />
            <Readout
              legend="Server"
              value={serverOf(data.location)}
              unit={`database ${databaseOf(data.location)}`}
            />
            <Readout
              legend="Captured bodies"
              value={formatBytes(data.bodiesBytes)}
              unit="the request_bodies table"
            />
          </Grid>
        ) : (
          <Grid $min="180px" $stretch>
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

      <Module
        legend="Tables"
        meta={
          postgres
            ? "row counts are the planner's estimates; dead rows await autovacuum"
            : "size includes each table's indexes"
        }
      >
        {data === undefined ? (
          <SkeletonRows rows={4} />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Table</Th>
                <Th $align="right">Size</Th>
                <Th $align="right">Rows</Th>
                {postgres ? <Th $align="right">Dead rows</Th> : null}
              </Tr>
            </thead>
            <tbody>
              {data.tables.map((table) => (
                <Tr key={table.name}>
                  <Td>{table.name}</Td>
                  <Td $align="right">{formatBytes(table.bytes)}</Td>
                  <Td $align="right">{formatCount(table.rows)}</Td>
                  {postgres ? <Td $align="right">{formatCount(table.deadRows ?? 0)}</Td> : null}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Module>

      {postgres ? null : (
        <>
          <SnapshotsModule />
          <RetentionModule retention={data?.retention} />
        </>
      )}

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
