import { Camera } from "lucide-react";
import { useState } from "react";
import styled from "styled-components";
import {
  snapshotDownloadUrl,
  useCreateSnapshot,
  useDeleteSnapshot,
  useImportDatabase,
  useRestoreSnapshot,
  useSnapshots,
} from "../../api/queries.ts";
import type { SnapshotInfo } from "../../api/types.ts";
import { Confirm } from "../../components/Confirm.tsx";
import { formatBytes, formatDateTime } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Field } from "../../ui/Field.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Row, ScrollX, Stack, Truncate } from "../../ui/primitives.ts";
import { describeError, Empty, Failure, SkeletonRows } from "../../ui/States.tsx";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";
import { useApplyRestore } from "./applyRestore.ts";

const Problem = styled.p`
  font-size: 12px;
  color: ${({ theme }) => theme.color.down};
`;

const Picker = styled.input`
  font-size: 12px;
  color: ${({ theme }) => theme.color.inkDim};
  max-width: 40ch;
`;

/**
 * Every copy of the database this installation is holding.
 *
 * A snapshot has no identity apart from the file it is, so the filename is the
 * id and is shown as such: it is what the operator will look for on disk, and
 * what every action below sends back.
 */
export function SnapshotsModule() {
  const snapshots = useSnapshots();
  const create = useCreateSnapshot();
  const restore = useRestoreSnapshot();
  const applyRestore = useApplyRestore();
  const remove = useDeleteSnapshot();
  const importDatabase = useImportDatabase();
  const [restoring, setRestoring] = useState<SnapshotInfo | null>(null);
  const [doomed, setDoomed] = useState<SnapshotInfo | null>(null);
  const [incoming, setIncoming] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const rows = snapshots.data ?? [];

  const take = (
    <Button
      type="button"
      $variant="primary"
      $size="sm"
      disabled={create.isPending}
      onClick={() => create.mutate()}
    >
      <Camera />
      {create.isPending ? "Copying…" : "Take a snapshot"}
    </Button>
  );

  /**
   * The other way a database arrives: one the operator is holding.
   *
   * In the footer rather than a module of its own because it is the same
   * operation as the Restore button in each row, only with a different source,
   * and it ends the same way.
   */
  const bring = (
    <Stack $gap={2}>
      <Row $gap={2} $wrap>
        <Field
          label="Database file to import"
          hint="A snapshot taken from this or another OmniGateway. It is checked for integrity and rejected if it is not one of ours."
        >
          {(props) => (
            <Picker
              {...props}
              type="file"
              accept=".sqlite,.db,application/octet-stream"
              onChange={(event) => setIncoming(event.target.files?.[0] ?? null)}
            />
          )}
        </Field>
        <Button
          type="button"
          $variant="danger"
          $size="sm"
          disabled={incoming === null || importDatabase.isPending}
          onClick={() => setImporting(true)}
        >
          {importDatabase.isPending ? "Replacing…" : "Import"}
        </Button>
      </Row>
      {importDatabase.isError ? (
        <Problem role="alert">{describeError(importDatabase.error)}</Problem>
      ) : null}
      {restore.isError ? <Problem role="alert">{describeError(restore.error)}</Problem> : null}
      {create.isError ? <Problem role="alert">{describeError(create.error)}</Problem> : null}
    </Stack>
  );

  return (
    <Module legend="Snapshots" meta={`${rows.length}`} actions={take} footer={bring} flush>
      {snapshots.isError ? (
        <Failure error={snapshots.error} onRetry={() => void snapshots.refetch()} />
      ) : snapshots.isLoading ? (
        <div style={{ padding: 12 }}>
          <SkeletonRows rows={3} />
        </div>
      ) : rows.length === 0 ? (
        <Empty
          legend="No snapshots"
          message="Nothing has been copied yet, so there is nothing to go back to. Take one before a migration or a settings change you are unsure of."
          action={
            <Button
              type="button"
              $variant="primary"
              $size="sm"
              disabled={create.isPending}
              onClick={() => create.mutate()}
            >
              Take the first snapshot
            </Button>
          }
        />
      ) : (
        <ScrollX>
          <Table>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Reason</Th>
                <Th $align="right">Size</Th>
                <Th $align="right">Taken</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <Tr key={entry.id}>
                  <Td $mono>
                    <Truncate style={{ maxWidth: "38ch", display: "block" }}>
                      {entry.filename}
                    </Truncate>
                  </Td>
                  <Td>{entry.reason}</Td>
                  <Td $align="right" $mono>
                    {formatBytes(entry.sizeBytes)}
                  </Td>
                  <Td $align="right" $mono>
                    {formatDateTime(entry.createdAt)}
                  </Td>
                  <Td $align="right">
                    <Row $gap={1} $justify="flex-end">
                      {/*
                        An ordinary link, deliberately. The file is as large as
                        the database and carries encrypted credentials and
                        API-key hashes, so it is never pulled through this
                        process: the browser streams it straight to disk under
                        the session cookie the route already requires.
                      */}
                      <Button
                        as="a"
                        $size="sm"
                        href={snapshotDownloadUrl(entry.id)}
                        download={entry.filename}
                      >
                        Download
                      </Button>
                      <Button
                        type="button"
                        $variant="danger"
                        $size="sm"
                        onClick={() => setRestoring(entry)}
                      >
                        Restore
                      </Button>
                      <Button
                        type="button"
                        $variant="danger"
                        $size="sm"
                        onClick={() => setDoomed(entry)}
                      >
                        Delete
                      </Button>
                    </Row>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </ScrollX>
      )}

      <Confirm
        open={restoring !== null}
        onOpenChange={(next) => {
          if (!next) setRestoring(null);
        }}
        title="Restore database"
        body={
          restoring === null
            ? ""
            : `Replacing the live database with ${restoring.filename}. Client requests are refused while the file is swapped, and a copy of the current database is taken first so this can be undone. Captured request bodies are not part of a snapshot and are left where they are.`
        }
        confirmLabel="Restore database"
        busy={restore.isPending}
        onConfirm={() => {
          if (restoring === null) return;
          restore.mutate(restoring.id, {
            onSuccess: applyRestore,
            onSettled: () => setRestoring(null),
          });
        }}
      />

      <Confirm
        open={doomed !== null}
        onOpenChange={(next) => {
          if (!next) setDoomed(null);
        }}
        title="Delete snapshot"
        body={
          doomed === null
            ? ""
            : `Deleting ${doomed.filename} from disk. Download it first if it is the copy you would go back to; there is no other one of it.`
        }
        confirmLabel="Delete snapshot"
        busy={remove.isPending}
        onConfirm={() => {
          if (doomed === null) return;
          remove.mutate(doomed.id, { onSettled: () => setDoomed(null) });
        }}
      />

      <Confirm
        open={importing}
        onOpenChange={setImporting}
        title="Import database"
        body={
          incoming === null
            ? ""
            : `Replacing the live database with ${incoming.name}. It is validated before anything is touched, and a copy of the current database is taken first. If the file carries a different admin password, every session ends and you will be asked to sign in again.`
        }
        confirmLabel="Replace database"
        busy={importDatabase.isPending}
        onConfirm={() => {
          if (incoming === null) return;
          importDatabase.mutate(incoming, {
            onSuccess: applyRestore,
            onSettled: () => setImporting(false),
          });
        }}
      />
    </Module>
  );
}
