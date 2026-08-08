import { Link } from "@tanstack/react-router";
import styled from "styled-components";
import type { RequestLog } from "../../api/types.ts";
import { formatClock, formatMs, formatUsd } from "../../lib/format.ts";
import { isError } from "../../lib/vitals.ts";
import { Button } from "../../ui/Button.tsx";
import { Lamp } from "../../ui/Lamp.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Mono, Spacer, Truncate } from "../../ui/primitives.ts";
import { Empty } from "../../ui/States.tsx";

const List = styled.ul`
  display: flex;
  flex-direction: column;
`;

const Entry = styled.li`
  display: flex;
  align-items: center;
  gap: ${({ theme }) => theme.space(2)};
  padding: 6px ${({ theme }) => theme.space(3)};
  border-bottom: 1px solid ${({ theme }) => theme.color.rule};

  &:last-child {
    border-bottom: 0;
  }
`;

const Model = styled(Truncate)`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12px;
  max-width: 30ch;
`;

const Fault = styled(Mono)`
  color: ${({ theme }) => theme.color.down};
  font-size: 11px;
`;

export function ActivityTail({ logs }: { logs: readonly RequestLog[] }) {
  const recent = logs.slice(0, 12);

  return (
    <Module
      legend="Activity"
      meta="most recent first"
      flush
      actions={
        <Button as={Link} to="/logs" $size="sm">
          Open logs
        </Button>
      }
    >
      {recent.length === 0 ? (
        <Empty
          legend="No traffic yet"
          message="Point a client at this gateway with an API key and the requests will appear here."
        />
      ) : (
        <List>
          {recent.map((log) => (
            <Entry key={log.id}>
              <Lamp
                state={isError(log) ? "down" : "ok"}
                label={isError(log) ? `failed with ${log.status}` : "succeeded"}
              />
              <Mono $dim>{formatClock(log.at)}</Mono>
              <Model title={log.requestedModel}>{log.requestedModel || "—"}</Model>
              {log.resolvedProvider === null ? null : (
                <Mono $dim style={{ color: `var(--p-${log.resolvedProvider})` }}>
                  {log.resolvedProvider}
                </Mono>
              )}
              <Spacer />
              {log.errorCode === null ? null : <Fault>{log.errorCode}</Fault>}
              {log.attempts > 1 ? <Mono $dim>{log.attempts}×</Mono> : null}
              <Mono $dim>{formatMs(log.durationMs)}</Mono>
              <Mono $dim>{formatUsd(log.costUsd)}</Mono>
            </Entry>
          ))}
        </List>
      )}
    </Module>
  );
}
