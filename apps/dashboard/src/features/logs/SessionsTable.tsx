import type { SessionSummary } from "../../api/types.ts";
import { formatClock, formatCount, formatDateTime, formatUsd, shortId } from "../../lib/format.ts";
import { Legend, Truncate } from "../../ui/primitives.ts";
import { Table, Td, Th, Tr } from "../../ui/Table.tsx";

export type SessionsTableProps = {
  sessions: readonly SessionSummary[];
  /** Key labels by id, on the operator's board; absent on the client's. */
  keyLabels?: ReadonlyMap<string, string>;
  /** Opens the request log filtered to this session (and its key). */
  onOpen: (session: SessionSummary) => void;
};

/**
 * One row per `(api key, session)`, highest cost first — the order the gateway
 * returns them in. A row opens the request log narrowed to that session.
 */
export function SessionsTable({ sessions, keyLabels, onOpen }: SessionsTableProps) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Session</Th>
          <Th>Agent</Th>
          {keyLabels === undefined ? null : <Th>Key</Th>}
          <Th $align="right">Last</Th>
          <Th $align="right">Requests</Th>
          <Th $align="right">Turns</Th>
          <Th $align="right">Failed</Th>
          <Th $align="right">Tokens</Th>
          <Th $align="right">Cost</Th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <Tr
            key={`${session.apiKeyId ?? ""}\u0000${session.sessionId}`}
            $selectable
            onClick={() => onOpen(session)}
          >
            <Td $mono>
              <Truncate style={{ display: "block", maxWidth: "32ch" }} title={session.sessionId}>
                {session.sessionId}
              </Truncate>
            </Td>
            <Td>{session.agent ?? <Legend>—</Legend>}</Td>
            {keyLabels === undefined ? null : (
              <Td>
                {session.apiKeyId === null
                  ? "—"
                  : (keyLabels.get(session.apiKeyId) ?? shortId(session.apiKeyId))}
              </Td>
            )}
            <Td $align="right" $mono title={formatDateTime(session.lastAt)}>
              {formatClock(session.lastAt)}
            </Td>
            <Td $align="right" $mono>
              {formatCount(session.requests)}
            </Td>
            <Td $align="right" $mono>
              {formatCount(session.turns)}
            </Td>
            <Td $align="right" $mono>
              {formatCount(session.failed)}
            </Td>
            <Td $align="right" $mono>
              {`${formatCount(session.inputTokens)}+${formatCount(session.outputTokens)}`}
            </Td>
            <Td $align="right" $mono>
              {formatUsd(session.costUsd)}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
