import { Link } from "@tanstack/react-router";
import styled from "styled-components";
import type { RequestLog, VirtualModel } from "../../api/types.ts";
import { formatCount, formatUsd } from "../../lib/format.ts";
import { Button } from "../../ui/Button.tsx";
import { Chip } from "../../ui/Chip.tsx";
import { Module } from "../../ui/Panel.tsx";
import { Legend, Mono, Row, Spacer, Truncate } from "../../ui/primitives.ts";
import { Empty } from "../../ui/States.tsx";

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: ${({ theme }) => theme.space(3)};
`;

const Name = styled(Truncate)`
  font-family: ${({ theme }) => theme.font.mono};
  font-size: 12.5px;
`;

/**
 * A share bar built from the target mix, so the segment colours say which
 * providers a model can reach, and the bar length says how much traffic it took.
 */
const ShareTrack = styled.div`
  display: flex;
  height: 5px;
  border-radius: 2px;
  overflow: hidden;
  background: ${({ theme }) => theme.color.panelSunk};
  border: 1px solid ${({ theme }) => theme.color.rule};
`;

const Segment = styled.div<{ $color: string; $grow: number }>`
  flex: ${({ $grow }) => $grow} 0 0;
  background: ${({ $color }) => $color};
  opacity: 0.8;
`;

const Rest = styled.div<{ $grow: number }>`
  flex: ${({ $grow }) => $grow} 0 0;
`;

export type ModelTrafficProps = {
  models: readonly VirtualModel[];
  logs: readonly RequestLog[];
};

/**
 * Traffic is counted from the log's `requestedModel`, not from `/api/usage`.
 * That endpoint groups by the *resolved* provider model, which cannot be joined
 * back to a virtual model id once a model fans out across providers.
 */
export function ModelTraffic({ models, logs }: ModelTrafficProps) {
  const byModel = new Map<string, { requests: number; costUsd: number }>();
  for (const log of logs) {
    const seen = byModel.get(log.requestedModel) ?? { requests: 0, costUsd: 0 };
    seen.requests += 1;
    seen.costUsd += log.costUsd;
    byModel.set(log.requestedModel, seen);
  }
  const busiest = Math.max(1, ...[...byModel.values()].map((row) => row.requests));

  const rows = [...models]
    .map((model) => ({ model, used: byModel.get(model.id) }))
    .sort((a, b) => (b.used?.requests ?? 0) - (a.used?.requests ?? 0))
    .slice(0, 8);

  return (
    <Module
      legend="Models"
      meta={`${models.length} configured`}
      actions={
        <Button as={Link} to="/models" $size="sm">
          Edit routing
        </Button>
      }
    >
      {models.length === 0 ? (
        <Empty
          legend="No models"
          message="Nothing is routable yet. Create a virtual model and point it at one or more provider targets."
          action={
            <Button as={Link} to="/models" $variant="primary" $size="sm">
              Create a model
            </Button>
          }
        />
      ) : (
        <List>
          {rows.map(({ model, used }) => {
            const share = (used?.requests ?? 0) / busiest;
            const providers = [...new Set(model.targets.map((target) => target.provider))];
            return (
              <li key={model.id}>
                <Row $gap={2}>
                  <Name title={model.id}>{model.id}</Name>
                  {model.isAlias ? <Chip>alias</Chip> : null}
                  <Chip $tone="accent">{model.strategy}</Chip>
                  <Spacer />
                  <Mono $dim>{formatCount(used?.requests ?? 0)}</Mono>
                  <Legend>req</Legend>
                  <Mono $dim>{formatUsd(used?.costUsd ?? 0)}</Mono>
                </Row>
                <ShareTrack
                  style={{ marginTop: 6 }}
                  title={`${Math.round(share * 100)}% of the busiest model`}
                >
                  {providers.map((provider) => (
                    <Segment
                      key={provider}
                      $color={`var(--p-${provider})`}
                      $grow={share / providers.length}
                    />
                  ))}
                  <Rest $grow={Math.max(0, 1 - share)} />
                </ShareTrack>
              </li>
            );
          })}
        </List>
      )}
    </Module>
  );
}
